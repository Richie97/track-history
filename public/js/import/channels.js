// Per-lap channel data for imported telemetry sessions: each lap's speed
// (and, for PDR, RPM and lateral G) resampled onto a uniform driven-distance
// grid, so laps overlay corner-for-corner in the channel graphs regardless of
// lap time. Built at import time — telemetry files never leave the browser,
// so anything to graph later must be derived here and stored with the
// session. Pure functions, unit-tested.
//
// Stored shape (sessions.channels, sanitized server-side in
// src/lib/validate.ts — keep the two in sync):
//   { v: 1, dStepM, laps: [{ n, timeMs, speed: [...], rpm?: [...], latG?: [...] }] }
// Arrays hold one value per grid point at d = 0, dStepM, 2*dStepM… from the
// lap's start. speed is km/h, latG is G.

import { series } from "../../pdr.js";
import { projectTrace } from "./geo.js";

export const D_STEP_M = 20;      // grid spacing: ~100-600 points for real laps
export const MAX_LAP_POINTS = 700; // guards degenerate "laps" (also capped server-side)
// Mirror sanitizeChannels' budget (src/lib/validate.ts): rather than have the
// server reject a whole session over its optional graph data, an outsized
// session (marathon enduro) simply stores no channels.
export const MAX_LAPS = 80;
export const MAX_TOTAL_VALUES = 60000;

const round = (v, f) => Math.round(v * f) / f;

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

// Channel sources for a GPS-only import (GoPro, plain VBO/FIT, beacon-less
// PDR via the line picker): distance integrated from the projected trace,
// speed from the source's own fixes (m/s) when present.
export function traceChannelData(gps, projected) {
  const withV = gps.filter((p) => p.v != null && Number.isFinite(p.v));
  return {
    dist: distFromTrace(projected),
    series: {
      speed: withV.length >= gps.length * 0.8 ? withV.map((p) => ({ t: p.t, v: p.v * 3.6 })) : null,
    },
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
  const odo = parsed.channels?.odoPts;
  if (odo && odo.length >= 10) return { dist: odo, series: car };
  const base = fromTrace();
  return base ? { dist: base.dist, series: { ...base.series, ...car } } : null;
}

// Compute and attach `lapChannels` (the stored shape) to a parsed import.
// Called after parsing and again whenever laps change (line pick, batch
// anchoring). Laps without startT/endT windows contribute nothing.
export function attachLapChannels(parsed) {
  const data = parsed.laps?.length ? channelDataFor(parsed) : null;
  parsed.lapChannels = data ? buildLapChannels(parsed.laps, data.dist, data.series) : null;
  return parsed;
}

// Cut per-lap channel arrays on the distance grid. Laps without a
// startT/endT window (hand-entered times) are skipped; returns null when
// nothing survives, so callers can store the absence as-is.
//   laps:  [{lapNumber?, timeMs, startT?, endT?}]
//   dist:  [{t, v: meters}] cumulative, same clock as the series
//   chans: {speed?, rpm?, latG?} as [{t, v}] — speed km/h, latG G
export function buildLapChannels(laps, dist, chans, dStepM = D_STEP_M) {
  if (!laps?.length || !dist || dist.length < 10) return null;
  const distS = series(dist);
  const named = [
    ["speed", chans.speed, 10],
    ["rpm", chans.rpm, 1],
    ["latG", chans.latG, 1000],
  ].filter(([, pts]) => pts && pts.length >= 10);
  const chanS = named.map(([name, pts, f]) => [name, series(pts), f]);

  const out = [];
  for (let i = 0; i < laps.length; i++) {
    const lap = laps[i];
    if (lap.startT == null || lap.endT == null || lap.endT <= lap.startT) continue;
    const d0 = distS.at(lap.startT);
    const d1 = distS.at(lap.endT);
    const n = Math.floor((d1 - d0) / dStepM) + 1;
    if (n < 10 || n > MAX_LAP_POINTS) continue;
    const entry = { n: lap.lapNumber ?? i + 1, timeMs: lap.timeMs };
    // synthesized speed (from the distance slope) fills in when no source
    // speed channel exists — the graph is too useful to drop for that
    let any = false;
    for (const [name, s, f] of chanS) {
      const t0 = s.first.t, t1 = s.last.t;
      if (lap.startT < t0 - 5 || lap.endT > t1 + 5) continue;
      entry[name] = Array.from({ length: n }, (_, k) => round(s.at(distS.timeAt(d0 + k * dStepM)), f));
      any = true;
    }
    if (!entry.speed) {
      entry.speed = Array.from({ length: n }, (_, k) =>
        round(Math.max(0, distS.rate(distS.timeAt(d0 + k * dStepM))) * 3.6, 10)
      );
      any = true;
    }
    if (any) out.push(entry);
  }
  if (!out.length || out.length > MAX_LAPS) return null;
  const totalValues = out.reduce(
    (s, e) => s + ["speed", "rpm", "latG"].reduce((c, k) => c + (e[k]?.length ?? 0), 0),
    0
  );
  return totalValues <= MAX_TOTAL_VALUES ? { v: 1, dStepM, laps: out } : null;
}
