// Pure per-session lap analysis — no DOM, unit-testable.
// All inputs are arrays of lap times in integer milliseconds, in running order.

// Laps within `factor` of the session best. Filters out-laps, cool-downs and
// heavy traffic the same way the F1 107% rule separates representative pace.
export function cleanLaps(laps, factor = 1.07) {
  if (!laps.length) return [];
  const best = Math.min(...laps);
  return laps.filter((ms) => ms <= best * factor);
}

// Average of the best n laps; null when there are fewer than n.
export function bestNAvg(laps, n = 3) {
  if (laps.length < n) return null;
  const sorted = [...laps].sort((a, b) => a - b).slice(0, n);
  return sorted.reduce((s, v) => s + v, 0) / n;
}

// Least-squares slope of clean laps in ms per lap. Positive = getting slower
// through the session (tires/driver going off), negative = still improving.
// null with fewer than 4 clean laps — a trend over less isn't meaningful.
export function paceSlope(laps, factor = 1.07) {
  const clean = cleanLaps(laps, factor);
  const n = clean.length;
  if (n < 4) return null;
  const meanX = (n - 1) / 2;
  const meanY = clean.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  clean.forEach((y, x) => {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) * (x - meanX);
  });
  return num / den;
}

// 1-based index of the first lap within `pct` of the session best — how long
// it took to get up to speed. null with fewer than 2 laps.
export function warmupLapCount(laps, pct = 0.01) {
  if (laps.length < 2) return null;
  const best = Math.min(...laps);
  const idx = laps.findIndex((ms) => ms <= best * (1 + pct));
  return idx === -1 ? null : idx + 1;
}
