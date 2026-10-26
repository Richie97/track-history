// The lap stage (NS-51, docs/specs/native/NS-51-video-synced-laps.md): the
// DOM half of video-synced lap analysis, web-only and never ported — the
// phones draw their own over the same pure half, js/video-sync.js.
//
// A stage is up to two sides (A, the lap it was opened for; B, a second lap
// with its own slot, or a slotless reference lap the delta is measured
// against), one transport and a now-strip. It owns up to two <video>s with no
// native controls — its own transport drives them — and one clock: the master
// video's time, or a timer when the master has no playable video (replay).
// Every frame it works out the playhead with playheadAt, keeps the follower in
// step, redraws its own transport, now-strip and map, and hands the state to
// the caller's `onFrame`, which marks the charts (showPlayhead in
// channel-graphs.js). Nothing here re-renders a chart.
//
// Layout follows the stage's own width (the pane rule — never the window's):
// Wide ≥ 1000 px, Medium ≥ 600, else Compact. A phone held sideways with a
// video loaded goes full-bleed, as does the fullscreen button.

import { esc, fmtMs } from "./format.js";
import { renderTrackMap } from "./trackmap.js";
import { fmtSpeedKph, convSpeedKph, currentUnits, speedUnit } from "./units.js";
import { ordinal } from "./gears.js";
import { PLAYBACK_LEAD_S } from "./import/clip.js";
import {
  DEFAULT_SYNC_MODE,
  SYNC_MODES,
  cornerStops,
  fmtStageTime,
  followRate,
  makeSide,
  matchByFraction,
  needsResync,
  playheadAt,
  playheadText,
  scrubRange,
  valueAt,
} from "./video-sync.js";

export const VIDEO_NEEDS_CONNECTION = "Playing a lap video needs a connection.";

// ---------- the sync-mode preference -----------------------------------------
// Remembered per device, like the theme override: the last mode picked is the
// next compare's. Unknown or unreadable values fall back to the default.
const SYNC_KEY = "th-sync-mode";
export function currentSyncMode() {
  try {
    const m = localStorage.getItem(SYNC_KEY);
    if (SYNC_MODES.includes(m)) return m;
  } catch {}
  return DEFAULT_SYNC_MODE;
}
export function setSyncMode(mode) {
  if (!SYNC_MODES.includes(mode)) return;
  try {
    localStorage.setItem(SYNC_KEY, mode);
  } catch {}
}

// Layout thresholds on the stage's own width.
export const STAGE_WIDE_MIN = 1000;
export const STAGE_MEDIUM_MIN = 600;
export const stageLayout = (width) => (width >= STAGE_WIDE_MIN ? "wide" : width >= STAGE_MEDIUM_MIN ? "medium" : "compact");
// Scrolled this far past a compact stage, its transport becomes a mini bar.
const MINI_AFTER_PX = 120;
const FRAME_S = 1 / 30;
const RATES = [0.25, 0.5, 1];
const LANDSCAPE_PHONE = "(orientation: landscape) and (max-height: 500px)";

// The stage the keyboard drives: the one last bound or touched, while it is
// still in the document.
let current = null;
// Every live stage, so a view that re-renders the page can stop the old ones'
// videos, listeners and observers in one call.
const live = new Set();
export function destroyAllStages() {
  for (const s of [...live]) s.destroy();
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Bind a stage into `container` (its contents are replaced). Options:
//   a, b — { entry, dStepM, clip: { id, lapOffsetMs, durationMs } | null,
//            label, best, color } with color a CSS custom property name;
//            b null for a one-sided stage
//   reference — { entry, dStepM, label } | null: a single lap's delta target,
//            drawn in no slot
//   canPlay — whether the account may play a lap video (canSaveLapVideo)
//   lockedHtml — said once when a side has a clip the account can't play
//   clipUrl(id) → Promise<{ url }>, describeError(err) → words
//   trace — the best-lap polyline the map dots run on, or null
//   corners — sessionCorners on A's grid; units
//   startK — where the playhead opens (A's grid); else startE (the master's
//            elapsed seconds); otherwise the run-up. startPlaying carries on
//            playing from there — a stage rebuilt because its sides changed
//   onFrame(state, sides) — the caller marks its charts; state null removes it
//   stepper — { prev, next } labels or null, with onStep(dir)
//   onClose — a Hide control when given
// Returns { seekGrid(k, opts), k(), destroy() }.
export function bindLapStage(container, opts) {
  const units = opts.units ?? currentUnits();
  const sideA = makeSide("A", opts.a.entry, opts.a.dStepM, clipOf(opts.a));
  const bSpec = opts.b ?? opts.reference ?? null;
  const sideB = bSpec ? makeSide("B", bSpec.entry, bSpec.dStepM, opts.b ? clipOf(opts.b) : null) : null;
  if (!sideA) {
    container.innerHTML = "";
    return null;
  }
  const sides = { a: sideA, b: sideB };
  const specs = { A: opts.a, B: opts.b ?? null };
  const compare = !!(opts.b && sideB);
  const playable = (key) => !!(opts.canPlay && specs[key]?.clip);
  const st = {
    masterKey: !playable("A") && playable("B") ? "B" : "A",
    mode: compare ? currentSyncMode() : DEFAULT_SYNC_MODE,
    playing: false,
    rate: 1,
    eM: 0,
    last: 0,
    fast: false,
    mini: false,
    full: false,
    lastFollowAt: 0,
    destroyed: false,
  };
  const master = () => (st.masterKey === "B" ? sideB : sideA);
  const range = () => scrubRange(master());
  st.eM = opts.startK != null ? eForAGrid(opts.startK) : opts.startE ?? -PLAYBACK_LEAD_S;
  const corners = opts.corners ?? [];

  // ----- markup -----
  const slotKeys = compare ? ["A", "B"] : ["A"];
  const anyPlayable = slotKeys.some(playable);
  // Two slots with no video between them make one map with two dots, not two
  // identical replays.
  const oneMap = compare && !anyPlayable;
  const locked = !opts.canPlay && slotKeys.some((k) => specs[k]?.clip);
  const chip = (key) => {
    const s = specs[key];
    return `<span class="stage-chip"><span class="dot" style="background:var(${s.color})"></span>${esc(s.label)}${s.best ? " ★" : ""}</span>`;
  };
  const slotHtml = (key) =>
    playable(key)
      ? `<div class="stage-slot" data-slot="${key}">
          <video playsinline preload="metadata"${key === st.masterKey ? "" : " muted"}></video>
          ${chip(key)}
          <span class="stage-slot-note" hidden></span>
        </div>`
      : `<div class="stage-slot replay" data-slot="${key}">
          ${opts.trace ? `<canvas class="trackmap stage-replay-map" aria-hidden="true"></canvas>` : ""}
          ${chip(key)}
          <span class="stage-slot-note">${esc(replayNote(key))}</span>
        </div>`;
  const replayNote = (key) =>
    specs[key]?.clip && opts.canPlay && !navigator.onLine ? VIDEO_NEEDS_CONNECTION : "No video · replaying telemetry";
  const modeHtml = compare
    ? `<div class="stage-mode seg" role="group" aria-label="Keep the laps together by">
        <button type="button" data-stage-mode="place" aria-pressed="${st.mode === "place"}">Same place</button>
        <button type="button" data-stage-mode="time" aria-pressed="${st.mode === "time"}">Same time</button>
      </div>`
    : "";
  const step = (to, dir) =>
    `<button class="btn small" type="button" data-stage-step="${dir}" ${to ? "" : "disabled"}>${
      dir < 0 ? `‹ ${to ? esc(to) : "Previous"}` : `${to ? esc(to) : "Next"} ›`
    }</button>`;
  const headHtml =
    opts.stepper || opts.onClose
      ? `<div class="stage-head">
          ${opts.stepper ? step(opts.stepper.prev, -1) : ""}
          <span class="grow"></span>
          ${opts.stepper ? step(opts.stepper.next, 1) : ""}
          ${opts.onClose ? `<button class="btn small ghost" type="button" data-stage-close>Hide</button>` : ""}
        </div>`
      : "";

  container.innerHTML = `${headHtml}
    <span class="stage-sentinel" aria-hidden="true"></span>
    <section class="lap-stage" aria-label="Lap playback">
      <button type="button" class="stage-back" data-stage-full hidden>‹ Back</button>
      <div class="stage-videos ${oneMap ? "one-map" : `n${slotKeys.length}`}">
        ${
          oneMap
            ? `<div class="stage-slot replay" data-slot="map">
                ${opts.trace ? `<canvas class="trackmap stage-replay-map" aria-hidden="true"></canvas>` : ""}
                <span class="stage-chips">${chip("A")}${chip("B")}</span>
                <span class="stage-slot-note">No video · replaying telemetry</span>
              </div>`
            : slotKeys.map(slotHtml).join("")
        }
      </div>
      <div class="stage-side">
        ${opts.trace ? `<div class="stage-map"><div class="stage-map-title">Where the car is</div><canvas class="trackmap" aria-hidden="true"></canvas></div>` : ""}
        <div class="stage-now">
          <div class="now-place"></div>
          <div class="now-main">
            <span class="now-speed mono"></span><span class="now-unit">${esc(speedUnit(units))}</span>
            <span class="now-gear"></span>
            ${compare ? `<span class="now-speed-b mono"></span>` : ""}
          </div>
          <div class="now-bars" aria-hidden="true">
            <span class="bar thr" title="Throttle"><i></i></span>
            <span class="bar brk" title="Brake"><i></i></span>
          </div>
          <div class="now-delta mono"></div>
        </div>
      </div>
      <div class="stage-transport-slot">
        <div class="stage-transport">
          <button type="button" class="stage-play" aria-label="Play">▶</button>
          <div class="stage-scrub" role="slider" tabindex="0" aria-label="Lap position"></div>
          <span class="stage-times mono"></span>
          ${modeHtml}
          <select class="stage-rate" aria-label="Playback speed">${RATES.map(
            (r) => `<option value="${r}"${r === 1 ? " selected" : ""}>${r}×</option>`
          ).join("")}</select>
          ${anyPlayable ? `<button type="button" class="btn small ghost stage-fs" data-stage-full aria-label="Full screen">⛶</button>` : ""}
        </div>
      </div>
      <div class="stage-live visually-hidden" aria-live="polite"></div>
    </section>
    ${locked ? `<div class="stage-notes">${opts.lockedHtml ?? ""}</div>` : ""}`;

  const root = container.querySelector(".lap-stage");
  const sentinel = container.querySelector(".stage-sentinel");
  const $ = (sel) => root.querySelector(sel);
  const transport = $(".stage-transport");
  const transportSlot = $(".stage-transport-slot");
  const playBtn = $(".stage-play");
  const scrub = $(".stage-scrub");
  const times = $(".stage-times");
  const liveRegion = $(".stage-live");
  const now = {
    place: $(".now-place"),
    speed: $(".now-speed"),
    speedB: $(".now-speed-b"),
    gear: $(".now-gear"),
    thr: $(".bar.thr i"),
    brk: $(".bar.brk i"),
    delta: $(".now-delta"),
  };

  // ----- videos -----
  const videos = {};
  for (const key of slotKeys) {
    const v = root.querySelector(`.stage-slot[data-slot="${key}"] video`);
    if (!v) continue;
    videos[key] = { el: v, ready: false, refetchedAt: 0 };
    loadVideo(key);
  }
  async function loadVideo(key) {
    const vid = videos[key];
    const note = root.querySelector(`.stage-slot[data-slot="${key}"] .stage-slot-note`);
    try {
      const signed = await opts.clipUrl(specs[key].clip.id);
      if (st.destroyed) return;
      vid.el.src = signed.url;
      note.hidden = true;
    } catch (err) {
      if (st.destroyed) return;
      dropVideo(key, opts.describeError ? opts.describeError(err) : VIDEO_NEEDS_CONNECTION);
    }
  }
  // A side whose video can't play turns to replay in place; the playhead stays.
  function dropVideo(key, words) {
    const vid = videos[key];
    if (!vid) return;
    vid.el.removeAttribute("src");
    vid.el.load?.();
    delete videos[key];
    const slot = root.querySelector(`.stage-slot[data-slot="${key}"]`);
    slot.classList.add("replay");
    vid.el.remove();
    if (opts.trace) {
      const c = document.createElement("canvas");
      c.className = "trackmap stage-replay-map";
      c.setAttribute("aria-hidden", "true");
      slot.prepend(c);
      const h = renderTrackMap(c, opts.trace);
      if (h) maps.push(h);
    }
    const note = slot.querySelector(".stage-slot-note");
    note.textContent = words;
    note.hidden = false;
    if (key === st.masterKey && !videos[otherKey()]) st.masterKey = "A";
    paint();
  }
  for (const [key, vid] of Object.entries(videos)) {
    vid.el.addEventListener("loadedmetadata", () => {
      vid.ready = true;
      syncVideos(true);
    });
    // A signed URL lasts an hour: on a load error, ask for a fresh one once a
    // few minutes and put the playhead back where it was.
    vid.el.addEventListener("error", () => {
      if (!navigator.onLine) return dropVideo(key, VIDEO_NEEDS_CONNECTION);
      if (Date.now() - vid.refetchedAt < 5 * 60_000) return dropVideo(key, "This video couldn't be played.");
      vid.refetchedAt = Date.now();
      vid.ready = false;
      loadVideo(key);
    });
  }
  const otherKey = () => (st.masterKey === "A" ? "B" : "A");

  // ----- maps -----
  const maps = [];
  if (opts.trace) {
    root.querySelectorAll("canvas.trackmap").forEach((c) => {
      const h = renderTrackMap(c, opts.trace);
      if (h) maps.push(h);
    });
  }

  // ----- the scrubber's track: the delta (or A's speed), corners, sectors -----
  function drawScrubTrack() {
    const m = master();
    const { min, max } = range();
    const X = (e) => (((e - min) / (max - min)) * 1000).toFixed(1);
    const nA = sideA.t.length;
    let path = "";
    if (sideB) {
      const byF = matchByFraction(sideA, sideB);
      const nB = sideB.t.length;
      const pts = [];
      let peak = 0;
      for (let k = 0; k < nA; k++) {
        const kB = byF ? (k * (nB - 1)) / (nA - 1) : Math.min(k, nB - 1);
        const eB = valueAt(sideB.t, kB);
        const d = sideA.t[k] - eB;
        peak = Math.max(peak, Math.abs(d));
        pts.push([m === sideA ? sideA.t[k] : eB, d]);
      }
      const s = peak > 0 ? 14 / peak : 0;
      path = `<path d="${pts.map(([e, d], i) => `${i ? "L" : "M"}${X(e)},${(20 - d * s).toFixed(1)}`).join("")}" class="scrub-delta"/>`;
    } else {
      const sp = sideA.entry.speed;
      const top = Math.max(...sp), bot = Math.min(...sp);
      path = `<path d="${sp.map((v, k) => `${k ? "L" : "M"}${X(sideA.t[k])},${(34 - ((v - bot) / (top - bot || 1)) * 28).toFixed(1)}`).join("")}" class="scrub-speed"/>`;
    }
    const ticks = stops()
      .map((c) => `<line x1="${X(c.e)}" x2="${X(c.e)}" y1="34" y2="40" class="scrub-corner"/>`)
      .join("");
    const sectors = [1, 2]
      .map((i) => X(valueAt(m.t, (i * (m.t.length - 1)) / 3)))
      .map((x) => `<line x1="${x}" x2="${x}" y1="30" y2="40" class="scrub-sector"/>`)
      .join("");
    scrub.innerHTML = `<svg viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" x2="1000" y1="20" y2="20" class="scrub-zero"/>
        <line x1="${X(0)}" x2="${X(0)}" y1="0" y2="40" class="scrub-line"/>
        ${path}${ticks}${sectors}
      </svg><span class="scrub-fill"></span><span class="scrub-thumb"></span>`;
    scrub.setAttribute("aria-valuemin", String(min.toFixed(1)));
    scrub.setAttribute("aria-valuemax", String(max.toFixed(1)));
  }
  // The corners as stops on the master's clock.
  function stops() {
    if (master() === sideA) return cornerStops(corners, sideA.t);
    return corners.map((c) => ({ label: `T${c.n}`, e: playheadAt(sides, "A", valueAt(sideA.t, c.k0), "place").b.e }));
  }

  // ----- clock -----
  function eForAGrid(k) {
    const eA = valueAt(sideA.t, k);
    return st.masterKey === "A" || !sideB ? eA : playheadAt(sides, "A", eA, "place").b.e;
  }
  let frame = 0;
  function loop() {
    frame = 0;
    if (st.destroyed || !root.isConnected) return destroy();
    if (!st.playing) return;
    const t = performance.now();
    const dt = (t - st.last) / 1000;
    st.last = t;
    const mv = videos[st.masterKey];
    const ms = master();
    const mClip = ms.clip ? (st.eM * 1000 + ms.clip.lapOffsetMs) : null;
    const inMasterClip = mv?.ready && mClip != null && mClip >= 0 && (!ms.clip.durationMs || mClip <= ms.clip.durationMs);
    if (inMasterClip && !mv.el.paused && !mv.el.seeking) st.eM = (mv.el.currentTime * 1000 - ms.clip.lapOffsetMs) / 1000;
    else st.eM += dt * st.rate;
    if (st.eM >= range().max) {
      st.eM = range().max;
      pause();
      return;
    }
    paint();
    frame = requestAnimationFrame(loop);
  }
  function play() {
    if (st.playing) return;
    if (st.eM >= range().max - 0.05) st.eM = range().min;
    st.playing = true;
    st.last = performance.now();
    playBtn.textContent = "❚❚";
    playBtn.setAttribute("aria-label", "Pause");
    syncVideos(true);
    frame = requestAnimationFrame(loop);
  }
  function pause() {
    st.playing = false;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    for (const v of Object.values(videos)) if (!v.el.paused) v.el.pause();
    playBtn.textContent = "▶";
    playBtn.setAttribute("aria-label", "Play");
    paint();
    announce();
  }
  function seekE(e, { final = true, pauseFirst = false } = {}) {
    if (pauseFirst && st.playing) pause();
    const { min, max } = range();
    st.eM = clamp(e, min, max);
    st.fast = !final;
    syncVideos(true);
    paint();
    if (final) announce();
  }

  // Keep each video where the playhead says. While playing, the master runs
  // free (it is the clock) and the follower is rated and re-seeked; while
  // paused, both are seeked to the frame — a fast (keyframe) seek while a
  // finger or mouse is still dragging, an exact one on release.
  let state = null;
  function syncVideos(force = false) {
    state = playheadAt(sides, st.masterKey, st.eM, st.mode);
    const nowMs = performance.now();
    for (const key of Object.keys(videos)) {
      const vid = videos[key];
      if (!vid.ready) continue;
      const v = vid.el;
      const s = key === "A" ? state.a : state.b;
      const isMaster = key === st.masterKey;
      if (!s?.inClip) {
        if (!v.paused) v.pause();
        continue;
      }
      const target = s.clipMs / 1000;
      if (st.playing) {
        let r = st.rate;
        if (!isMaster && st.mode === "place") {
          if (nowMs - st.lastFollowAt < 250 && !force) r = v.playbackRate;
          else {
            st.lastFollowAt = nowMs;
            r = followRate(sides, st.masterKey, (st.masterKey === "A" ? state.a : state.b).k) * st.rate;
          }
        }
        if (Math.abs(v.playbackRate - r) > 0.01) v.playbackRate = r;
        if (v.paused) {
          v.currentTime = target;
          v.play().catch(() => {});
        } else if (!isMaster && needsResync(s.clipMs, v.currentTime * 1000)) v.currentTime = target;
      } else if (force || Math.abs(v.currentTime - target) > FRAME_S / 2) {
        if (st.fast && typeof v.fastSeek === "function") v.fastSeek(target);
        else v.currentTime = target;
      }
    }
  }

  // ----- painting -----
  function paint() {
    if (st.playing) syncVideos();
    else state = playheadAt(sides, st.masterKey, st.eM, st.mode);
    const s = state;
    const { min, max } = range();
    const frac = (st.eM - min) / (max - min);
    scrub.style.setProperty("--pos", `${(clamp(frac, 0, 1) * 100).toFixed(2)}%`);
    const text = playheadText(s, corners, units);
    scrub.setAttribute("aria-valuenow", st.eM.toFixed(1));
    scrub.setAttribute("aria-valuetext", text.value);
    times.textContent = `${fmtStageTime(st.eM)} / ${fmtStageTime(range().max - PLAYBACK_LEAD_S)}`;
    now.place.textContent = text.place;
    const a = s.a;
    now.speed.textContent = s.inLap && a.now.speedKph != null ? convSpeedKph(a.now.speedKph, units).toFixed(0) : "—";
    now.gear.textContent = s.inLap && a.now.gear ? ordinal(a.now.gear) : "";
    if (now.speedB) now.speedB.textContent = s.inLap && s.b?.now.speedKph != null ? `B ${fmtSpeedKph(s.b.now.speedKph, units)}` : "";
    now.thr.style.height = `${s.inLap ? clamp(a.now.throttle ?? 0, 0, 100) : 0}%`;
    now.brk.style.height = `${s.inLap ? clamp(a.now.brake ?? 0, 0, 100) : 0}%`;
    const vs = compare ? "vs B" : opts.reference ? `vs ${opts.reference.label}` : "";
    now.delta.textContent = text.delta ? (s.mode === "time" ? text.delta : `${text.delta} ${vs}`) : "";
    now.delta.classList.toggle("slower", s.mode === "place" && s.deltaS > 0.005);
    now.delta.classList.toggle("faster", s.mode === "place" && s.deltaS < -0.005);
    const dots =
      s.inLap
        ? [
            { k: s.a.k, n: sideA.t.length, color: opts.a.color },
            ...(compare && s.b?.inLap ? [{ k: s.b.k, n: sideB.t.length, color: opts.b.color }] : []),
          ].map((d) => ({ frac: d.k / Math.max(1, d.n - 1), color: d.color }))
        : null;
    for (const m of maps) m.setPlayhead(dots);
    opts.onFrame?.(s.inLap ? s : null, sides);
  }
  function announce() {
    if (!state) return;
    liveRegion.textContent = playheadText(state, corners, units).place;
  }

  // ----- controls -----
  playBtn.onclick = () => (st.playing ? pause() : play());
  root.querySelector(".stage-rate").onchange = (evt) => {
    st.rate = Number(evt.target.value) || 1;
    for (const [key, v] of Object.entries(videos)) if (key === st.masterKey) v.el.playbackRate = st.rate;
    syncVideos(true);
  };
  root.querySelectorAll("[data-stage-mode]").forEach((btn) => {
    btn.onclick = () => setMode(btn.dataset.stageMode);
  });
  function setMode(mode) {
    if (!compare || !SYNC_MODES.includes(mode)) return;
    st.mode = mode;
    setSyncMode(mode);
    root.querySelectorAll("[data-stage-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.stageMode === mode)));
    syncVideos(true);
    paint();
  }
  // The scrubber: drag to seek (fast while moving, exact on release), and as a
  // slider ↑ / ↓ step corner to corner, Home / End to the run-up and roll-out.
  let dragging = false;
  const eAtX = (clientX) => {
    const r = scrub.getBoundingClientRect();
    const { min, max } = range();
    return min + clamp((clientX - r.left) / r.width, 0, 1) * (max - min);
  };
  scrub.addEventListener("pointerdown", (evt) => {
    dragging = true;
    scrub.setPointerCapture?.(evt.pointerId);
    current = api;
    seekE(eAtX(evt.clientX), { final: false });
  });
  scrub.addEventListener("pointermove", (evt) => {
    if (dragging) seekE(eAtX(evt.clientX), { final: false });
  });
  const endDrag = (evt) => {
    if (!dragging) return;
    dragging = false;
    seekE(eAtX(evt.clientX), { final: true });
  };
  scrub.addEventListener("pointerup", endDrag);
  scrub.addEventListener("pointercancel", () => (dragging = false));
  scrub.addEventListener("keydown", (evt) => {
    const list = stops();
    let to = null;
    if (evt.key === "ArrowUp") to = list.find((c) => c.e > st.eM + 0.05)?.e ?? null;
    else if (evt.key === "ArrowDown") to = [...list].reverse().find((c) => c.e < st.eM - 0.05)?.e ?? null;
    else if (evt.key === "Home") to = range().min;
    else if (evt.key === "End") to = range().max;
    else return;
    evt.preventDefault();
    evt.stopPropagation();
    if (to != null) seekE(to);
  });
  // A tap on the compact layout's inset swaps which lap is large — and heard.
  root.querySelector(".stage-videos").addEventListener("click", (evt) => {
    const slot = evt.target.closest(".stage-slot[data-slot]");
    if (!compare || !slot || slot.dataset.slot === st.masterKey || !root.classList.contains("stage-compact")) return;
    swap();
  });
  function swap() {
    st.masterKey = otherKey();
    paintMaster();
    drawScrubTrack();
    syncVideos(true);
    paint();
  }
  function paintMaster() {
    root.querySelectorAll(".stage-slot[data-slot]").forEach((el) => {
      const isM = el.dataset.slot === st.masterKey;
      el.classList.toggle("master", isM);
      el.toggleAttribute("aria-hidden", false);
      if (compare && !isM) el.setAttribute("aria-label", "Swap the two laps");
    });
    for (const [key, v] of Object.entries(videos)) v.el.muted = key !== st.masterKey;
  }
  container.querySelectorAll("[data-stage-step]").forEach((btn) => {
    btn.onclick = () => opts.stepper?.onStep(Number(btn.dataset.stageStep));
  });
  container.querySelector("[data-stage-close]")?.addEventListener("click", () => opts.onClose?.());
  root.addEventListener("pointerdown", () => (current = api));
  root.addEventListener("focusin", () => (current = api));

  // ----- full-bleed -----
  root.querySelectorAll("[data-stage-full]").forEach((b) => (b.onclick = () => setFull(!st.full, true)));
  function setFull(on, fromButton = false) {
    if (on === st.full || (on && !Object.keys(videos).length)) return;
    st.full = on;
    if (on) setMini(false);
    root.classList.toggle("stage-fullbleed", on);
    if (!on) relayout();
    root.querySelector(".stage-back").hidden = !on;
    document.documentElement.classList.toggle("stage-fullbleed-open", on);
    if (on && fromButton) root.requestFullscreen?.().catch(() => {});
    if (!on && document.fullscreenElement === root) document.exitFullscreen?.().catch(() => {});
  }
  const landscape = matchMedia(LANDSCAPE_PHONE);
  const onLandscape = () => setFull(landscape.matches && Object.keys(videos).length > 0);
  landscape.addEventListener?.("change", onLandscape);
  const onFsChange = () => {
    if (!document.fullscreenElement && st.full && !landscape.matches) setFull(false);
  };
  document.addEventListener("fullscreenchange", onFsChange);

  // ----- layout: the stage's own width, a pinned stage, the mini bar -----
  const topbarH = () => document.querySelector("header.topbar")?.offsetHeight ?? 0;
  function relayout() {
    if (st.full) return;
    const kind = stageLayout(root.getBoundingClientRect().width);
    for (const k of ["wide", "medium", "compact"]) root.classList.toggle(`stage-${k}`, k === kind);
    // Medium pins only its transport: the stage sticks with its top above
    // the window by everything over the transport row.
    const above = kind === "medium" ? transportSlot.offsetTop : 0;
    root.style.setProperty("--stage-top", `${topbarH() - above}px`);
  }
  const ro = new ResizeObserver(relayout);
  ro.observe(root);
  // Compact: once the page has scrolled MINI_AFTER_PX past the stage, its
  // transport rides in a bar pinned under the header — a tap on the bar's
  // edge scrolls back. The slot keeps the transport's height, so nothing
  // under the stage moves when it goes.
  function onScroll() {
    if (!root.classList.contains("stage-compact") || st.full) return setMini(false);
    const past = topbarH() - sentinel.getBoundingClientRect().top;
    const bottom = root.getBoundingClientRect().bottom;
    setMini(past > MINI_AFTER_PX && bottom < topbarH() + 40 + transport.offsetHeight);
  }
  let scrollQueued = false;
  const scrollListener = () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      if (!root.isConnected) destroy();
      else if (!st.destroyed) onScroll();
    });
  };
  window.addEventListener("scroll", scrollListener, { passive: true });
  function setMini(on) {
    if (on === st.mini) return;
    st.mini = on;
    if (on) {
      transportSlot.style.height = `${transportSlot.offsetHeight}px`;
      transport.classList.add("stage-mini");
      transport.style.top = `${topbarH()}px`;
    } else {
      transport.classList.remove("stage-mini");
      transport.style.top = "";
      transportSlot.style.height = "";
    }
  }
  transport.addEventListener("click", (evt) => {
    if (st.mini && evt.target === transport) sentinel.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });

  function destroy() {
    if (st.destroyed) return;
    st.destroyed = true;
    if (frame) cancelAnimationFrame(frame);
    for (const v of Object.values(videos)) {
      v.el.pause();
      v.el.removeAttribute("src");
    }
    ro.disconnect();
    window.removeEventListener("scroll", scrollListener);
    landscape.removeEventListener?.("change", onLandscape);
    document.removeEventListener("fullscreenchange", onFsChange);
    document.documentElement.classList.remove("stage-fullbleed-open");
    if (current === api) current = null;
    live.delete(api);
    opts.onFrame?.(null, sides);
  }

  const api = {
    // Seek to k on A's grid — a chart tap pauses and parks there.
    seekGrid(k, { final = true, pause: pauseFirst = true } = {}) {
      seekE(eForAGrid(k), { final, pauseFirst });
    },
    k: () => state?.a.k ?? null,
    e: () => st.eM,
    inLap: () => !!state?.inLap,
    playing: () => st.playing,
    toggle: () => (st.playing ? pause() : play()),
    stepSeconds: (s) => seekE(st.eM + s),
    stepGrid: (dk) => api.seekGrid((state?.a.k ?? 0) + dk, { pause: false }),
    stepFrame: (dir) => {
      if (!st.playing) seekE(st.eM + dir * FRAME_S);
    },
    toggleMode: () => setMode(st.mode === "place" ? "time" : "place"),
    toggleFull: () => setFull(!st.full, true),
    isConnected: () => root.isConnected,
    // A side's video gone (deleted from under it): replay in place.
    drop: (key, words) => dropVideo(key, words),
    destroy,
  };
  live.add(api);

  paintMaster();
  drawScrubTrack();
  relayout();
  syncVideos(true);
  paint();
  current = api;
  if (opts.startPlaying) play();
  return api;
}

function clipOf(spec) {
  const c = spec?.clip;
  return c ? { lapOffsetMs: c.lapOffsetMs, durationMs: c.durationMs } : null;
}

// The keyboard, bound once (the wrapped-story.js pattern) and acting on the
// current stage: Space play/pause, ← / → a second, ⌥← / ⌥→ one grid point
// (20 m), , / . a frame while paused, S the sync mode, F full-bleed. Typing
// into a field, and Space on a focused button, keep their own meaning.
if (typeof document !== "undefined") {
  document.addEventListener("keydown", (evt) => {
    const s = current;
    if (!s || !s.isConnected() || evt.ctrlKey || evt.metaKey) return;
    const t = evt.target;
    if (t instanceof Element && t.closest("input, select, textarea, [contenteditable=''], [contenteditable='true']")) return;
    if (t instanceof Element && t.closest("[role=tab]") && (evt.key === "ArrowLeft" || evt.key === "ArrowRight")) return;
    const onButton = t instanceof Element && t.closest("button, a, summary");
    let handled = true;
    switch (evt.key) {
      case " ":
        if (onButton) return;
        s.toggle();
        break;
      case "ArrowLeft":
        evt.altKey ? s.stepGrid(-1) : s.stepSeconds(-1);
        break;
      case "ArrowRight":
        evt.altKey ? s.stepGrid(1) : s.stepSeconds(1);
        break;
      case ",":
        s.stepFrame(-1);
        break;
      case ".":
        s.stepFrame(1);
        break;
      case "s":
      case "S":
        s.toggleMode();
        break;
      case "f":
      case "F":
        s.toggleFull();
        break;
      default:
        handled = false;
    }
    if (handled) evt.preventDefault();
  });
}
