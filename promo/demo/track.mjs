// Circuit of the Americas — the circuit the demo logbook is driven around.
//
// The shape comes from TUM's open racetrack database (the centerline and a
// minimum-curvature racing line, both originally OpenStreetMap data), which
// is LGPL-3.0 / ODbL and so is downloaded into promo/.cache rather than
// vendored here. The video's end card carries the OpenStreetMap credit.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SRC = "https://raw.githubusercontent.com/TUMFTM/racetrack-database/master";

// Where the start/finish line sits on Earth. Only the shape matters to the
// app (every trace is projected to local metres), but a plausible origin
// keeps the demo's GPS honest.
export const COTA_ORIGIN = { lat: 30.1335, lon: -97.6411 };
export const COTA_ELEVATION_RANGE_M = 41;

async function cached(cacheDir, name, url) {
  const file = path.join(cacheDir, name);
  if (!existsSync(file)) {
    mkdirSync(cacheDir, { recursive: true });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    writeFileSync(file, await res.text());
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => l.split(",").map(Number));
}

// A closed polyline resampled every `ds` metres along a periodic Catmull-Rom
// spline, with signed curvature (left turns positive, x east / y north).
function resampleClosed(pts, ds) {
  const n = pts.length;
  const P = (i) => pts[((i % n) + n) % n];
  // Dense spline first, then walk it at an even spacing.
  const dense = [];
  const SUB = 8;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [P(i - 1), P(i), P(i + 1), P(i + 2)];
    for (let k = 0; k < SUB; k++) {
      const t = k / SUB, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      dense.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  const cum = [0];
  for (let i = 1; i <= dense.length; i++) {
    const a = dense[i - 1], b = dense[i % dense.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const length = cum[cum.length - 1];
  const count = Math.round(length / ds);
  const step = length / count;
  const out = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const s = k * step;
    while (cum[j + 1] < s) j++;
    const a = dense[j], b = dense[(j + 1) % dense.length];
    const f = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
    out.push({ x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f });
  }
  // Heading and curvature by central differences, curvature smoothed over
  // ~12 m so the tyre model sees corners rather than digitising noise.
  const m = out.length;
  const Q = (i) => out[((i % m) + m) % m];
  for (let i = 0; i < m; i++) {
    const a = Q(i - 2), b = Q(i + 2);
    out[i].hx = (b.x - a.x) / (4 * step);
    out[i].hy = (b.y - a.y) / (4 * step);
    const h = Math.hypot(out[i].hx, out[i].hy) || 1;
    out[i].hx /= h;
    out[i].hy /= h;
  }
  const rawK = out.map((_, i) => {
    const a = Q(i - 3), b = Q(i), c = Q(i + 3);
    const h1 = Math.atan2(b.y - a.y, b.x - a.x);
    const h2 = Math.atan2(c.y - b.y, c.x - b.x);
    let d = h2 - h1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d / (3 * step);
  });
  const W = Math.round(6 / step);
  for (let i = 0; i < m; i++) {
    let sum = 0;
    for (let k = -W; k <= W; k++) sum += rawK[((i + k) % m + m) % m];
    out[i].k = sum / (2 * W + 1);
  }
  return { pts: out, step, length: step * m };
}

// The racing line, resampled at 1 m, starting at the start/finish line.
export async function loadCota(cacheDir) {
  const race = await cached(cacheDir, "cota-raceline.csv", `${SRC}/racelines/Austin.csv`);
  const path = resampleClosed(race.map(([x, y]) => [x, y]), 1);
  // Corners: runs where |curvature| says the car is really turning, numbered
  // from the start/finish line. Used only to vary the driver corner by corner.
  const corners = [];
  let open = null;
  path.pts.forEach((p, i) => {
    const turning = Math.abs(p.k) > 1 / 450;
    if (turning && !open) open = { from: i, peak: i };
    if (turning && open && Math.abs(p.k) > Math.abs(path.pts[open.peak].k)) open.peak = i;
    if (!turning && open) {
      if (i - open.from > 25) corners.push({ ...open, to: i });
      open = null;
    }
  });
  return { ...path, corners };
}

// Local metres (x east, y north) to latitude/longitude around the origin —
// the inverse of projectTrace in public/js/import/geo.js.
export function toLatLon(x, y, origin = COTA_ORIGIN) {
  const kx = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  const ky = 110540;
  return { lat: origin.lat + y / ky, lon: origin.lon + x / kx };
}
