// Porsche Track Precision's CSV export. The same car, the same channels and
// the same app as its .vbo export (vbo.js), in a plainer layout: one header
// row of camelCase names, then one comma-separated row per ~10 Hz sample.
// Newer app versions put a space after every comma; empty fields are columns
// the car didn't report.
//
// Three things differ from the .vbo and each is load-bearing:
//   - Coordinates are decimal degrees, east-positive, so nothing is negated.
//   - The clock is `timestamp`, epoch milliseconds.
//   - There is no start/finish line — but there is Track Precision's own lap
//     timer, `laptime`, the milliseconds since the car last crossed its line.
//     The crossing is therefore `timestamp - laptime` on the first sample of
//     each lap, which is exact to the app's own timing (lapsFromLaptime) and
//     needs no line at all. A file whose timer never completes a lap falls
//     back to the line picker, like a .vbo without [laptiming].
//
// Units change with the app's firmware and the file never says which: speed
// is km/h in the 2024 exports and m/s later (speedToMs decides against the
// GPS trace), and the accelerations are m/s² then G (accelToG, shared with
// vbo.js, whose _PTPA columns changed the same way).

import { lapTrace, projectTrace } from "./geo.js";
import { carSilent, dateFromName, finishCarChannels } from "./vbo.js";

// Car channels, by lowercased header -> channels.js name, converted as
// vbo.js's CAR_COLUMNS are. `yawVelocity` is mapped for parity with the
// .vbo's `yaw` column; every sample so far writes it as 0, which
// finishCarChannels' `varies` drops.
const CAR_COLUMNS = [
  ["rpm", "enginespeed", (v) => v],
  ["latG", "lateralacceleration", (v) => Math.abs(v)], // stored as a magnitude, like PDR
  ["longG", "longitudinalacceleration", (v) => v],
  ["steering", "steeringwheelangle", (v) => v],
  ["gear", "currentgear", (v) => (v >= 1 && v <= 8 ? Math.round(v) : 0)],
  ["yaw", "yawvelocity", (v) => v],
];
const THROTTLE_COLUMN = "pedalforce"; // 0-1
const BRAKE_COLUMN = "brakingpressure"; // bar
// Tire pressures, bar -> kPa. 3276.8 (0x7FFF / 10) is "no reading", as in
// the .vbo.
const TYRE_COLUMNS = [
  ["tyreKpaLF", "tirepressurefl"],
  ["tyreKpaRF", "tirepressurefr"],
  ["tyreKpaLR", "tirepressurerl"],
  ["tyreKpaRR", "tirepressurerr"],
];
const MAX_TYRE_BAR = 10;

// Speed-column units, as the column's value for 1 m/s.
export const SPEED_UNITS = [
  ["m/s", 1],
  ["km/h", 3.6],
  ["mph", 2.2369362920544],
];

// The `speed` column's factor to m/s, decided by comparing it with the GPS
// trace: Σ speed·dt over Σ distance driven is the column's value for 1 m/s,
// and the nearest unit (in ratio, not difference) wins. Only steps where the
// car moved at least MIN_STEP_M count, so a parked stretch of GPS jitter
// can't pull the ratio. Km/h when there's nothing to go on — the older
// exports' unit.
const MIN_STEP_M = 0.5;
export function speedToMs(trace, speeds) {
  let driven = 0;
  let integrated = 0;
  for (let i = 1; i < trace.length; i++) {
    const d = Math.hypot(trace[i].x - trace[i - 1].x, trace[i].y - trace[i - 1].y);
    const dt = trace[i].t - trace[i - 1].t;
    const v = speeds[i];
    if (d < MIN_STEP_M || !(dt > 0) || v == null) continue;
    driven += d;
    integrated += v * dt;
  }
  if (!(driven > 0) || !(integrated > 0)) return 1 / 3.6;
  const ratio = integrated / driven;
  let best = SPEED_UNITS[1];
  for (const u of SPEED_UNITS) {
    if (Math.abs(Math.log(ratio / u[1])) < Math.abs(Math.log(ratio / best[1]))) best = u;
  }
  return 1 / best[1];
}

// Laps from Track Precision's lap timer. `rows` is [{t, lapMs, lapM, v}] in
// time order: the timer, its lap distance (m) and speed (m/s), each null
// where the field was empty.
//
// A lap starts wherever the counter goes backwards or sits at 0 — some
// firmware writes a single 0 row at the line, some goes straight to a small
// value — and its crossing is placed at `t - lapMs` on the first sample
// after, which is finer than the 10 Hz rows. A lap between two crossings is
// kept only when the counter ran the whole way: its last value before the
// second crossing must be within LAPTIME_TOL_S of the lap's length. That is
// what drops the stretch before the first crossing, a pit stop (the counter
// sits at 0 for minutes) and a recording stopped mid-lap. The timer's laps
// are exact to the app, so `estimated` is false.
//
// Track Precision also stops recording *at* the line, so the last lap's
// counter runs to within metres of a full lap and never resets. When the
// final sample's lap distance is within EDGE_M of the timed laps' length
// (their median, each carried from its last sample to its crossing) — either side, since a lap's length varies by a
// few metres with the line taken and the last sample may already be past it
// without the reset having been written — the difference is covered at the
// final sample's speed, the same allowance vbo.js makes for its edge
// crossings, and that one lap is marked estimated. Only at pace, though: the
// car must still be doing at least EDGE_PACE of the timed laps' average
// speed. A session usually ends with the cool-down lap rolling down the pit
// lane, which runs alongside the line — its lap distance reaches a full lap
// at 30 km/h without the car ever crossing the line, and the app rightly
// never counted it.
export const LAPTIME_TOL_S = 1;
export const EDGE_M = 30;
export const EDGE_PACE = 0.5;
export function lapsFromLaptime(rows, { minLapS = 30, maxLapS = 3600 } = {}) {
  const crossings = []; // {t, counted}: counted = the counter's last value before it
  const lapM = []; // each timed run's length in metres, carried on to its crossing
  let prev = null;
  let pending = true;
  let runMax = null;
  let last = null; // the last sample with the timer running
  for (const row of rows) {
    const { t, lapMs } = row;
    if (lapMs == null) continue;
    if (lapMs <= 0) {
      if (prev != null && prev > 0) runMax = prev;
      pending = true;
      prev = 0;
      continue;
    }
    if (prev != null && lapMs < prev) {
      runMax = prev;
      pending = true;
    }
    if (pending) {
      const ct = t - lapMs / 1000;
      if (runMax != null && last && last.lapM != null && last.v != null) lapM.push(last.lapM + last.v * (ct - last.t));
      crossings.push({ t: ct, counted: runMax });
      pending = false;
      runMax = null;
    }
    prev = lapMs;
    last = row;
  }
  const laps = [];
  const keep = (startT, endT, estimated) => {
    const s = endT - startT;
    if (s < minLapS || s > maxLapS) return;
    laps.push({ timeMs: Math.round(s * 1000), estimated, startT, endT });
  };
  for (let i = 1; i < crossings.length; i++) {
    const counted = crossings[i].counted;
    const s = crossings[i].t - crossings[i - 1].t;
    if (counted == null || Math.abs(s - counted / 1000) > LAPTIME_TOL_S) continue;
    keep(crossings[i - 1].t, crossings[i].t, false);
  }
  // The recording ended mid-run (a reset would have cleared `last`'s run).
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  if (last && !pending && laps.length && lapM.length && last.lapM != null && last.v > 0) {
    const lapLenM = median(lapM);
    const paceMs = lapLenM / (median(laps.map((l) => l.timeMs)) / 1000);
    const short = lapLenM - last.lapM;
    if (Math.abs(short) <= EDGE_M && last.v >= EDGE_PACE * paceMs) keep(crossings[crossings.length - 1].t, last.t + short / last.v, true);
  }
  return laps;
}

// "recording-2026-06-06-09-53-45.csv" -> "09:53:45", the recording's local
// start. The timestamp column is UTC and the file carries no zone, so the
// name is the only source of a wall-clock time.
function timeFromName(name) {
  const m = /\d{4}-\d{2}-\d{2}[-_ T](\d{2})[-:](\d{2})[-:](\d{2})/.exec(name ?? "");
  return m ? `${m[1]}:${m[2]}:${m[3]}` : null;
}

const pad2 = (n) => String(n).padStart(2, "0");

export function parseTrackPrecisionCsv(text, fileName = null) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error("Not a Porsche Track Precision CSV (empty file)");
  const names = lines[0].split(",").map((n) => n.trim().toLowerCase());
  const col = (name) => names.indexOf(name);
  const iTs = col("timestamp");
  const iLat = col("latitude");
  const iLon = col("longitude");
  if (iTs < 0 || iLat < 0 || iLon < 0) {
    throw new Error("Not a Porsche Track Precision CSV (no timestamp/latitude/longitude columns)");
  }
  const iSpeed = col("speed");
  const iLap = col("laptime");
  const iLapM = col("lapdistance");
  const carCols = CAR_COLUMNS.map(([name, n, f]) => ({ name, i: col(n), f })).filter((c) => c.i >= 0);
  const iThrottle = col(THROTTLE_COLUMN);
  const iBrake = col(BRAKE_COLUMN);
  const tyreCols = TYRE_COLUMNS.map(([name, n]) => ({ name, i: col(n) })).filter((c) => c.i >= 0);

  // First pass: the rows as numbers. The speed column's unit is only known
  // once the whole GPS trace is in (speedToMs), and the car-silence check
  // needs speed in m/s, so the channels are collected in a second pass.
  const rows = [];
  let ts0 = null;
  for (let r = 1; r < lines.length; r++) {
    const f = lines[r].split(",");
    const num = (i) => {
      if (i < 0 || i >= f.length) return null;
      const s = f[i].trim();
      if (!s) return null;
      const v = Number(s);
      return Number.isFinite(v) ? v : null;
    };
    const ts = num(iTs);
    const lat = num(iLat);
    const lon = num(iLon);
    if (ts == null || lat == null || lon == null) continue;
    if (lat === 0 && lon === 0) continue; // no GPS fix
    if (ts0 == null) ts0 = ts;
    const t = (ts - ts0) / 1000;
    if (rows.length && t <= rows[rows.length - 1].t) continue; // duplicate or out-of-order row
    rows.push({ t, lat, lon, num });
  }
  if (rows.length < 10) throw new Error("Track Precision CSV contains no usable GPS data");

  const points = rows.map(({ t, lat, lon }) => ({ t, lat, lon }));
  const trace = projectTrace(points, points[0]);
  const k = iSpeed >= 0 ? speedToMs(trace, rows.map((r) => r.num(iSpeed))) : null;

  const lapRows = [];
  const car = Object.fromEntries(carCols.map((c) => [c.name, []]));
  const throttle = [];
  const brake = [];
  const tires = Object.fromEntries(tyreCols.map((c) => [c.name, []]));
  const iRpm = carCols.find((c) => c.name === "rpm")?.i ?? -1;
  for (let r = 0; r < rows.length; r++) {
    const { t, num } = rows[r];
    const speed = k == null ? null : num(iSpeed);
    const v = speed == null ? null : speed * k;
    if (v != null) points[r].v = v;
    lapRows.push({ t, lapMs: num(iLap), lapM: num(iLapM), v });
    if (iRpm >= 0 && carSilent(num(iRpm), v)) continue;
    for (const c of carCols) {
      const x = num(c.i);
      if (x != null) car[c.name].push({ t, v: c.f(x) });
    }
    const th = num(iThrottle);
    if (th != null) throttle.push({ t, v: th });
    const br = num(iBrake);
    if (br != null) brake.push({ t, v: Math.max(0, br) });
    for (const c of tyreCols) {
      const x = num(c.i);
      if (x != null && x > 0 && x < MAX_TYRE_BAR) tires[c.name].push({ t, v: x * 100 });
    }
  }

  const { carChannels, lapScalarChannels, sessionMeta } = finishCarChannels({
    car,
    throttle,
    brake,
    tires,
    heights: [],
  });

  const laps = iLap >= 0 ? lapsFromLaptime(lapRows) : [];
  let bestLapTrace = null;
  if (laps.length) {
    const best = laps.reduce((a, b) => (b.timeMs < a.timeMs ? b : a));
    bestLapTrace = lapTrace(projectTrace(points), best.startT, best.endT);
  }

  // The name's date and time are the recording's own, in local time; the
  // UTC timestamp is the fallback, which can land on the neighbouring day.
  const d0 = new Date(ts0);
  const date =
    dateFromName(fileName) ?? `${d0.getUTCFullYear()}-${pad2(d0.getUTCMonth() + 1)}-${pad2(d0.getUTCDate())}`;
  const time =
    timeFromName(fileName) ?? `${pad2(d0.getUTCHours())}:${pad2(d0.getUTCMinutes())}:${pad2(d0.getUTCSeconds())}`;

  return {
    kind: "trackprecision",
    date,
    time,
    durationS: points[points.length - 1].t,
    laps,
    bestLapTrace,
    gps: points,
    carChannels,
    lapScalarChannels,
    sessionMeta,
    needsLine: laps.length === 0,
  };
}

export async function parseTrackPrecisionCsvFile(fileBlob) {
  return parseTrackPrecisionCsv(await fileBlob.text(), fileBlob.name ?? null);
}
