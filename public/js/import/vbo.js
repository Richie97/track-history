// Racelogic .vbo parser. Plain ASCII: an optional "File created ..." line,
// [section] blocks — [column names] for the data layout, [laptiming] for the
// start/finish line, [data] for the samples. Written by VBOX hardware and by
// RaceChrono / TrackAddict / Harry's LapTimer / Porsche Track Precision
// exports.
//
// Two layouts of [column names] exist in the wild: VBOX hardware writes every
// name on one line separated by spaces; Porsche's Track Precision App writes
// one name per line, and its names contain spaces ("steering wheel angle").
// A section of more than one line is read as one name per line.
//
// Coordinates are in minutes (degrees * 60) and Racelogic longitude is
// west-positive, so it is negated here into the usual east-positive degrees
// every other source uses — otherwise the stored racing line draws mirrored.
// An exporter that ignores the convention still times correctly (lap
// derivation is geometry within the file) and the line picker's mirroring
// fallback (applyGate in ui.js) still matches it to a batch-mate.

import { gateCrossings, gateFromSegment, lapTrace, lapsFromCrossings, projectTrace } from "./geo.js";

// "095512.30" (time-of-day) -> seconds
function timeOfDayS(s) {
  const m = /^(\d{2})(\d{2})(\d{2}(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// Car channels, by [column names] entry -> channels.js name. The first name
// present wins, so Porsche's `LatAcc_PTPA` (true G) is preferred over its
// `latacc` column, which despite a "latAccel g" header holds G / 9.81.
// `f` converts to the stored unit (see CHANNEL_NAMES in channels.js).
const CAR_COLUMNS = [
  ["rpm", ["engine", "rpm", "engine speed", "enginespeed"], (v) => v],
  ["latG", ["latacc_ptpa", "latacc", "lat_acc", "latg"], (v) => Math.abs(v)], // stored as a magnitude, like PDR
  ["longG", ["longacc_ptpa", "longacc", "long_acc", "longg"], (v) => v],
  ["steering", ["steering wheel angle", "steering", "steer", "steering angle"], (v) => v],
  ["gear", ["current gear", "gear"], (v) => (v >= 1 && v <= 8 ? Math.round(v) : 0)],
  ["yaw", ["yaw", "yaw rate", "yawrate"], (v) => v],
];

// Throttle is a pedal position; exporters write it as a 0-1 fraction or a
// percentage, decided per file by the column's own peak.
const THROTTLE_COLUMNS = ["pedal", "throttle", "throttle position", "accelerator"];

// Brake is a *pressure* in these files (bar), not a pedal position. Stored as
// a percentage of the file's own peak, so the trace keeps its shape on the
// 0-100 brake axis PDR's pedal position uses.
const BRAKE_COLUMNS = ["braking", "brake", "brake pressure", "braking pressure"];

// Tyre pressures, bar -> kPa, one reading per lap (the lap-end value).
const TYRE_COLUMNS = [
  ["tyreKpaLF", "tire pressure front left"],
  ["tyreKpaRF", "tire pressure front right"],
  ["tyreKpaLR", "tire pressure rear left"],
  ["tyreKpaRR", "tire pressure rear right"],
];
// Track Precision writes 3276.8 (0x7FFF / 10) when the car sent no reading.
const MAX_TYRE_BAR = 10;

// A column that never changes (Track Precision writes every column it knows,
// zeroed when the car doesn't report it) is no channel at all.
function varies(pts) {
  for (let i = 1; i < pts.length; i++) if (pts[i].v !== pts[0].v) return true;
  return false;
}

// "recording-2026-06-06-09-53-45.vbo" -> "2026-06-06". Track Precision's
// "File created at" line is the *export* time, so the name is the better
// source for the session's date when it carries one.
function dateFromName(name) {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(name ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// The line a file carries can be short — Track Precision's is ~15 m and sits
// mostly to one side of the racing line, so a lap driven a metre or two wide
// misses its end and is never timed. Stretch it about its own midpoint to at
// least MIN_GATE_HALF_M either side (the width of a hand-picked gate,
// buildGate in geo.js), keeping its angle, and give it the direction of
// travel where the trace passes closest, so the wider line can't also count
// a nearby stretch of track driven the other way.
const MIN_GATE_HALF_M = 20;

function widenGate(gate, trace) {
  const dx = gate.x2 - gate.x1;
  const dy = gate.y2 - gate.y1;
  const len = Math.hypot(dx, dy);
  if (!len) return gate;
  const half = Math.max(len / 2, MIN_GATE_HALF_M);
  const ux = dx / len;
  const uy = dy / len;
  let k = 0;
  let best = Infinity;
  for (let i = 0; i < trace.length; i++) {
    const d = (trace[i].x - gate.x) ** 2 + (trace[i].y - gate.y) ** 2;
    if (d < best) [best, k] = [d, i];
  }
  const a = trace[Math.max(0, k - 2)];
  const b = trace[Math.min(trace.length - 1, k + 2)];
  const moving = Math.hypot(b.x - a.x, b.y - a.y) > 1;
  return {
    x: gate.x,
    y: gate.y,
    hx: moving ? b.x - a.x : null,
    hy: moving ? b.y - a.y : null,
    x1: gate.x - ux * half,
    y1: gate.y - uy * half,
    x2: gate.x + ux * half,
    y2: gate.y + uy * half,
  };
}

// Track Precision starts and stops recording *at* the start/finish line, so
// the first fix sits a few metres past it and the last a few metres short:
// the line is never seen crossed at either end, and the first and last
// flying laps would be lost. A fix within EDGE_M of the line (well under a
// second at track pace), inside its width and moving through it, gets a
// crossing extrapolated at its own speed — estimated, like every GPS lap.
const EDGE_M = 30;

function edgeCrossings(trace, gate) {
  const crossings = gateCrossings(trace, gate);
  if (gate.hx == null || trace.length < 2) return crossings;
  const gx = gate.x2 - gate.x1;
  const gy = gate.y2 - gate.y1;
  const half = Math.hypot(gx, gy) / 2;
  const ux = gx / (2 * half);
  const uy = gy / (2 * half);
  // unit normal pointing the way the car crosses
  let nx = -uy;
  let ny = ux;
  if (nx * gate.hx + ny * gate.hy < 0) [nx, ny] = [-nx, -ny];
  const speed = (i, j) => {
    const v = trace[i].v;
    if (v != null && Number.isFinite(v)) return v;
    const dt = Math.abs(trace[j].t - trace[i].t);
    return dt ? Math.hypot(trace[j].x - trace[i].x, trace[j].y - trace[i].y) / dt : 0;
  };
  const at = (i, j) => {
    const p = trace[i];
    const along = (p.x - gate.x) * ux + (p.y - gate.y) * uy;
    const past = (p.x - gate.x) * nx + (p.y - gate.y) * ny;
    const v = speed(i, j);
    return Math.abs(along) <= half && v > 5 ? { past, v } : null;
  };
  const first = at(0, 1);
  if (first && first.past > 0 && first.past < EDGE_M) crossings.unshift(trace[0].t - first.past / first.v);
  const n = trace.length - 1;
  const last = at(n, n - 1);
  if (last && last.past < 0 && -last.past < EDGE_M) crossings.push(trace[n].t - last.past / last.v);
  return crossings;
}

export function parseVboText(text, fileName = null) {
  const lines = text.split(/\r?\n/);

  let date = dateFromName(fileName);
  let time = null;
  // VBOX: "File created on 20/06/2026 at 09:15:00" — the recording's own
  // start, so its time is used as well as its date.
  const created = /created on (\d{2})\/(\d{2})\/(\d{4})(?: at| @)? (\d{2}):(\d{2})(?::(\d{2}))?/i.exec(
    lines[0] ?? ""
  );
  if (created) {
    date ??= `${created[3]}-${created[2]}-${created[1]}`;
    time = `${created[4]}:${created[5]}:${created[6] ?? "00"}`;
  }
  // Track Precision: "File created at 2026-09-22 21:59:37 -0600" — when it
  // was exported, so only a last resort for the date and never the time.
  const exported = /created at (\d{4})-(\d{2})-(\d{2})/i.exec(lines[0] ?? "");
  if (exported) date ??= `${exported[1]}-${exported[2]}-${exported[3]}`;

  // Collect sections.
  const sections = {};
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      current = sec[1].toLowerCase();
      sections[current] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }

  const nameLines = sections["column names"] ?? [];
  const colNames = (nameLines.length > 1 ? nameLines : (nameLines[0] ?? "").split(/\s+/))
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  if (!colNames.length) throw new Error("Not a valid VBO file (no [column names] section)");
  const col = (name) => colNames.indexOf(name);
  const firstCol = (names) => names.map(col).find((i) => i >= 0) ?? -1;
  const iTime = col("time");
  const iLat = col("lat");
  const iLon = col("long");
  const iVel = firstCol(["velocity", "speed"]);
  if (iTime < 0 || iLat < 0 || iLon < 0) {
    throw new Error("VBO file is missing time/lat/long columns");
  }
  // gps.v is m/s across all parsers (channels.js depends on it). The [header]
  // section names the velocity unit — "velocity kmh" in VBOX files and the
  // common exporters; handle mph/knots variants, default km/h.
  const velLine = (sections["header"] ?? []).find((l) => /^velocity\b/i.test(l)) ?? "";
  const velToMs = /mph/i.test(velLine) ? 0.44704 : /kts|knots/i.test(velLine) ? 0.514444 : 1 / 3.6;

  const iHeight = firstCol(["height", "alt", "altitude"]);
  const carCols = CAR_COLUMNS.map(([name, names, f]) => ({ name, i: firstCol(names), f })).filter((c) => c.i >= 0);
  const iThrottle = firstCol(THROTTLE_COLUMNS);
  const iBrake = firstCol(BRAKE_COLUMNS);
  const tyreCols = TYRE_COLUMNS.map(([name, n]) => ({ name, i: col(n) })).filter((c) => c.i >= 0);

  // Data rows -> GPS points (+ car channels on the same clock). VBO
  // coordinates are minutes -> /60 to degrees. The time column is a
  // time-of-day; make t relative to the first sample (handling a midnight
  // wrap).
  const points = [];
  const car = Object.fromEntries(carCols.map((c) => [c.name, []]));
  const throttle = [];
  const brake = [];
  const tyres = Object.fromEntries(tyreCols.map((c) => [c.name, []]));
  const heights = [];
  let t0 = null;
  for (const row of sections["data"] ?? []) {
    const f = row.split(/\s+/);
    if (f.length < colNames.length) continue;
    const tod = timeOfDayS(f[iTime]);
    const lat = Number(f[iLat]);
    const lon = Number(f[iLon]);
    if (tod == null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat === 0 && lon === 0) continue; // no GPS fix
    if (t0 == null) t0 = tod;
    let t = tod - t0;
    if (t < 0) t += 86400;
    points.push({ t, lat: lat / 60, lon: -lon / 60, v: iVel >= 0 ? Number(f[iVel]) * velToMs : undefined });

    const num = (i) => {
      const v = Number(f[i]);
      return Number.isFinite(v) ? v : null;
    };
    for (const c of carCols) {
      const v = num(c.i);
      if (v != null) car[c.name].push({ t, v: c.f(v) });
    }
    if (iThrottle >= 0) {
      const v = num(iThrottle);
      if (v != null) throttle.push({ t, v });
    }
    if (iBrake >= 0) {
      const v = num(iBrake);
      if (v != null) brake.push({ t, v: Math.max(0, v) });
    }
    for (const c of tyreCols) {
      const v = num(c.i);
      if (v != null && v > 0 && v < MAX_TYRE_BAR) tyres[c.name].push({ t, v: v * 100 });
    }
    if (iHeight >= 0) {
      const v = num(iHeight);
      if (v != null) heights.push(v);
    }
  }
  if (points.length < 10) throw new Error("VBO file contains no usable GPS data");

  if (!time && t0 != null) {
    const h = Math.floor(t0 / 3600);
    const mi = Math.floor((t0 % 3600) / 60);
    const se = Math.floor(t0 % 60);
    time = `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(se).padStart(2, "0")}`;
  }

  const carChannels = {};
  for (const [name, pts] of Object.entries(car)) if (pts.length >= 10 && varies(pts)) carChannels[name] = pts;
  if (throttle.length >= 10 && varies(throttle)) {
    const peak = Math.max(...throttle.map((p) => p.v));
    const scale = peak <= 1.0001 ? 100 : 1;
    carChannels.throttle = throttle.map((p) => ({ t: p.t, v: Math.min(100, Math.max(0, p.v * scale)) }));
  }
  if (brake.length >= 10 && varies(brake)) {
    const peak = Math.max(...brake.map((p) => p.v));
    carChannels.brake = brake.map((p) => ({ t: p.t, v: (p.v / peak) * 100 }));
  }
  const lapScalarChannels = {};
  for (const [name, pts] of Object.entries(tyres)) if (pts.length >= 10) lapScalarChannels[name] = pts;
  const sessionMeta =
    heights.length > 10 ? { elevationM: Math.max(...heights) - Math.min(...heights) } : null;

  // [laptiming]: "Start <lon1> <lat1> <lon2> <lat2>" (minutes, two endpoints
  // of the start/finish line) per Racelogic, though some exporters write
  // latitude first. Both readings are tried and the one lying on the driven
  // trace is kept. If present, laps come for free.
  let laps = [];
  let lapTracePts = null;
  const startLine = (sections["laptiming"] ?? []).find((l) => /^start\s/i.test(l));
  if (startLine) {
    const n = startLine.split(/\s+/).slice(1, 5).map(Number);
    if (n.length === 4 && n.every(Number.isFinite)) {
      const origin = points[0];
      const trace = projectTrace(points, origin);
      const endpoints = (lonFirst) =>
        projectTrace(
          lonFirst
            ? [{ t: 0, lat: n[1] / 60, lon: -n[0] / 60 }, { t: 0, lat: n[3] / 60, lon: -n[2] / 60 }]
            : [{ t: 0, lat: n[0] / 60, lon: -n[1] / 60 }, { t: 0, lat: n[2] / 60, lon: -n[3] / 60 }],
          origin
        );
      const nearest = ([a, b]) => {
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        let best = Infinity;
        for (const p of trace) best = Math.min(best, (p.x - mx) ** 2 + (p.y - my) ** 2);
        return best;
      };
      const lonFirst = endpoints(true);
      const latFirst = endpoints(false);
      const [end1, end2] = nearest(lonFirst) <= nearest(latFirst) ? lonFirst : latFirst;
      const gate = widenGate(gateFromSegment(end1, end2), trace);
      laps = lapsFromCrossings(edgeCrossings(trace, gate));
      if (laps.length) {
        const best = laps.reduce((a, b) => (b.timeMs < a.timeMs ? b : a));
        lapTracePts = lapTrace(trace, best.startT, best.endT);
      }
    }
  }

  return {
    kind: "vbo",
    date,
    time,
    durationS: points[points.length - 1].t,
    laps,
    bestLapTrace: lapTracePts,
    gps: points,
    carChannels,
    lapScalarChannels,
    sessionMeta,
    // A [laptiming] line that yields no laps (wrong circuit, odd layout)
    // falls back to manual line picking.
    needsLine: laps.length === 0,
  };
}

export async function parseVboFile(fileBlob) {
  return parseVboText(await fileBlob.text(), fileBlob.name ?? null);
}
