// Per-lap channel data for imported telemetry sessions: each lap's channels
// resampled onto a uniform driven-distance grid, so laps overlay
// corner-for-corner in the channel graphs regardless of lap time. Built at
// import time — telemetry files never leave the browser, so anything to
// graph later must be derived here and stored with the session. Pure
// functions, unit-tested.
//
// Stored shape (sessions.channels, sanitized server-side in
// src/lib/validate.ts — keep the two in sync):
//   { v: 1, dStepM,
//     meta?: { ambientC?, intakeC?, elevationM?, odometerKm? },
//     laps: [{ n, timeMs, speed: [...], rpm?: [...], …, oilC?: 118, … }] }
// Arrays hold one value per grid point at d = 0, dStepM, 2*dStepM… from the
// lap's start; scalars are one number for the lap.
//
// What lands in which shape is decided by sample rate, and a PDR file makes
// the split obvious: it carries 66 channels, and the ones below ~5 Hz produce
// one real sample every 40-90 m, so a 250-point array of them would be
// interpolation dressed as data. Those become per-lap scalars (SCALAR_NAMES)
// instead, and the four that describe the whole session become `meta`.

import { series } from "../../pdr.js";
import { projectTrace } from "./geo.js";

export const D_STEP_M = 20;      // grid spacing: ~100-600 points for real laps
export const MAX_LAP_POINTS = 700; // guards degenerate "laps" (also capped server-side)
// Mirror sanitizeChannels' budget (src/lib/validate.ts).
export const MAX_LAPS = 80;
export const MAX_TOTAL_VALUES = 120000;

// Every gridded channel a lap entry can carry, with its rounding factor
// (decimal places worth keeping in the stored JSON).
//
// Order is load-bearing twice over. It is the stored/render order, so the six
// original channels keep their positions and an existing session's graphs are
// unchanged. And it is *priority* order: when a session overruns
// MAX_TOTAL_VALUES the tail is dropped until it fits (see trimToBudget), so a
// driver loses boost before losing speed. Anything appended here is therefore
// appended, never inserted.
export const CHANNEL_NAMES = [
  ["speed", 10],
  ["rpm", 1],
  ["latG", 1000],
  ["throttle", 10],
  ["brake", 10],
  ["steering", 10],
  ["longG", 1000],
  ["yaw", 10],
  ["gear", 1],
  ["wheelSlip", 10],
  ["boost", 10],
  ["flags", 1],
];

// Two of those are states, not measurements, and the default sampler — read
// the interpolated value at the grid point — is wrong for both:
//   - `flags` is a bitfield (ABS | TC << 1 | VSC << 2) at ~45 Hz. A braking
//     event lasting half a second sits between two 20 m grid points, so a
//     point sample misses it entirely. Sampled as the OR of everything in the
//     window instead, which is `max` for a bitfield of independent bits.
//   - `gear` is an enum at ~6.6 Hz. Interpolating 3 and 4 yields 3.5, a gear
//     no car has. Sampled by holding the last value at or before the point.
export const WINDOW_MAX = ["flags"];
export const STEP_HOLD = ["gear"];

// Slow channels (0.5-1.4 Hz) reduced to one number per lap, with how to
// reduce them and the rounding factor. "max" and "min" are over the lap's own
// window; "end" is the value as the lap finished — which is what you want for
// a tyre pressure or a fuel level, and not what you want for an oil
// temperature.
export const SCALAR_NAMES = [
  ["oilC", "max", 10],
  ["oilKpa", "min", 1],
  ["coolantC", "max", 10],
  ["transC", "max", 10],
  ["fuelPct", "end", 10],
  ["battV", "min", 10],
  ["tyreKpaLF", "end", 1],
  ["tyreKpaRF", "end", 1],
  ["tyreKpaLR", "end", 1],
  ["tyreKpaRR", "end", 1],
  ["tyreCLF", "max", 10],
  ["tyreCRF", "max", 10],
  ["tyreCLR", "max", 10],
  ["tyreCRR", "max", 10],
];

// Session-level numbers, carried through to the stored blob's `meta`.
export const META_NAMES = [
  ["ambientC", 10],
  ["intakeC", 10],
  ["elevationM", 1],
  ["odometerKm", 1],
];

const round = (v, f) => Math.round(v * f) / f;

// Index of the last sample at or before `t`, or -1. `arr` is sorted by t.
function holdIndex(arr, t) {
  let lo = 0, hi = arr.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].t <= t) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best;
}

// Last value at or before `t` (the first sample's value before the series
// starts) — the sampler for enum channels.
function holdAt(arr, t) {
  const i = holdIndex(arr, t);
  return arr[i < 0 ? 0 : i].v;
}

// Largest value in [t0, t1], falling back to the held value when the window
// contains no sample — the sampler for flag channels.
function maxIn(arr, t0, t1) {
  let m = -Infinity;
  for (let i = Math.max(0, holdIndex(arr, t0)); i < arr.length && arr[i].t <= t1; i++) {
    if (arr[i].t >= t0 && arr[i].v > m) m = arr[i].v;
  }
  return m === -Infinity ? holdAt(arr, t1) : m;
}

// Cumulative driven distance [{t, v: meters}] from a projected trace
// ([{t, x, y}], see geo.js projectTrace).
export function distFromTrace(projected) {
  const out = [];
  let d = 0;
  for (let i = 0; i < projected.length; i++) {
    if (i) d += Math.hypot(projected[i].x - projected[i - 1].x, projected[i].y - projected[i - 1].y);
    out.push({ t: projected[i].t, v: d });
  }
  return out;
}

// Channel sources for a GPS-only import (GoPro, plain VBO, beacon-less
// PDR via the line picker): distance integrated from the projected trace,
// speed from the source's own fixes (m/s) when present.
export function traceChannelData(gps, projected) {
  const withV = gps.filter((p) => p.v != null && Number.isFinite(p.v));
  return {
    dist: distFromTrace(projected),
    series: {
      speed: withV.length >= gps.length * 0.8 ? withV.map((p) => ({ t: p.t, v: p.v * 3.6 })) : null,
    },
    scalars: {},
    meta: null,
  };
}

// Channel sources for any parsed import: PDR uses its odometer + car
// channels (works with or without GPS, falling back to GPS distance when a
// file lacks the odometer); everything else needs a GPS trace.
export function channelDataFor(parsed) {
  const fromTrace = () =>
    parsed.gps?.length >= 10 ? traceChannelData(parsed.gps, projectTrace(parsed.gps)) : null;
  if (parsed.kind !== "pdr") return fromTrace();
  const car = {};
  for (const [k, v] of Object.entries(parsed.carChannels ?? {})) if (v) car[k] = v;
  const scalars = {};
  for (const [k, v] of Object.entries(parsed.lapScalarChannels ?? {})) if (v) scalars[k] = v;
  const meta = parsed.sessionMeta ?? null;
  const odo = parsed.channels?.odoPts;
  if (odo && odo.length >= 10) return { dist: odo, series: car, scalars, meta };
  const base = fromTrace();
  return base ? { dist: base.dist, series: { ...base.series, ...car }, scalars, meta } : null;
}

// Compute and attach `lapChannels` (the stored shape) to a parsed import.
// Called after parsing and again whenever laps change (line pick, batch
// anchoring). Laps without startT/endT windows contribute nothing.
export function attachLapChannels(parsed) {
  const data = parsed.laps?.length ? channelDataFor(parsed) : null;
  parsed.lapChannels = data
    ? buildLapChannels(parsed.laps, data.dist, data.series, D_STEP_M, {
        scalars: data.scalars,
        meta: data.meta,
      })
    : null;
  return parsed;
}

// Cut per-lap channel arrays on the distance grid. Laps without a
// startT/endT window (hand-entered times) are skipped; returns null when
// nothing survives, so callers can store the absence as-is.
//   laps:  [{lapNumber?, timeMs, startT?, endT?}]
//   dist:  [{t, v: meters}] cumulative, same clock as the series
//   chans: the CHANNEL_NAMES channels as [{t, v}] — speed km/h, latG/longG G,
//          throttle/brake/wheelSlip %, steering/yaw deg, boost kPa, gear 0-8,
//          flags a 3-bit field
//   opts:  { scalars } the SCALAR_NAMES series, { meta } the session numbers
export function buildLapChannels(laps, dist, chans, dStepM = D_STEP_M, opts = {}) {
  if (!laps?.length || !dist || dist.length < 10) return null;
  const { scalars = {}, meta = null } = opts;
  const distS = series(dist);
  const named = CHANNEL_NAMES.map(([name, f]) => [name, chans[name], f]).filter(
    ([, pts]) => pts && pts.length >= 10
  );
  // Each channel keeps its own sampler: interpolated by default, held for
  // enums, OR-ed across the window for flags (see WINDOW_MAX / STEP_HOLD).
  const chanS = named.map(([name, pts, f]) => {
    const s = series(pts);
    const sample = WINDOW_MAX.includes(name)
      ? (t, tNext) => maxIn(pts, t, tNext)
      : STEP_HOLD.includes(name)
        ? (t) => holdAt(pts, t)
        : (t) => s.at(t);
    return { name, f, first: s.first, last: s.last, sample };
  });
  const scalarS = SCALAR_NAMES.map(([name, reduce, f]) => [name, scalars[name], reduce, f]).filter(
    ([, pts]) => pts && pts.length >= 2
  ).map(([name, pts, reduce, f]) => ({ name, pts, reduce, f, s: series(pts) }));

  const out = [];
  for (let i = 0; i < laps.length; i++) {
    const lap = laps[i];
    if (lap.startT == null || lap.endT == null || lap.endT <= lap.startT) continue;
    const d0 = distS.at(lap.startT);
    const d1 = distS.at(lap.endT);
    const n = Math.floor((d1 - d0) / dStepM) + 1;
    if (n < 10 || n > MAX_LAP_POINTS) continue;
    const entry = { n: lap.lapNumber ?? i + 1, timeMs: lap.timeMs };
    // Grid points as times, computed once and shared by every channel; the
    // last point's window closes at the lap's end.
    const ts = Array.from({ length: n }, (_, k) => distS.timeAt(d0 + k * dStepM));
    const tNext = (k) => (k + 1 < n ? ts[k + 1] : lap.endT);
    // synthesized speed (from the distance slope) fills in when no source
    // speed channel exists — the graph is too useful to drop for that
    let any = false;
    for (const c of chanS) {
      if (lap.startT < c.first.t - 5 || lap.endT > c.last.t + 5) continue;
      entry[c.name] = Array.from({ length: n }, (_, k) => round(c.sample(ts[k], tNext(k)), c.f));
      any = true;
    }
    if (!entry.speed) {
      entry.speed = Array.from({ length: n }, (_, k) => round(Math.max(0, distS.rate(ts[k])) * 3.6, 10));
      any = true;
    }
    for (const c of scalarS) {
      const v = reduceScalar(c, lap.startT, lap.endT);
      if (v != null) entry[c.name] = round(v, c.f);
    }
    if (any) out.push(entry);
  }
  if (!out.length || out.length > MAX_LAPS) return null;
  if (!trimToBudget(out)) return null;
  const blob = { v: 1, dStepM, laps: out };
  const m = cleanMeta(meta);
  if (m) blob.meta = m;
  return blob;
}

// One number for one lap, by the channel's own rule. `max`/`min` run over the
// samples inside the lap; a lap short enough to contain none of them (a 0.5 Hz
// channel and a very fast lap) falls back to the interpolated value at the
// finish, which is also what `end` always uses.
function reduceScalar(c, startT, endT) {
  if (c.reduce !== "end") {
    let best = null;
    for (let i = Math.max(0, holdIndex(c.pts, startT)); i < c.pts.length && c.pts[i].t <= endT; i++) {
      if (c.pts[i].t < startT) continue;
      const v = c.pts[i].v;
      if (best == null || (c.reduce === "max" ? v > best : v < best)) best = v;
    }
    if (best != null) return best;
  }
  if (endT < c.s.first.t - 5 || startT > c.s.last.t + 5) return null;
  return c.s.at(endT);
}

// Bring a session under MAX_TOTAL_VALUES by dropping whole channels from the
// tail of CHANNEL_NAMES — the lowest-priority ones — rather than storing
// nothing at all. Returns false only when even speed alone doesn't fit, which
// is the marathon-enduro case the cap exists for. Mutates `out`.
function trimToBudget(out) {
  const total = () =>
    out.reduce((s, e) => s + CHANNEL_NAMES.reduce((c, [k]) => c + (e[k]?.length ?? 0), 0), 0);
  for (let i = CHANNEL_NAMES.length - 1; i > 0 && total() > MAX_TOTAL_VALUES; i--) {
    const [name] = CHANNEL_NAMES[i];
    for (const e of out) delete e[name];
  }
  return total() <= MAX_TOTAL_VALUES;
}

// Session numbers, rounded, with absent ones left out entirely; null when the
// source had none, so the stored blob simply carries no `meta` key.
function cleanMeta(meta) {
  if (!meta) return null;
  const out = {};
  for (const [name, f] of META_NAMES) {
    const v = meta[name];
    if (typeof v === "number" && Number.isFinite(v)) out[name] = round(v, f);
  }
  return Object.keys(out).length ? out : null;
}
