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
import { matchLapsToChannels } from "../public/js/channel-graphs.js";
import {
  addFix,
  createRecording,
  serializeRecording,
  shouldAutoStop,
  toParsed,
  trimIdle,
} from "../public/js/record/core.js";
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

// ---------------------------------------------------------------------------
// Recorder core: a synthetic track day, checkpointed exactly as the live
// recorder checkpoints one (public/js/record/core.js). `checkpoint` below is the
// literal string the web app stores under localStorage["recording.pending"], so
// the native ports prove they can read a recording written by another client —
// and then agree on every derived value.

const REC_LAT0 = 36.56;
const REC_LON0 = -79.2;
const REC_KX = 111320 * Math.cos((REC_LAT0 * Math.PI) / 180);
const REC_KY = 110540;

// Mirrors the helper in test/unit/record.test.js: idle in the paddock, 5 laps of
// a 200 m circle at 25 m/s (~50.3 s/lap) at 1 Hz, then idle again.
function syntheticRecording({
  idleBeforeS = 120,
  laps = 5,
  idleAfterS = 120,
  speed = 25,
  startedAtMs = 1750000000000,
} = {}) {
  const rec = createRecording("ev1", startedAtMs);
  const r = 200;
  const lapS = (2 * Math.PI * r) / speed;
  const driveS = Math.round(laps * lapS);
  let t = 0;
  const push = (lat, lon, v) =>
    addFix(rec, { timeMs: startedAtMs + t++ * 1000, lat, lon, speed: v, accuracy: 5 });
  for (let i = 0; i < idleBeforeS; i++) push(REC_LAT0, REC_LON0 - 500 / REC_KX, 0);
  for (let i = 0; i <= driveS; i++) {
    const a = (i * speed) / r;
    push(REC_LAT0 + (r * Math.sin(a)) / REC_KY, REC_LON0 + (r * Math.cos(a)) / REC_KX, speed);
  }
  for (let i = 0; i < idleAfterS; i++) push(REC_LAT0, REC_LON0 - 500 / REC_KX, 0);
  return { rec, lapS, driveS, idleBeforeS };
}

const { rec, lapS: recLapS, driveS, idleBeforeS } = syntheticRecording();
const trimmed = trimIdle(rec.fixes);
const parsed = toParsed(rec);
const drivingEndMs = rec.startedAtMs + (idleBeforeS + driveS) * 1000;
// The same line-pick flow the review panel runs: pick a point mid-drive.
const recTrace = projectTrace(parsed.gps);
const recPickedIndex = Math.floor(recTrace.length / 2);
const recGate = buildGate(recTrace, recPickedIndex);

const recorderFixture = {
  description:
    "A synthetic track day recorded and checkpointed by public/js/record/core.js. " +
    "`checkpoint` is the literal localStorage[\"recording.pending\"] string, so the " +
    "native ports (NS-11 iOS, NS-12 Android) must deserialize it and reproduce every " +
    "expected value below. Deliberately excludes toParsed's date/time, which are " +
    "local-time formatting and so depend on the generating machine's zone. " +
    "Regenerate with `npm run contracts:logic`.",
  source: "public/js/record/core.js",
  input: {
    checkpoint: serializeRecording(rec),
    lapS: recLapS,
    driveS,
    idleBeforeS,
    pickedIndex: recPickedIndex,
    // Wall-clock instants the auto-stop expectations below are evaluated at.
    nowMs: {
      fiveMinutesAfterDriving: drivingEndMs + 5 * 60 * 1000,
      sixteenMinutesAfterDriving: drivingEndMs + 16 * 60 * 1000,
    },
  },
  expected: {
    fixCount: rec.fixes.length,
    firstFix: rec.fixes[0],
    lastFix: rec.fixes[rec.fixes.length - 1],
    trimmedCount: trimmed.length,
    trimmedFirstT: trimmed[0][0],
    trimmedLastT: trimmed[trimmed.length - 1][0],
    autoStopAtFiveMinutes: shouldAutoStop(rec, drivingEndMs + 5 * 60 * 1000),
    autoStopAtSixteenMinutes: shouldAutoStop(rec, drivingEndMs + 16 * 60 * 1000),
    parsed: {
      kind: parsed.kind,
      needsLine: parsed.needsLine,
      durationS: parsed.durationS,
      gpsCount: parsed.gps.length,
      firstGps: parsed.gps[0],
      lastGps: parsed.gps[parsed.gps.length - 1],
    },
    // Laps the recording yields once the user picks a start/finish line.
    laps: deriveLaps(recTrace, recGate),
  },
};


// ---------------------------------------------------------------------------
// Lap overlay: matching a session's stored lap rows to its channel entries.
//
// The reference is matchLapsToChannels in public/js/channel-graphs.js. Both
// lists come from the same parsed laps at import time, but laps added by hand
// afterwards have no channel data and duplicate lap times have to pair up in
// order — which is the whole reason this is a greedy in-order match rather than
// a lookup, and the reason it is worth pinning across languages.
const channelLaps = [
  { n: 1, timeMs: 121900 },
  { n: 2, timeMs: 120400 },
  { n: 3, timeMs: 120400 },
];
const sessionLaps = [
  { lap_num: 1, time_ms: 121900 },
  { lap_num: 2, time_ms: 120400 },
  // Same time as lap 2: the pairing must stay one-to-one and in order.
  { lap_num: 3, time_ms: 120400 },
  // Typed in after the import, so no channel entry exists for it.
  { lap_num: 4, time_ms: 119800 },
];

const channelsFixture = {
  description:
    "Lap-to-channel matching reference output from public/js/channel-graphs.js. " +
    "The native ports must reproduce chIdx exactly, -1 included. Regenerate with " +
    "`npm run contracts:logic`.",
  source: "public/js/channel-graphs.js",
  input: { sessionLaps, channelLaps },
  expected: {
    chIdx: matchLapsToChannels(sessionLaps, channelLaps).map((r) => r.chIdx),
  },
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, "geo-laps.json"), JSON.stringify(fixture, null, 2) + "\n");
writeFileSync(path.join(OUT_DIR, "recorder.json"), JSON.stringify(recorderFixture, null, 2) + "\n");
writeFileSync(path.join(OUT_DIR, "channels.json"), JSON.stringify(channelsFixture, null, 2) + "\n");
console.log(
  `wrote contracts/logic/geo-laps.json (${points.length} points, ${fixture.expected.laps.length} laps)`
);
console.log(
  `wrote contracts/logic/recorder.json (${rec.fixes.length} fixes, ${recorderFixture.expected.laps.length} laps)`
);
console.log(`wrote contracts/logic/channels.json (${channelsFixture.expected.chIdx.length} laps)`);
