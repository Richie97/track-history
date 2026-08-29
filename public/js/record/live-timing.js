// Live lap timing for the GPS lap recorder: lap counts, lap times and a
// predictive delta while the car is still on track — before the review
// screen's line picker has ever run. Like the rest of js/record/, this is a
// reference implementation, not app code: the recorder is native-only and
// nothing under public/ imports this module. Pure incremental logic (fix in →
// display out), so it unit-tests in Node and ports to Swift/Kotlin function-
// for-function; the fixture in contracts/logic/live-timing.json pins the
// ports to this file per fix.
//
// The recorder doesn't know the start/finish line during a session (the user
// picks it at review time), so live timing anchors its own gate: the first
// fix at track pace — in practice the pit exit, which is on the racing line,
// so the car re-crosses it every lap. Crossings of that gate time the laps
// (same intersection math as js/import/geo.js, direction-filtered). Times
// shown live are therefore "unofficial": the saved laps still come from the
// review line pick, and the two gates differ by a constant offset that
// cancels out of every lap time except the out-lap's.
//
// The predictive delta compares the running lap against the best completed
// lap by distance driven: at d meters into the current lap, how far ahead or
// behind the best lap's clock at d meters are we? Positive = slower.
//
// Fixes arrive as the recording's accepted tuples ([tRelS, lat, lon, v, acc],
// see core.js addFix) — feed every kept fix, in order. Recovery after a
// process death is a replay: liveTimingFromFixes(rec.fixes).

// Track pace: the gate anchors at the first fix at/above this speed (m/s).
// Matches DRIVEN_MPS in core.js — the same "the car is really driving" line.
export const ARM_MPS = 15;
// Gate half-width in meters, same as the review line picker's default
// (buildGate in js/import/geo.js): generous enough for line variation,
// narrow enough not to catch a parallel straight.
export const GATE_HALF_WIDTH_M = 20;
// Same lap-plausibility window as lapsFromCrossings.
export const MIN_LAP_S = 30;
export const MAX_LAP_S = 3600;
// Crossings closer than this are GPS jitter, as in gateCrossings.
export const MIN_CROSS_GAP_S = 5;
// The gate needs a real heading: the anchor fix must be at least this far
// (meters) from the previous fix.
export const MIN_HEADING_M = 2;

export function createLiveTiming() {
  return {
    origin: null, // {lat, lon, kx, ky} — first fix, equirectangular scale
    prev: null, // last projected fix {t, x, y}
    gate: null, // {x1, y1, x2, y2, hx, hy} — anchored at track pace
    lastCrossT: null, // for MIN_CROSS_GAP_S
    lapStartT: null, // gate-crossing time the running lap started at
    lapCount: 0, // completed, plausible laps
    lastLapMs: null,
    bestLapMs: null,
    // Best completed lap as parallel arrays: cumulative meters + seconds
    // since its lap start. The delta interpolates time-at-distance in it.
    best: null, // {dist: [], time: []}
    // The running lap's samples, promoted to `best` if it completes fastest.
    cur: null, // {dist: [], time: [], d}
    deltaS: null, // current predictive delta, null before it means anything
  };
}

// Project a fix into the session's local meter frame (same equirectangular
// approximation as js/import/geo.js projectTrace).
function project(lt, f) {
  if (!lt.origin) {
    lt.origin = {
      lat: f[1],
      lon: f[2],
      kx: 111320 * Math.cos((f[1] * Math.PI) / 180),
      ky: 110540,
    };
  }
  return {
    t: f[0],
    x: (f[2] - lt.origin.lon) * lt.origin.kx,
    y: (f[1] - lt.origin.lat) * lt.origin.ky,
  };
}

// Where (in time) the segment a→b crosses the gate, or null. Direction-
// filtered by the gate heading — the same rule as gateCrossings in geo.js.
function crossingT(gate, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx * gate.hx + dy * gate.hy <= 0) return null;
  const gx = gate.x2 - gate.x1;
  const gy = gate.y2 - gate.y1;
  const denom = dx * gy - dy * gx;
  if (denom === 0) return null;
  const wx = gate.x1 - a.x;
  const wy = gate.y1 - a.y;
  const s = (wx * gy - wy * gx) / denom;
  const u = (wx * dy - wy * dx) / denom;
  if (s < 0 || s > 1 || u < 0 || u > 1) return null;
  return a.t + s * (b.t - a.t);
}

// Time at `d` meters into the best lap, linearly interpolated; null outside
// the sampled range (the current lap has driven farther than the best did).
function bestTimeAt(best, d) {
  const { dist, time } = best;
  if (!dist.length || d < dist[0] || d > dist[dist.length - 1]) return null;
  let lo = 0;
  let hi = dist.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] <= d) lo = mid;
    else hi = mid;
  }
  const span = dist[hi] - dist[lo];
  const f = span > 0 ? (d - dist[lo]) / span : 0;
  return time[lo] + f * (time[hi] - time[lo]);
}

// Feed one accepted fix tuple ([tRelS, lat, lon, v|null, acc|null]). Mutates
// and returns the state. Call in fix order — out-of-order fixes never get
// here (addFix drops them).
export function addTimingFix(lt, f) {
  const p = project(lt, f);
  const prev = lt.prev;
  lt.prev = p;
  if (!prev) return lt;

  // Anchor the gate at the first track-pace fix with a usable heading.
  if (!lt.gate) {
    const v = f[3];
    if (v != null && v >= ARM_MPS) {
      const hx = p.x - prev.x;
      const hy = p.y - prev.y;
      const len = Math.hypot(hx, hy);
      if (len >= MIN_HEADING_M) {
        const ux = hx / len;
        const uy = hy / len;
        lt.gate = {
          hx: ux,
          hy: uy,
          x1: p.x + uy * GATE_HALF_WIDTH_M,
          y1: p.y - ux * GATE_HALF_WIDTH_M,
          x2: p.x - uy * GATE_HALF_WIDTH_M,
          y2: p.y + ux * GATE_HALF_WIDTH_M,
        };
        // Timing starts here, explicitly: the anchor fix sits exactly on the
        // gate, so whether the next segment registers a crossing would be
        // floating-point luck otherwise. Lap 1 is therefore the out lap from
        // this point around to it again — slow, but a real circuit.
        lt.lastCrossT = p.t;
        lt.lapStartT = p.t;
        lt.cur = { dist: [], time: [], d: 0 };
      }
    }
    return lt;
  }

  // Advance the running lap by this segment.
  if (lt.cur) {
    lt.cur.d += Math.hypot(p.x - prev.x, p.y - prev.y);
    lt.cur.dist.push(lt.cur.d);
    lt.cur.time.push(p.t - lt.lapStartT);
    lt.deltaS = lt.best ? diffOrNull(p.t - lt.lapStartT, bestTimeAt(lt.best, lt.cur.d)) : null;
  }

  const tc = crossingT(lt.gate, prev, p);
  if (tc == null) return lt;
  if (lt.lastCrossT != null && tc - lt.lastCrossT < MIN_CROSS_GAP_S) return lt;
  lt.lastCrossT = tc;

  if (lt.lapStartT != null) {
    const lapS = tc - lt.lapStartT;
    if (lapS >= MIN_LAP_S && lapS <= MAX_LAP_S) {
      lt.lapCount += 1;
      lt.lastLapMs = Math.round(lapS * 1000);
      if (lt.bestLapMs == null || lt.lastLapMs < lt.bestLapMs) {
        lt.bestLapMs = lt.lastLapMs;
        lt.best = { dist: lt.cur.dist, time: lt.cur.time };
      }
    }
    // Out of the plausible window (a pit stop, a red flag): not a lap, but
    // the crossing still starts a fresh one.
  }
  lt.lapStartT = tc;
  lt.cur = { dist: [], time: [], d: 0 };
  lt.deltaS = null;
  return lt;
}

function diffOrNull(t, ref) {
  return ref == null ? null : t - ref;
}

// Replay a whole recording's fix list (recovery after a process death, or a
// late-armed display). Same result as feeding the fixes one at a time.
export function liveTimingFromFixes(fixes) {
  const lt = createLiveTiming();
  for (const f of fixes) addTimingFix(lt, f);
  return lt;
}

// What a record screen shows. nowS is the current recording clock (seconds
// on the same axis as the fixes' tRelS) for the running lap readout.
export function liveTimingDisplay(lt, nowS) {
  return {
    lapCount: lt.lapCount,
    // Null until the car has hit track pace and armed the gate — the display
    // can say "waiting for track pace" while this is null.
    currentLapS: lt.lapStartT != null ? Math.max(0, nowS - lt.lapStartT) : null,
    lastLapMs: lt.lastLapMs,
    bestLapMs: lt.bestLapMs,
    deltaS: lt.deltaS,
  };
}
