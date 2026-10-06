// The App Store app preview: 886×1920, 29.9 s, on the promo's seekable
// timeline (video/timeline.js). A caption band over one phone screen; each
// scene's screen is a clip of the native iOS app (frames extracted by
// render-preview.mjs into out/appstore/.frames/) or, when the clip hasn't been
// recorded yet, a draft stand-in built from the web app's phone captures —
// badged DRAFT, because Apple takes only captures of the app itself.

import { Timeline, clamp01, lerp } from "../video/timeline.js";
import { fmtMs } from "../../public/js/format.js";
import { DURATION, END, FPS, LEAD, SLOTS } from "./shots.mjs";

const data = await (await fetch("../out/data.json")).json();
const manifest = await fetch("../out/appstore/.frames/manifest.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
const q = new URLSearchParams(location.search);
// ?draft renders every scene from its stand-in, even where a clip exists.
const forceDraft = q.has("draft");
await Promise.all(["700 64px Geist", "600 46px Geist", "500 40px \"Geist Mono\""].map((f) => document.fonts.load(f)));

const SHOT = (n) => `../out/screens/${n}.png`;
const SCREEN = { w: 700, h: 1521 };
const K = SCREEN.w / 390; // CSS px of a phone capture → screen px
const VIEW_H = SCREEN.h / K - 54; // what a capture shows under the status bar
const tl = new Timeline();
const $screen = document.getElementById("screen");
const $caps = document.getElementById("caps");

function el(tag, attrs = {}, parent) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") Object.assign(e.style, v);
    else if (k === "html") e.innerHTML = v;
    else if (k === "text") e.textContent = v;
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  if (parent) parent.appendChild(e);
  return e;
}
const px = (v) => `${v}px`;

// "See where *the time went*" — *…* in lime, one span per word.
function words(parent, text, cls) {
  const h = el("div", { class: cls }, parent);
  const out = [];
  let accent = false;
  for (const line of text.split("/")) {
    const lineEl = el("div", {}, h);
    const toks = line.split(" ");
    toks.forEach((tok, i) => {
      let t = tok;
      if (t.startsWith("*")) { accent = true; t = t.slice(1); }
      let closes = false;
      if (t.endsWith("*")) { closes = true; t = t.slice(0, -1); }
      out.push(el("span", { class: `w${accent ? " accent" : ""}`, text: t + (i < toks.length - 1 ? " " : "") }, lineEl));
      if (closes) accent = false;
    });
  }
  return { el: h, words: out };
}
function rise(ws, t0, { each = 0.05, dur = 0.6, dy = 36, blur = 10 } = {}) {
  ws.forEach((w, i) => tl.to(w, { opacity: [0, 1], y: [dy, 0], blur: [blur, 0] }, t0 + i * each, dur, "outQuart"));
}

// Preload the stand-ins so a frame never paints half an image.
const IMG = {};
async function preload(names) {
  await Promise.all(names.map(async (n) => {
    const im = new Image();
    await new Promise((res, rej) => { im.onload = res; im.onerror = () => rej(new Error(`missing ${n} — run node capture.mjs`)); im.src = SHOT(n); });
    IMG[n] = { w: im.naturalWidth / 3, h: im.naturalHeight / 3 };
  }));
}
await preload(["m-event", "m-panel-time", "m-panel-grip", "m-track", "m-vehicle", "m-leaderboard"]);

// A stand-in page: 390 CSS px wide, a status bar, scaled to the screen.
function page390(slot) {
  const c = el("div", { class: "css390", style: { transform: `scale(${K})`, height: px(SCREEN.h / K) } }, slot);
  el("div", { class: "statusbar", html: `<span>9:41</span><span class="sb-icons"><i></i><i></i><b></b></span>` }, c);
  el("div", { class: "island" }, c);
  return c;
}
function capture(c, name, extra = {}) {
  return el("img", { class: "cap390", src: SHOT(name), style: extra }, c);
}
// Scroll a capture so CSS y `from` → `to` sits at the top of the view.
function scroll(img, from, to, t0, dur, easing = "inOutCubic") {
  const max = Math.max(0, IMG[img.dataset.name].h - VIEW_H);
  tl.to(img, { y: [-Math.min(from, max), -Math.min(to, max)] }, t0, dur, easing);
}

// --------------------------------------------------------------- stand-ins ---

const DRAFT = {
  // The native recorder, drawn: the lap that became the PB, mid-lap.
  record(slot, s) {
    const c = page390(slot);
    const laps = data.pbSessionLaps, pbMs = data.pb.ms, pbIdx = laps.indexOf(pbMs);
    const last = laps[pbIdx - 1], best = Math.min(...laps.slice(0, pbIdx));
    const target = (pbMs - best) / 1000;
    const lapStartS = 165 + laps.slice(0, pbIdx).reduce((a, b) => a + b, 0) / 1000;
    const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
    const evDate = new Date(`${data.pb.date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    el("div", {
      class: "rec",
      html: `
        <div class="bar"><span>‹ Event</span><span>Record laps</span><span style="width:52px"></span></div>
        <div class="tecard">
          <div class="eb" style="color:var(--lime)">Recording</div>
          <div class="hero" data-k="elapsed" style="font-size:62px;color:var(--text-strong);margin-top:12px">14:52</div>
          <div class="hero" data-k="delta" style="font-size:104px;color:var(--lime);margin-top:28px">−0.42</div>
          <div style="font-size:15px;color:var(--muted);margin-top:8px">ahead of your best lap</div>
          <div class="stats" style="margin-top:24px">
            <div><span class="eb">Lap</span><span class="v">${pbIdx + 1}</span></div>
            <div><span class="eb">Current</span><span class="v" data-k="cur">1:38</span></div>
            <div><span class="eb">Last</span><span class="v">${fmtMs(last)}</span></div>
            <div><span class="eb">Best</span><span class="v">${fmtMs(best)}</span></div>
          </div>
        </div>
        <div style="font-size:15px;color:var(--muted)">Attached to Circuit of the Americas · ${evDate}</div>
        <div class="tecard">
          <div class="stats">
            <div><span class="eb">Fixes</span><span class="v" data-k="fix">8,920</span></div>
            <div><span class="eb">Speed</span><span class="v" data-k="spd">146 mph</span></div>
            <div><span class="eb">Accuracy</span><span class="v">±10 ft</span></div>
          </div>
        </div>
        <div style="flex:1"></div>
        <div class="stop">Stop recording</div>`,
    }, c);
    const $ = (k) => c.querySelector(`[data-k="${k}"]`);
    // the speed at a point in the lap, from the PB trace
    const tr = data.pb.trace;
    const ts = [0];
    for (let i = 1; i < tr.length; i++) ts.push(ts[i - 1] + Math.hypot(tr[i][0] - tr[i - 1][0], tr[i][1] - tr[i - 1][1]) / Math.max(3, (tr[i][2] + tr[i - 1][2]) / 2));
    const T = ts[ts.length - 1];
    const speedAt = (sec) => {
      const t = (sec % T + T) % T;
      let i = 0;
      while (i < ts.length - 2 && ts[i + 1] < t) i++;
      return lerp(tr[i][2], tr[i + 1][2], clamp01((t - ts[i]) / (ts[i + 1] - ts[i] || 1)));
    };
    tl.call((p, t) => {
      const lapS = 96 + (t - s.t0);
      $("cur").textContent = mmss(lapS);
      $("elapsed").textContent = mmss(lapStartS + lapS);
      const d = target - 0.05 * Math.sin(t * 1.1) - 0.02 * Math.sin(t * 3.7);
      $("delta").textContent = `${d < 0 ? "−" : "+"}${Math.abs(d).toFixed(2)}`;
      $("fix").textContent = Math.round(lapStartS + lapS).toLocaleString("en-US");
      $("spd").textContent = `${Math.round(speedAt(lapS) * 2.236936)} mph`;
    }, s.t0 - LEAD, s.t1 - s.t0 + LEAD, "linear");
  },

  // The PB weekend's event page: the top, then down past the map to the sessions.
  event(slot, s) {
    const c = page390(slot);
    const im = capture(c, "m-event");
    im.dataset.name = "m-event";
    scroll(im, 0, 700, s.t0 + 0.9, 2.6);
  },

  // The PB session's lap panel: Time, then Grip.
  analysis(slot, s) {
    const c = page390(slot);
    const P = data.boxes;
    const mk = (name) => {
      const im = capture(c, name, { left: "28px", width: "334px" });
      im.dataset.name = name;
      return im;
    };
    const time = mk("m-panel-time"), grip = mk("m-panel-grip");
    const tTop = Math.max(0, (P.mPanel_time?.panelY ?? 668) - 300);
    scroll(time, 0, tTop, s.t0 + 0.4, 1.4);
    // Grip takes over with the same view, then scrolls to the friction circle.
    tl.to(grip, { y: [-tTop, -tTop], opacity: [0, 1] }, s.t0 + 2.9, 0.3, "linear");
    scroll(grip, tTop, (P.mPanel_grip?.panelY ?? 668) + 20, s.t0 + 3.4, 1.6);
  },

  // The track page: the best-lap chart, eased in on.
  progress(slot, s) {
    const c = page390(slot);
    const im = capture(c, "m-track");
    // the chart card sits ~180–330 CSS px down the page
    im.style.transformOrigin = "195px 250px";
    tl.to(im, { scale: [1, 1.1] }, s.t0 - LEAD, s.t1 - s.t0 + LEAD, "inOutQuad");
  },

  // The car: maintenance due, then down to the front pads' wear bar.
  garage(slot, s) {
    const c = page390(slot);
    const im = capture(c, "m-vehicle");
    im.dataset.name = "m-vehicle";
    scroll(im, 0, 1080, s.t0 + 1.2, 2.0);
  },

  leaderboard(slot, s) {
    const c = page390(slot);
    const im = capture(c, "m-leaderboard");
    im.style.transformOrigin = "195px 470px";
    tl.to(im, { scale: [1, 1.06] }, s.t0 - LEAD, s.t1 - s.t0 + LEAD, "inOutQuad");
  },
};

// ------------------------------------------------------------------ scenes ---

// Native clips: an <img> whose frame is picked per seek.
const clips = [];
let drafts = 0;
SLOTS.forEach((s, i) => {
  const slot = el("div", { class: "slot", style: { zIndex: String(i + 1) } }, $screen);
  const clip = !forceDraft && manifest[s.id];
  if (clip) {
    const im = el("img", { class: "clip" }, slot);
    // fill the screen's width; a taller device crops at the bottom
    im.style.height = px(SCREEN.w * clip.h / clip.w);
    clips.push({ slot: s, im, count: clip.count, src: "" });
  } else {
    DRAFT[s.id](slot, s);
    el("div", { class: "draft", text: "DRAFT · WEB STAND-IN" }, slot);
    drafts++;
  }
  // each scene's screen fades in over the one before
  const visible = [i === 0 ? 0 : s.t0 - LEAD, i === SLOTS.length - 1 ? END.t1 + 1 : SLOTS[i + 1].t1];
  tl.call((p, t) => { slot.style.display = t >= visible[0] && t < visible[1] ? "" : "none"; }, 0, DURATION);
  if (i > 0) tl.to(slot, { opacity: [0, 1] }, s.t0 - LEAD, LEAD, "linear");

  // the caption
  const cap = el("div", { class: "cap" }, $caps);
  const tag = el("span", { class: `tag${s.tag === "PRO" ? " pro" : ""}`, text: s.tag }, cap);
  const h = words(cap, s.caption, "h");
  // one line, shrunk to the band's width if it has to be
  const room = 790;
  if (h.el.scrollWidth > room) h.el.style.fontSize = px(Math.floor(64 * room / h.el.scrollWidth));
  tl.call((p, t) => { cap.style.display = t >= s.t0 - 0.05 && t < s.t1 ? "" : "none"; }, 0, DURATION);
  const in0 = s.t0 + (i === 0 ? 0.15 : 0.05);
  tl.to(tag, { opacity: [0, 1], y: [16, 0], blur: [6, 0] }, in0, 0.5, "outQuart");
  rise(h.words, in0 + 0.08);
  for (const x of [tag, h.el]) tl.to(x, { opacity: [1, 0], y: [0, -18], blur: [0, 8] }, s.t1 - 0.3, 0.28, "inCubic");
});
window.__drafts = drafts;

// The film opens on the first screen rising in, so the loop's seam is the
// background colour on both sides.
tl.to($screen, { opacity: [0, 1], y: [60, 0] }, 0, 0.55, "outQuart");

// Background glow drifts with the scenes.
tl.call((p) => {
  const g = document.getElementById("bg-glow");
  g.style.setProperty("--gx", `${lerp(75, 25, p)}%`);
  g.style.setProperty("--gy", `${6 + 4 * Math.sin(p * Math.PI * 4)}%`);
}, 0, DURATION);

// ------------------------------------------------------------- the close ---
{
  const s = document.getElementById("end");
  tl.call((p, t) => { s.style.display = t >= END.t0 - 0.1 ? "" : "none"; }, 0, DURATION);
  tl.to($screen, { opacity: [1, 0], y: [0, 120], scale: [1, 0.92] }, END.t0 - 0.25, 0.55, "inCubic");
  const lock = el("div", { class: "abs", style: { left: "0", top: "700px", width: "886px", display: "flex", flexDirection: "column", alignItems: "center", gap: "34px" } }, s);
  const mark = el("div", {
    html: `<svg width="168" height="168" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#c8f24e"/><g transform="translate(31.244 22.5) scale(0.08744)"><g fill="#0c1400"><rect x="0.59" y="115.85" width="163" height="442.77" transform="rotate(-44.9265 0.59 115.85)"/><rect x="311.97" y="198.25" width="163" height="442.77" transform="rotate(44.5184 311.97 198.25)"/></g></g></svg>`,
    style: { width: "168px", height: "168px" },
  }, lock);
  const word = el("div", { class: "wordmark", text: "Track Evolution" }, lock);
  const line = words(lock, "Free is the logbook./*Pro is the analysis.*", "endline");
  line.el.style.marginTop = "26px";
  const fine = el("div", { class: "abs fine", text: "Screens show a demo logbook.", style: { left: "0", width: "886px", top: "1760px" } }, s);
  tl.to(mark, { scale: [0.3, 1], opacity: [0, 1], rotate: [-60, 0] }, END.t0 + 0.15, 0.7, "outBack");
  tl.to(word, { y: [30, 0], opacity: [0, 1], blur: [10, 0] }, END.t0 + 0.4, 0.7, "outQuart");
  rise(line.words, END.t0 + 0.8, { each: 0.06 });
  tl.to(fine, { opacity: [0, 1] }, END.t0 + 1.2, 0.6, "outQuad");
  tl.to("#fade", { opacity: [0, 1] }, DURATION - 0.6, 0.6, "inQuad");
}

// ---------------------------------------------------------------- drive ---

window.__duration = DURATION;
window.__fps = FPS;
window.__seek = async (t) => {
  tl.seek(t);
  const loads = [];
  for (const c of clips) {
    const k = Math.max(1, Math.min(c.count, Math.round((t - (c.slot.t0 - LEAD)) * FPS) + 1));
    const src = `../out/appstore/.frames/${c.slot.id}/${String(k).padStart(4, "0")}.jpg`;
    if (src !== c.src && t >= c.slot.t0 - LEAD - 0.1 && t < c.slot.t1 + 0.1) {
      c.src = src;
      c.im.src = src;
      loads.push(c.im.decode().catch(() => {}));
    }
  }
  await Promise.all(loads);
};
await document.fonts.ready;
await window.__seek(Number(q.get("t") ?? 0));
window.__ready = true;
