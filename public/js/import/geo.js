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
export function lapsFromCrossings(crossings, { minLapS = 30, maxLapS = 3600 } = {}) {
  const laps = [];
  for (let i = 1; i < crossings.length; i++) {
    const s = crossings[i] - crossings[i - 1];
    if (s < minLapS || s > maxLapS) continue;
    laps.push({ timeMs: Math.round(s * 1000), estimated: true });
  }
  return laps;
}

export function deriveLaps(trace, gate, opts = {}) {
  return lapsFromCrossings(gateCrossings(trace, gate, opts), opts);
}
