// The channel panel's x-axis and cursor. Every stored channel lap is gridded
// on driven distance (js/import/channels.js), so distance is the axis the
// traces are kept on. The panel can also lay them out against each lap's own
// elapsed time: lapTimeSeries already knows how long each lap took to reach
// each grid point. Overlaid against time, laps drift apart around the track,
// and that drift is the gap. Against distance they line up corner for corner.
// Distance is the default for that reason.
//
// The cursor is a place picked on the axis by a tap, a click or a pointer.
// axisPlaces turns it into where each lit lap was at that axis value: its
// fractional grid index (the value read-outs and the chart dots) and its
// fraction of its own lap (the dot on the track map, placed by driven
// distance the way the lap stage places its cars). Pure and ported:
// LapAxis in the iOS Kit and Android :core, pinned by
// contracts/logic/lap-axis.json.

import { lapTimeSeries } from "./channel-graphs.js";
import { gridAtElapsed } from "./video-sync.js";
import { distAxisTicks, fmtDist } from "./units.js";

export const AXIS_MODES = Object.freeze(["distance", "time"]);
export const DEFAULT_AXIS = "distance";

// The step sizes a time axis may tick at, in seconds.
export const TIME_TICK_STEPS = Object.freeze([1, 2, 5, 10, 15, 20, 30, 60, 120, 300]);
// About this many ticks across a chart, as the distance axis aims for.
export const TIME_TICK_TARGET = 6;

const finite = (v) => typeof v === "number" && Number.isFinite(v);

// The axis value at each grid point of a stored channel lap. Distance is
// k * dStepM in metres; time is the lap's elapsed seconds (lapTimeSeries,
// scaled to the timed lap). A lap with no grid has no series, and in time a
// lap with no speed trace has none either.
export function lapAxisSeries(entry, dStepM, mode) {
  if (mode === "time") {
    if (!Array.isArray(entry?.speed) || entry.speed.length < 2) return null;
    return lapTimeSeries(entry.speed, dStepM, entry.timeMs);
  }
  const n = Array.isArray(entry?.speed)
    ? entry.speed.length
    : Math.max(0, ...["throttle", "brake", "steering", "rpm", "latG", "yaw", "gear"].map((k) => (Array.isArray(entry?.[k]) ? entry[k].length : 0)));
  if (n < 2) return null;
  return Array.from({ length: n }, (_, k) => k * dStepM);
}

// The axis's extent over a session's laps: the largest last value of any
// lap's series, 0 when no lap has one.
export function axisExtent(laps, dStepM, mode) {
  let x1 = 0;
  for (const l of laps ?? []) {
    const xs = lapAxisSeries(l, dStepM, mode);
    if (xs && xs[xs.length - 1] > x1) x1 = xs[xs.length - 1];
  }
  return x1;
}

// A lap's fractional grid index at an axis value, or null when the value is
// off the lap (before its start or past its end). Both series rise with k,
// so it is the same interpolating search video-sync.js uses for a clock.
export function gridAtAxis(xs, x) {
  if (!Array.isArray(xs) || xs.length < 2 || !finite(x)) return null;
  if (x < xs[0] || x > xs[xs.length - 1]) return null;
  return gridAtElapsed(xs, x);
}

// The other way: the axis value at a fractional grid index, clamped.
export function axisAtGrid(xs, k) {
  if (!Array.isArray(xs) || !xs.length || !finite(k)) return null;
  const last = xs.length - 1;
  const kk = Math.max(0, Math.min(last, k));
  const i0 = Math.floor(kk);
  if (i0 >= last) return xs[last];
  return xs[i0] + (xs[i0 + 1] - xs[i0]) * (kk - i0);
}

// Where each lap in `lapIdxs` (indexes into `laps`, in the caller's order)
// was at axis value x: { chIdx, k, frac }. A lap the value is off is left
// out. frac is k over the lap's own last grid index.
export function axisPlaces(laps, dStepM, mode, x, lapIdxs) {
  const out = [];
  for (const chIdx of lapIdxs ?? []) {
    const xs = lapAxisSeries(laps?.[chIdx], dStepM, mode);
    const k = gridAtAxis(xs, x);
    if (k == null) continue;
    out.push({ chIdx, k, frac: k / (xs.length - 1) });
  }
  return out;
}

// m:ss for a time-axis tick; ticks land on whole seconds.
export function fmtAxisSeconds(s) {
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

// Ticks for a time axis from 0 to x1 seconds: the smallest step in
// TIME_TICK_STEPS that keeps the count at or under TIME_TICK_TARGET, the
// largest step otherwise. Returns [{ s, label }].
export function timeAxisTicks(x1) {
  if (!finite(x1) || x1 <= 0) return [];
  const step = TIME_TICK_STEPS.find((st) => x1 / st <= TIME_TICK_TARGET) ?? TIME_TICK_STEPS[TIME_TICK_STEPS.length - 1];
  const out = [];
  for (let s = 0; s <= x1 + 1e-9; s += step) out.push({ s, label: fmtAxisSeconds(s) });
  return out;
}

// The cursor's place as the tooltip and the read-out say it: a distance in
// the user's units, or the elapsed time to a tenth (m:ss.s).
export function fmtAxisValue(x, mode, units) {
  if (!finite(x)) return "—";
  if (mode !== "time") return fmtDist(Math.round(x), units);
  const tenths = Math.round(Math.max(0, x) * 10);
  const sec = (tenths % 600) / 10;
  return `${Math.floor(tenths / 600)}:${sec < 10 ? "0" : ""}${sec.toFixed(1)}`;
}

// The axis's name in a chart's title and label ("by distance" / "by time").
export const axisWord = (mode) => (mode === "time" ? "time" : "distance");

// --- web drawing (not ported) ----------------------------------------------

// Series are worked out once per lap entry and mode: a chip toggle redraws
// every chart, and a time series is an integration over the whole lap.
const seriesCache = new WeakMap();
function cachedSeries(entry, dStepM, mode) {
  if (!entry || typeof entry !== "object") return null;
  let byMode = seriesCache.get(entry);
  if (!byMode) seriesCache.set(entry, (byMode = new Map()));
  const key = `${mode}:${dStepM}`;
  if (!byMode.has(key)) byMode.set(key, lapAxisSeries(entry, dStepM, mode));
  return byMode.get(key);
}

// What a chart needs to lay a session's laps out on the axis: the extent,
// the ticks ({ x, label }) and each lap's series by its index.
export function axisFrame(laps, dStepM, mode, units) {
  const m = mode === "time" ? "time" : "distance";
  const xsOf = (i) => cachedSeries(laps?.[i], dStepM, m);
  let x1 = 0;
  (laps ?? []).forEach((_, i) => {
    const xs = xsOf(i);
    if (xs && xs[xs.length - 1] > x1) x1 = xs[xs.length - 1];
  });
  const ticks = m === "time" ? timeAxisTicks(x1).map((t) => ({ x: t.s, label: t.label })) : distAxisTicks(x1, units).map((t) => ({ x: t.m, label: t.label }));
  return { mode: m, x1, ticks, xsOf };
}
