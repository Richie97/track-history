// Lap recovery for PDR recordings without beacons.
//
// Real PDR firmware doesn't stream GPS (longitude is written once, at
// recording start — see pdr.js), so the line picker can't help a beacon-less
// PDR file. What the telemetry does give us is ~2Hz latitude and the ~7Hz
// cumulative odometer, and latitude as a function of driven distance repeats
// exactly once per lap:
//   - lap length  = the autocorrelation peak of lat(distance)
//   - start/finish phase = cross-correlating lat(distance) against a one-lap
//     template from a beacon-timed recording of the same track (same import
//     batch); without one, laps are cut from where the car first reaches pace
//   - lap times   = odometer time at distance D0 + k*lapLength
// Validated against real footage: lap length within 2m of the
// beacon-calibrated value, lap times within ±0.2s of beacon times.

import { series } from "../../pdr.js";

export const PROFILE_STEP = 5; // meters per lat(distance) sample
const MIN_LAP_M = 800;         // shortest plausible circuit
const MAX_LAP_M = 12000;       // longest plausible circuit
const MIN_OVERLAP = 60;        // profile bins (300m) that must overlap in autocorrelation
const MIN_LAP_R = 0.9;         // periodicity confidence needed to trust a lap length
const MIN_PHASE_R = 0.8;       // template match needed to trust a start/finish alignment

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function pearson(a, b, n) {
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  sa /= n; sb /= n;
  let num = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const p = a[i] - sa, q = b[i] - sb;
    num += p * q; va += p * p; vb += q * q;
  }
  return va > 0 && vb > 0 ? num / Math.sqrt(va * vb) : 0;
}

// Latitude resampled on a uniform odometer-distance grid. Returns null when
// the channels are too thin or the car didn't cover two laps' distance.
export function latDistanceProfile(latPts, odoPts, step = PROFILE_STEP) {
  if (!latPts || !odoPts || latPts.length < 50 || odoPts.length < 50) return null;
  const odo = series(odoPts);
  const lat = series(latPts);
  const d0 = odo.first.v, d1 = odo.last.v;
  if (d1 - d0 < 2 * MIN_LAP_M) return null;
  const xs = [];
  for (let d = d0; d <= d1; d += step) xs.push(lat.at(odo.timeAt(d)));
  return { xs, d0, step };
}

// Lap length = smallest strong autocorrelation peak of the profile. A
// periodic signal peaks at every multiple of the true period, so among peaks
// within tolerance of the best, the smallest lag wins. Requires contrast
// between the best and worst lag: a car driving a straight line correlates
// ~1.0 at EVERY lag (lat(d) is linear) and must not produce fake laps.
export function findLapLength(profile) {
  const { xs, step } = profile;
  const n = xs.length;
  const m = mean(xs);
  const z = xs.map((v) => v - m);
  const lo = Math.round(MIN_LAP_M / step);
  const hi = Math.min(Math.round(MAX_LAP_M / step), n - MIN_OVERLAP);
  if (hi <= lo) return null;
  const rs = new Float64Array(hi + 1);
  let rMax = -Infinity, rMin = Infinity;
  for (let lag = lo; lag <= hi; lag++) {
    // proper per-window Pearson: a straight line must score r=1 at EVERY lag
    // (zero contrast), not decay artificially from a shared global mean
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    const m = n - lag;
    for (let i = 0; i < m; i++) {
      const a = z[i], b = z[i + lag];
      sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
    const cov = sab - (sa * sb) / m;
    const va = saa - (sa * sa) / m, vb = sbb - (sb * sb) / m;
    const r = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
    rs[lag] = r;
    if (r > rMax) rMax = r;
    if (r < rMin) rMin = r;
  }
  if (rMax < MIN_LAP_R || rMax - rMin < 0.5) return null;
  for (let lag = lo; lag <= hi; lag++) {
    if (rs[lag] >= rMax - 0.02 && rs[lag] >= rs[lag - 1] && (lag === hi || rs[lag] >= rs[lag + 1])) {
      return { lapM: lag * step, r: rs[lag] };
    }
  }
  return null;
}

// One-lap lat(distance) template starting at the start/finish line, built
// from a recording whose laps came from beacons. Used to phase-anchor
// beacon-less recordings of the same track.
export function lapTemplate(parsed) {
  const ch = parsed?.channels;
  if (!ch || !parsed.laps?.length || !ch.latPts || ch.latPts.length < 50 || !ch.odoPts || ch.odoPts.length < 50) return null;
  const anchor = parsed.laps.find((l) => !l.estimated) ?? parsed.laps[0];
  const odo = series(ch.odoPts);
  const lat = series(ch.latPts);
  const dStart = odo.at(anchor.startT);
  const lapM = odo.at(anchor.endT) - dStart;
  if (lapM < MIN_LAP_M || lapM > MAX_LAP_M) return null;
  const xs = [];
  for (let d = dStart; d < dStart + lapM && d <= odo.last.v; d += PROFILE_STEP) {
    xs.push(lat.at(odo.timeAt(d)));
  }
  return { xs, lapM };
}

// Slide the template over the profile's first lap: the best-matching offset
// is where the start/finish line falls. Returns meters from the profile
// start, or null when nothing matches convincingly.
export function matchPhase(profile, template, lapM) {
  const { xs, step } = profile;
  const bins = Math.round(lapM / step);
  const tn = template.length;
  let bestOff = null, bestR = -Infinity;
  const window = new Array(tn);
  for (let off = 0; off < bins; off++) {
    const n = Math.min(tn, xs.length - off);
    if (n < tn * 0.8) break;
    for (let i = 0; i < n; i++) window[i] = xs[off + i];
    const r = pearson(template, window, n);
    if (r > bestR) { bestR = r; bestOff = off; }
  }
  if (bestOff === null || bestR < MIN_PHASE_R) return null;
  return { offsetM: bestOff * step, r: bestR };
}

// Cut laps every lapM meters of odometer distance starting at dStart. Same
// accuracy class as the beacon-gap interpolation in pdr.js (~±0.2s).
export function cutLapsAtDistance(odoPts, dStart, lapM) {
  const odo = series(odoPts);
  const laps = [];
  for (let d = dStart; d + lapM <= odo.last.v; d += lapM) {
    const startT = odo.timeAt(d), endT = odo.timeAt(d + lapM);
    laps.push({ timeMs: Math.round((endT - startT) * 1000), estimated: true, startT, endT });
  }
  return laps;
}

// Beacon-less, template-less recovery (parse-time): find the lap length and
// cut rolling laps starting where the car first reaches pace. The result's
// boundaries aren't the official start/finish — anchorPdrBatch re-cuts them
// when a beacon-timed session of the same track is in the batch.
export function recoverPdrLaps(channels) {
  const profile = latDistanceProfile(channels?.latPts, channels?.odoPts);
  if (!profile) return null;
  const found = findLapLength(profile);
  if (!found) return null;
  const odo = series(channels.odoPts);
  const rates = [];
  for (let t = odo.first.t + 2; t < odo.last.t - 2; t += 2) rates.push(odo.rate(t));
  if (!rates.length) return null;
  const pace = [...rates].sort((a, b) => a - b)[Math.floor(rates.length * 0.75)];
  let dStart = odo.first.v;
  for (let t = odo.first.t + 2; t < odo.last.t - 2; t += 2) {
    if (odo.rate(t) >= 0.5 * pace) { dStart = odo.at(t); break; }
  }
  const laps = cutLapsAtDistance(channels.odoPts, dStart, found.lapM);
  return laps.length ? { laps, lapM: found.lapM, r: found.r, anchored: false } : null;
}

// Batch pass: re-anchor recovered laps to the real start/finish using any
// beacon-timed PDR recording of the same track (lap lengths must agree to 2%)
// dropped in the same import.
export function anchorPdrBatch(results) {
  const templates = [];
  for (const r of results) {
    const p = r.parsed;
    if (p?.kind === "pdr" && p.beaconCount >= 2 && p.laps?.length) {
      const t = lapTemplate(p);
      if (t) templates.push(t);
    }
  }
  if (!templates.length) return;
  for (const r of results) {
    const p = r.parsed;
    if (p?.kind !== "pdr" || !p.lapRecovery || !p.channels) continue;
    const tmpl = templates.find((t) => Math.abs(t.lapM - p.lapRecovery.lapM) / t.lapM < 0.02);
    if (!tmpl) continue;
    const profile = latDistanceProfile(p.channels.latPts, p.channels.odoPts);
    const phase = profile && matchPhase(profile, tmpl.xs, p.lapRecovery.lapM);
    if (!phase) continue;
    const laps = cutLapsAtDistance(p.channels.odoPts, profile.d0 + phase.offsetM, p.lapRecovery.lapM);
    if (laps.length) {
      p.laps = laps;
      p.lapRecovery = { ...p.lapRecovery, laps, anchored: true, phaseR: phase.r };
    }
  }
}
