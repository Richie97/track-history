// Cross-language fixtures for ported pure logic (specs: NS-13/NS-14 and on).
//
// Same idea as the golden API captures next door, one level down: the web
// implementation in public/js/ is the reference, so we run it and commit what it
// produced. The Swift and Kotlin ports then assert *identical* output — for lap
// times, identical to the millisecond. Reimplementing the fixture generator in
// each language would only prove the three of them agree with each other.
//
// Deterministic by construction: the inputs are analytic (a circle driven at a
// constant speed), there is no clock and no randomness. Regenerating without a
// change to public/js must produce a byte-identical tree, or `contracts:check`
// is worthless.
//
// Run with: npm run contracts:logic

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  bestLapTrace,
  buildGate,
  deriveLaps,
  gateCrossings,
  projectTrace,
} from "../public/js/import/geo.js";
import { LAP_S, circleTrace } from "../test/fixtures/build.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "contracts", "logic");

// The same circular trace test/unit/geo.test.js uses: 3.3 revolutions of a 300 m
// circle at 40 m/s, sampled at 10 Hz. A lap is 47.12 s, so a picked point a
// quarter-turn in is index round(0.25 · 47.12 · 10).
const points = circleTrace();
const lapS = LAP_S();
const pickedIndex = Math.round(0.25 * lapS * 10);

const trace = projectTrace(points);
const gate = buildGate(trace, pickedIndex);
if (!gate) throw new Error("buildGate returned null for the fixture pick");

const fixture = {
  description:
    "Lap geometry reference output from public/js/import/geo.js. The native ports " +
    "(NS-13 iOS, NS-14 Android) must reproduce laps[].timeMs exactly and the " +
    "geometry to within 1e-9. Regenerate with `npm run contracts:logic`.",
  source: "public/js/import/geo.js",
  input: {
    // Decimal degrees, t in seconds — what a recorder or a GPS file yields.
    points: points.map((p) => ({ t: p.t, lat: p.lat, lon: p.lon })),
    pickedIndex,
    lapS,
  },
  expected: {
    // Projection is exercised via the first/last point plus every derived value
    // below, which all depend on the whole projected trace.
    projectedFirst: pick(trace[0]),
    projectedLast: pick(trace[trace.length - 1]),
    gate,
    crossings: gateCrossings(trace, gate),
    laps: deriveLaps(trace, gate),
    bestLapTrace: bestLapTrace(trace, gate),
  },
};

function pick(p) {
  return { t: p.t, x: p.x, y: p.y };
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, "geo-laps.json"), JSON.stringify(fixture, null, 2) + "\n");
console.log(
  `wrote contracts/logic/geo-laps.json (${points.length} points, ${fixture.expected.laps.length} laps)`
);
