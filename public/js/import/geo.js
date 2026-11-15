// GPS trace geometry: project lat/lon traces to local meters and derive lap
// times from start/finish line crossings. Pure functions, unit-tested.
//
// Sign conventions don't matter (e.g. Racelogic's west-positive longitude):
// everything is relative geometry within one import, so as long as a file is
// self-consistent, projection + crossing detection work unchanged.

// points: [{t: seconds, lat, lon, v?}] in decimal degrees.
// origin: optional {lat, lon} so multiple files share one coordinate frame.
// Returns [{t, x, y, v?}] in meters (equirectangular, fine at track scale).
export function projectTrace(points, origin = points[0]) {
  const kx = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  const ky = 110540;
  return points.map((p) => ({
    t: p.t,
    x: (p.lon - origin.lon) * kx,
    y: (p.lat - origin.lat) * ky,
    v: p.v,
  }));
}

// Build a start/finish gate from a picked point on a projected trace: a
// segment through trace[idx], perpendicular to the direction of travel there.
// Returns null if the local heading is degenerate (car not moving).
export function buildGate(trace, idx, halfWidth = 20) {
  const p = trace[idx];
  // heading from a window around the point, widening until it's meaningful
  for (let w = 3; w <= 24; w *= 2) {
    const a = trace[Math.max(0, idx - w)];
    const b = trace[Math.min(trace.length - 1, idx + w)];
    const hx = b.x - a.x;
    const hy = b.y - a.y;
    const len = Math.hypot(hx, hy);
    if (len < 2) continue;
    const ux = hx / len;
    const uy = hy / len;
    const px = -uy; // unit perpendicular
    const py = ux;
    return {
      x: p.x,
      y: p.y,
      hx: ux,
      hy: uy,
      x1: p.x - px * halfWidth,
      y1: p.y - py * halfWidth,
      x2: p.x + px * halfWidth,
      y2: p.y + py * halfWidth,
    };
  }
  return null;
}

// A gate from two explicit endpoints (e.g. a VBO [laptiming] start line).
// No heading: crossings in either direction count.
export function gateFromSegment(p1, p2) {
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, hx: null, hy: null, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}

// Times (seconds) at which the trace crosses the gate segment, interpolated
// within the trace segment that crosses. Direction-filtered when the gate has
// a heading; crossings closer than minGapS apart are treated as GPS jitter.
export function gateCrossings(trace, gate, { minGapS = 5 } = {}) {
  const gx = gate.x2 - gate.x1;
  const gy = gate.y2 - gate.y1;
  const out = [];
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1];
    const b = trace[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (gate.hx != null && dx * gate.hx + dy * gate.hy <= 0) continue;
    const denom = dx * gy - dy * gx;
    if (denom === 0) continue;
    // a + s*(b-a) intersects gate.p1 + u*(p2-p1) with s,u in [0,1]
    const wx = gate.x1 - a.x;
    const wy = gate.y1 - a.y;
    const s = (wx * gy - wy * gx) / denom;
    const u = (wx * dy - wy * dx) / denom;
    if (s < 0 || s > 1 || u < 0 || u > 1) continue;
    const t = a.t + s * (b.t - a.t);
    if (out.length && t - out[out.length - 1] < minGapS) continue;
    out.push(t);
  }
  return out;
}

// Laps between consecutive crossings. Deltas outside [minLapS, maxLapS] are
// dropped (jitter double-counts and pit stops / sessions gaps aren't laps).
// GPS-derived timing is interpolation between fixes, so laps are `estimated`.
// startT/endT (trace clock) let per-lap channel data be cut from the same
// telemetry (js/import/channels.js).
export function lapsFromCrossings(crossings, { minLapS = 30, maxLapS = 3600 } = {}) {
  const laps = [];
  for (let i = 1; i < crossings.length; i++) {
    const s = crossings[i] - crossings[i - 1];
    if (s < minLapS || s > maxLapS) continue;
    laps.push({ timeMs: Math.round(s * 1000), estimated: true, startT: crossings[i - 1], endT: crossings[i] });
  }
  return laps;
}

export function deriveLaps(trace, gate, opts = {}) {
  return lapsFromCrossings(gateCrossings(trace, gate, opts), opts);
}

// --- best-lap trace extraction ------------------------------------------------
// A downsampled [x, y, v] polyline of the fastest lap, stored with the session
// and rendered as the speed-painted racing line on the event page.

// Slice a projected trace to [t0, t1] and downsample to at most `max` points.
// Speed comes from the source when present, else distance/time to the next
// fix — the renderer only uses it relatively, so units don't matter.
// Returns null when the window holds too few points to draw a line.
export function lapTrace(trace, t0, t1, max = 300) {
  const pts = trace.filter((p) => p.t >= t0 && p.t <= t1);
  if (pts.length < 10) return null;
  const speedAt = (i) => {
    if (pts[i].v != null && Number.isFinite(pts[i].v)) return pts[i].v;
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dt = b.t - a.t;
    return dt > 0 ? Math.hypot(b.x - a.x, b.y - a.y) / dt : 0;
  };
  const step = Math.max(1, Math.ceil(pts.length / max));
  const out = [];
  for (let i = 0; i < pts.length; i += step) {
    out.push([Math.round(pts[i].x * 10) / 10, Math.round(pts[i].y * 10) / 10, Math.round(speedAt(i) * 100) / 100]);
  }
  const lastIdx = pts.length - 1;
  if ((lastIdx % step) !== 0) {
    out.push([Math.round(pts[lastIdx].x * 10) / 10, Math.round(pts[lastIdx].y * 10) / 10, Math.round(speedAt(lastIdx) * 100) / 100]);
  }
  return out;
}

// The fastest valid lap's trace, from the same gate crossings that timed the
// laps (same jitter/min/max filtering as lapsFromCrossings).
export function bestLapTrace(trace, gate, opts = {}) {
  const { minLapS = 30, maxLapS = 3600 } = opts;
  const crossings = gateCrossings(trace, gate, opts);
  let best = null;
  for (let i = 1; i < crossings.length; i++) {
    const s = crossings[i] - crossings[i - 1];
    if (s < minLapS || s > maxLapS) continue;
    if (!best || s < best.s) best = { s, t0: crossings[i - 1], t1: crossings[i] };
  }
  return best ? lapTrace(trace, best.t0, best.t1) : null;
}

// --- where a trace lies on Earth (NS-53) --------------------------------------
// A stored trace is local metres from the origin projectTrace was given, and
// that origin is saved beside it as the session's `trace_geo`. These are the
// pure half of drawing the line on a real map: the anchor a save sends, the
// way back to degrees, and what a map view needs to fit, hit-test and colour
// the line. Ported as the same names to `Geo` in the iOS Kit and `GeoTrace` in
// Android's :core, pinned by contracts/logic/geo-anchor.json. The server's
// half (validation, and lending an anchor to an older trace) is
// src/lib/geo.ts, which restates KX / KY.

// projectTrace's constants. **The inverse must use the same two numbers** —
// they are approximations, but the projection is then its own exact inverse.
export const KY = 110540;
export const KX = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

const round7 = (v) => Math.round(v * 1e7) / 1e7;

// The anchor to save with a trace: the origin its points were projected from
// — `gps[0]` unless projectTrace was handed another. Null for anything that
// isn't a real coordinate ((0, 0) is a GPS with no fix), so a save sends null
// rather than a place the line never was.
export function traceOrigin(gps, origin = gps?.[0]) {
  const lat = origin?.lat;
  const lon = origin?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
  if (Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01) return null;
  return { lat: round7(lat), lon: round7(lon) };
}

// A stored [x, y, v] trace back to degrees: [{lat, lon, v}].
export function unprojectTrace(trace, geo) {
  const kx = KX(geo.lat);
  return trace.map((p) => ({ lat: geo.lat + p[1] / KY, lon: geo.lon + p[0] / kx, v: p[2] ?? 0 }));
}

// The trace's bounding box in degrees — what a map's first camera fits.
export function traceGeoBounds(trace, geo) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of trace) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  if (!Number.isFinite(x0)) return null;
  const kx = KX(geo.lat);
  return {
    south: geo.lat + y0 / KY,
    west: geo.lon + x0 / kx,
    north: geo.lat + y1 / KY,
    east: geo.lon + x1 / kx,
  };
}

// The point on the line nearest (x, y), all in the trace's metres — a tap's
// hit test. `idx` is the nearer end of the segment hit, `alongM` the driven
// distance to the nearest point, `frac` that as a fraction of the trace's
// length (by cumulative chord length, the traceIndexAtFraction rule: a trace
// is denser where the car was slower, so an index is not a place), `offM` how
// far the tap was from the line. Null when nothing is within `maxM`. Ties keep
// the earlier segment.
export function nearestOnTrace(trace, x, y, maxM = Infinity) {
  if (!Array.isArray(trace) || trace.length < 2) return null;
  let best = null;
  let cum = 0;
  for (let i = 0; i < trace.length - 1; i++) {
    const ax = trace[i][0], ay = trace[i][1];
    const dx = trace[i + 1][0] - ax, dy = trace[i + 1][1] - ay;
    const len = Math.hypot(dx, dy);
    const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (len * len))) : 0;
    const offM = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
    if (!best || offM < best.offM) best = { idx: t < 0.5 ? i : i + 1, alongM: cum + len * t, offM };
    cum += len;
  }
  if (!(cum > 0) || best.offM > maxM) return null;
  return { idx: best.idx, frac: best.alongM / cum, alongM: best.alongM, offM: best.offM };
}

// The line cut into runs of one speed colour: [{from, to, bucket}], point
// indexes inclusive, `bucket` 0 (slowest) … buckets − 1. Speed is normalised
// over the trace's own range, as the drawn track map does, and a segment takes
// the bucket of the point it starts at. A map SDK that strokes a polyline in
// one colour draws one overlay per run; the others build gradient stops from
// the same runs, so every client colours the same metres the same.
export function speedRuns(trace, buckets = 16) {
  if (!Array.isArray(trace) || trace.length < 2) return [];
  let vMin = Infinity, vMax = -Infinity;
  for (const p of trace) {
    const v = p[2] ?? 0;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  const bucketAt = (i) => {
    if (!(vMax > vMin)) return Math.floor(buckets / 2);
    return Math.min(buckets - 1, Math.floor((((trace[i][2] ?? 0) - vMin) / (vMax - vMin)) * buckets));
  };
  const runs = [];
  for (let i = 0; i < trace.length - 1; i++) {
    const bucket = bucketAt(i);
    const last = runs[runs.length - 1];
    if (last && last.bucket === bucket) last.to = i + 1;
    else runs.push({ from: i, to: i + 1, bucket });
  }
  return runs;
}
