// Video-synced lap analysis (NS-51, docs/specs/native/NS-51-video-synced-laps.md):
// the pure half of the lap stage. One driven distance — a fractional index `k`
// on a lap's 20 m channel grid — is the playhead, and this module turns a
// video's clock into it and back, keeps a second lap's video in step with the
// first, and words where the car is.
//
// Nothing here is stored. A lap's elapsed time at each grid point is derived
// from its speed trace by lapTimeSeries (the delta chart's own curve: exact at
// both ends, scaled to the timed lap, drifting a little in between), and a
// clip's `lap_offset_ms` says where the lap starts inside the video. `makeSide`
// takes the time curve as an optional argument so a stored series can replace
// the derived one without changing a caller.
//
// Ported to the iOS Kit (Analysis/VideoSync.swift) and Android :core
// (VideoSync.kt) under the same names, and pinned by
// contracts/logic/video-sync.json, generated from this file. The DOM half is
// js/lap-stage.js, web-only.

import { DELTA_MIN_KPH, lapTimeSeries } from "./channel-graphs.js";
import { LENGTH_MISMATCH_WARN } from "./compare-laps.js";
import { cornerLabel } from "./corners.js";
import { PLAYBACK_LEAD_S } from "./import/clip.js";
import { fmtDist, fmtSpeedKph, isMetric, FT_PER_M } from "./units.js";

// The two ways a compare keeps two videos together: "place" holds both cars
// at the same distance (the slower lap's video runs faster to keep up), "time"
// at the same elapsed time from the line (one car pulls ahead).
export const SYNC_MODES = Object.freeze(["place", "time"]);
export const DEFAULT_SYNC_MODE = "place";
// A follower more than this far from where it should be is re-seeked.
export const RESYNC_MS = 150;
// The follower's playback rate in "place" mode stays inside these.
export const FOLLOW_RATE_MIN = 0.5;
export const FOLLOW_RATE_MAX = 2;
// A brake reading at or above this is "braking" in the scrubber's words —
// compare-laps.js' BRAKING_PCT, which the head-to-head counts by.
export const BRAKING_WORD_PCT = 10;

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// The fractional grid index where t[k] === e, by binary search and linear
// interpolation, clamped to [0, t.length − 1]. `t` is strictly increasing:
// lapTimeSeries floors the speed at DELTA_MIN_KPH, so no cell takes no time.
export function gridAtElapsed(t, e) {
  const last = t.length - 1;
  if (last <= 0 || !(e > t[0])) return 0;
  if (e >= t[last]) return last;
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= e) lo = mid;
    else hi = mid;
  }
  return lo + (e - t[lo]) / (t[hi] - t[lo]);
}

// A series at fractional index k, linearly interpolated, k clamped to the
// series. null for a missing or empty series.
export function valueAt(series, k) {
  if (!Array.isArray(series) || !series.length) return null;
  const last = series.length - 1;
  const kk = clamp(finite(k) ? k : 0, 0, last);
  const i0 = Math.floor(kk);
  if (i0 >= last) return series[last];
  return series[i0] + (series[i0 + 1] - series[i0]) * (kk - i0);
}

// One side of the stage: a lap's stored channel entry, its grid spacing, its
// time curve and its clip ({ lapOffsetMs, durationMs }, or null — replay).
// null when the entry carries no speed trace to integrate.
export function makeSide(key, entry, dStepM, clip, t = null) {
  if (!Array.isArray(entry?.speed) || entry.speed.length < 2) return null;
  const curve = t ?? lapTimeSeries(entry.speed, dStepM, entry.timeMs);
  return {
    key,
    entry,
    dStepM,
    t: curve,
    clip: clip && finite(clip.lapOffsetMs) ? { lapOffsetMs: clip.lapOffsetMs, durationMs: finite(clip.durationMs) ? clip.durationMs : null } : null,
  };
}

// The side's lap length in seconds — the time curve's end, which is the timed
// lap when it had one.
const lapS = (side) => side.t[side.t.length - 1];
const offsetMs = (side) => side.clip?.lapOffsetMs ?? 0;

// A clip time (ms) → { e, k, inLap } for one side: e the lap's elapsed seconds
// (negative before the line), k the grid index there, clamped to the lap.
export function sideAtClipTime(side, clipMs) {
  const e = (clipMs - offsetMs(side)) / 1000;
  return { e, k: gridAtElapsed(side.t, e), inLap: e >= 0 && e <= lapS(side) };
}

// k → the clip time (ms) to seek that side to.
export function clipTimeAtGrid(side, k) {
  return offsetMs(side) + 1000 * valueAt(side.t, k);
}

// The scrubber's range in the master's lap time, seconds: the lap with
// PLAYBACK_LEAD_S of run-up either side.
export function scrubRange(side) {
  return { min: -PLAYBACK_LEAD_S, max: lapS(side) + PLAYBACK_LEAD_S };
}

// Whether two sides are matched by lap fraction rather than grid index: their
// driven lengths differ by more than compare-laps.js' warning threshold.
export function matchByFraction(a, b) {
  if (!a || !b) return false;
  const la = (a.t.length - 1) * a.dStepM, lb = (b.t.length - 1) * b.dStepM;
  const longest = Math.max(la, lb);
  return longest > 0 && Math.abs(la - lb) / longest > LENGTH_MISMATCH_WARN;
}

// k on `from`'s grid → the same place on `to`'s grid.
function mapGrid(from, to, k, byFraction) {
  const nTo = to.t.length - 1;
  if (!byFraction) return clamp(k, 0, nTo);
  const nFrom = from.t.length - 1;
  return nFrom > 0 ? clamp((k * nTo) / nFrom, 0, nTo) : 0;
}

// What the car is doing at k: the stored readings, nearest sample for the gear
// (a state, not a measurement — gear 3.5 means nothing).
function readings(entry, k) {
  const gear = Array.isArray(entry.gear) && entry.gear.length ? entry.gear[clamp(Math.round(k), 0, entry.gear.length - 1)] : null;
  return {
    speedKph: valueAt(entry.speed, k),
    throttle: valueAt(entry.throttle, k),
    brake: valueAt(entry.brake, k),
    gear: finite(gear) ? gear : null,
  };
}

function sideState(side, e, k) {
  const clipMs = side.clip ? offsetMs(side) + 1000 * e : null;
  const dur = side.clip?.durationMs;
  return {
    e,
    k,
    distM: k * side.dStepM,
    inLap: e >= 0 && e <= lapS(side),
    clipMs,
    // Whether the side's video holds this moment: a cut that started late, or
    // a playhead out in the other lap's run-up, leaves it on replay.
    inClip: clipMs != null && clipMs >= 0 && (dur == null || clipMs <= dur),
    now: readings(side.entry, k),
  };
}

// The whole view at the master's elapsed time `eMaster` (seconds from its
// line): { mode, masterKey, inLap, byFraction, a, b, deltaS, gapM }, each side
// { e, k, distM, inLap, clipMs, inClip, now: { speedKph, throttle, brake, gear } }.
// `sides` is { a, b } with b null for a one-sided stage; `masterKey` "A" or "B".
//
// In the lap: "place" puts the other side at the master's distance, "time" at
// its elapsed time. Out of the lap both sides keep the master's distance from
// the line in time — the same run-up before it, the same roll-out after — so
// two cars cross it together in "place" mode.
//
// deltaS is A's time minus B's at A's place (positive: A slower), and gapM in
// "time" mode B's distance ahead of A in metres (positive: B ahead). Both are
// null out of the lap or one-sided, and gapM is null in "place" mode.
export function playheadAt(sides, masterKey, eMaster, mode = DEFAULT_SYNC_MODE) {
  const a = sides.a, b = sides.b ?? null;
  const master = masterKey === "B" && b ? b : a;
  const other = master === a ? b : a;
  const key = master === a ? "A" : "B";
  const byFraction = matchByFraction(a, b);
  const lapM = lapS(master);
  const inLap = eMaster >= 0 && eMaster <= lapM;
  const kM = gridAtElapsed(master.t, eMaster);
  const mState = sideState(master, eMaster, kM);

  let oState = null;
  if (other) {
    let eO, kO;
    if (mode === "time") {
      eO = eMaster;
      kO = gridAtElapsed(other.t, eO);
    } else if (!inLap) {
      eO = eMaster < 0 ? eMaster : lapS(other) + (eMaster - lapM);
      kO = gridAtElapsed(other.t, eO);
    } else {
      kO = mapGrid(master, other, kM, byFraction);
      eO = valueAt(other.t, kO);
    }
    oState = sideState(other, eO, kO);
  }

  const aState = master === a ? mState : oState;
  const bState = master === a ? oState : mState;
  let deltaS = null, gapM = null;
  if (b && inLap) {
    const kB = mapGrid(a, b, aState.k, byFraction);
    deltaS = valueAt(a.t, aState.k) - valueAt(b.t, kB);
    if (mode === "time") {
      const kBonA = mapGrid(b, a, bState.k, byFraction);
      gapM = (kBonA - aState.k) * a.dStepM;
    }
  }
  return { mode, masterKey: key, inLap, byFraction, a: aState, b: bState, deltaS, gapM };
}

// The follower's playback rate in "place" mode at the master's grid index k:
// the master's speed over the follower's at the same place, so the follower's
// video covers the same metres in the master's seconds. Floored at
// DELTA_MIN_KPH like the time curve, and clamped.
export function followRate(sides, masterKey, k) {
  const a = sides.a, b = sides.b ?? null;
  if (!b) return 1;
  const master = masterKey === "B" ? b : a;
  const other = master === a ? b : a;
  const vM = valueAt(master.entry.speed, k);
  const vO = valueAt(other.entry.speed, mapGrid(master, other, k, matchByFraction(a, b)));
  if (vM == null || vO == null) return 1;
  return clamp(Math.max(DELTA_MIN_KPH, vM) / Math.max(DELTA_MIN_KPH, vO), FOLLOW_RATE_MIN, FOLLOW_RATE_MAX);
}

// Whether a follower `actualMs` into its clip is far enough from `targetMs` to
// re-seek: strictly more than RESYNC_MS.
export function needsResync(targetMs, actualMs) {
  return Math.abs(targetMs - actualMs) > RESYNC_MS;
}

// The stage's clock: "0:36.0", "2:19.8", "−0:01.5" — tenths, rounded.
export function fmtStageTime(s) {
  if (!finite(s)) return "—";
  const tenths = Math.round(Math.abs(s) * 10);
  const m = Math.floor(tenths / 600);
  const sec = (tenths % 600) / 10;
  const body = `${m}:${sec < 10 ? "0" : ""}${sec.toFixed(1)}`;
  return s < 0 && tenths > 0 ? `−${body}` : body;
}

// A signed delta in seconds: "+0.31 s", "−0.12 s", "0.00 s".
export function fmtDeltaS(d) {
  if (!finite(d)) return null;
  const v = Math.round(Math.abs(d) * 100);
  if (v === 0) return "0.00 s";
  return `${d > 0 ? "+" : "−"}${(v / 100).toFixed(2)} s`;
}

// "B ahead 26 m" / "A ahead 85 ft" / "Level".
export function fmtGap(gapM, units) {
  if (!finite(gapM)) return null;
  const v = Math.round(Math.abs(gapM) * (isMetric(units) ? 1 : FT_PER_M));
  if (v === 0) return "Level";
  return `${gapM > 0 ? "B" : "A"} ahead ${v} ${isMetric(units) ? "m" : "ft"}`;
}

// Where k sits among the corners: "in T2", "after T4", "before T1", or null
// when the lap has no corners to place it by.
export function cornerPlace(corners, k) {
  if (!corners?.length) return null;
  const inside = corners.find((c) => k >= c.k0 && k <= c.k1);
  if (inside) return `in ${cornerLabel(inside)}`;
  let prev = null;
  for (const c of corners) if (c.k1 < k) prev = c;
  return prev ? `after ${cornerLabel(prev)}` : `before ${cornerLabel(corners[0])}`;
}

// The words for the playhead, read from side A: `place` the now-strip's
// first line ("1.50 km · in T2", or "Before the line"), `delta` its last
// ("+0.31 s", or in "time" mode "B ahead 26 m"; null with nothing to compare),
// and `value` the scrubber's spoken value — "0:41.2, 2.84 km, in T11, 82 mph,
// braking 64 %, +0.31 s" — whose clock is the master's.
export function playheadText(state, corners, units) {
  const a = state.a;
  const master = state.masterKey === "B" && state.b ? state.b : a;
  const clock = fmtStageTime(master.e);
  if (!state.inLap) {
    const place = master.e < 0 ? "Before the line" : "After the line";
    return { place, value: `${clock}, ${place}`, delta: null };
  }
  const dist = fmtDist(Math.round(a.distM), units);
  const where = cornerPlace(corners, a.k);
  const place = where ? `${dist} · ${where}` : dist;
  const delta = state.mode === "time" ? fmtGap(state.gapM, units) : fmtDeltaS(state.deltaS);
  const parts = [clock, dist];
  if (where) parts.push(where);
  if (a.now.speedKph != null) parts.push(fmtSpeedKph(a.now.speedKph, units));
  if (a.now.brake != null && a.now.brake >= BRAKING_WORD_PCT) parts.push(`braking ${Math.round(a.now.brake)} %`);
  else if (a.now.throttle != null) parts.push(`throttle ${Math.round(a.now.throttle)} %`);
  if (delta) parts.push(delta);
  return { place, value: parts.join(", "), delta };
}

// The screen reader's stops along the scrubber: each corner's start as
// { label, e }, e the lap's elapsed seconds there on time curve `t`.
export function cornerStops(corners, t) {
  return (corners ?? []).map((c) => ({ label: cornerLabel(c), e: valueAt(t, c.k0) }));
}

// The single-lap stage's reference lap: the session best, or the next-best
// when this lap is the best, or null when no other lap has channels. `matched`
// is matchLapsToChannels' [{ lap, chIdx }]; returns one of its rows. Ties go to
// the earlier lap.
export function referenceLap(matched, chIdx) {
  const rows = (matched ?? []).filter((r) => r.chIdx >= 0 && r.chIdx !== chIdx && finite(r.lap?.time_ms));
  if (!rows.length) return null;
  const all = (matched ?? []).filter((r) => r.chIdx >= 0 && finite(r.lap?.time_ms));
  const best = all.reduce((m, r) => (r.lap.time_ms < m.lap.time_ms ? r : m));
  if (best.chIdx !== chIdx) return best;
  return rows.reduce((m, r) => (r.lap.time_ms < m.lap.time_ms ? r : m));
}

// Which of a session panel's lit laps the stage shows, as channel indexes:
// A the lap the view was opened for if it is lit, else the most recently lit;
// B the fastest other lit lap (ties to the earlier index), or null. `lit` is
// the panel's slot order (oldest first), `laps` the channel entries. null when
// nothing is lit.
export function stageSides(lit, laps, openedChIdx) {
  if (!lit?.length) return null;
  const a = lit.includes(openedChIdx) ? openedChIdx : lit[lit.length - 1];
  let b = null;
  for (const i of lit) {
    if (i === a || !finite(laps[i]?.timeMs)) continue;
    if (b == null || laps[i].timeMs < laps[b].timeMs || (laps[i].timeMs === laps[b].timeMs && i < b)) b = i;
  }
  return { a, b };
}
