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
import { parseTelemetryFile } from "../public/js/import/parse.js";
import { applyGate } from "../public/js/import/ui.js";
import { anchorPdrBatch } from "../public/js/import/pdr-laps.js";
import { attachLapChannels } from "../public/js/import/channels.js";
import { deltaSeries, lapTimeSeries, matchLapsToChannels } from "../public/js/channel-graphs.js";
import { sectorTimes, sessionSectors } from "../public/js/sectors.js";
import {
  alignLapPair,
  comparableLaps,
  defaultComparePicks,
  drivenLengthM,
  lapMetrics,
  lengthMismatchRatio,
  resampleChannelLap,
} from "../public/js/compare-laps.js";
import {
  PART_KINDS,
  WEAR_LIMIT_HINTS,
  fmtCost,
  fmtHours,
  fmtRemaining,
  partKindLabel,
  partStatus,
} from "../public/js/garage.js";
import {
  addFix,
  createRecording,
  serializeRecording,
  shouldAutoStop,
  toParsed,
  trimIdle,
} from "../public/js/record/core.js";
import { pickRecordingEvent } from "../public/js/record/remote.js";
import {
  addTimingFix,
  createLiveTiming,
  liveTimingDisplay,
} from "../public/js/record/live-timing.js";
import { DEFAULT_CHECKLIST } from "../public/js/checklist.js";
import {
  canRecord,
  canUseGarage,
  canUseSetups,
  canViewChannels,
  canViewYearInReview,
  canCompareEvents,
  entitlementSummary,
  isPro,
  manageUrl,
} from "../public/js/entitlement.js";
import {
  LAP_S,
  buildGpmfMp4,
  buildPdrDeltaMp4,
  buildPdrMp4,
  buildPdrRealMp4,
  circleTrace,
} from "../test/fixtures/build.mjs";

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
// Live lap timing (public/js/record/live-timing.js): the recorder's on-track
// lap counter and predictive delta. The ports must agree fix-for-fix — a gate
// anchored one fix later, or a delta interpolated differently, shows the
// driver a different number at 130 mph — so the fixture pins the delta after
// every fix, not just the end state.
//
// The input is a synthetic session on a 200 m circle at 5 Hz: a slow lead-in
// below track pace (the disarmed phase), then laps at 25, 25, 20 and 28 m/s —
// a repeat, a slower lap (positive delta), and a new best in progress.

const LT_LAT0 = 36.56;
const LT_LON0 = -79.2;
const LT_KX = 111320 * Math.cos((LT_LAT0 * Math.PI) / 180);
const LT_KY = 110540;
const LT_R = 200;

function liveTimingFixes() {
  const fixes = [];
  let t = 0;
  let a = 0;
  const dt = 1 / 5;
  const push = (v) => {
    fixes.push([
      Math.round(t * 100) / 100,
      Math.round((LT_LAT0 + (LT_R * Math.sin(a)) / LT_KY) * 1e6) / 1e6,
      Math.round((LT_LON0 + (LT_R * Math.cos(a)) / LT_KX) * 1e6) / 1e6,
      v,
      5,
    ]);
    t += dt;
    a += (v * dt) / LT_R;
  };
  // 10 s below ARM_MPS: the gate must not anchor here.
  for (let i = 0; i < 50; i++) push(5);
  for (const v of [25, 25, 20, 28]) {
    const n = Math.round(((2 * Math.PI * LT_R) / v) * 5);
    for (let i = 0; i < n; i++) push(v);
  }
  return fixes;
}

const ltFixes = liveTimingFixes();
const lt = createLiveTiming();
const ltDeltas = [];
for (const f of ltFixes) {
  addTimingFix(lt, f);
  ltDeltas.push(lt.deltaS);
}

const liveTimingFixture = {
  description:
    "Live lap timing reference output from public/js/record/live-timing.js. " +
    "Ports must reproduce the gate to 1e-9, lap times exactly, and every " +
    "per-fix delta to 1e-9 (null included). Regenerate with `npm run contracts:logic`.",
  source: "public/js/record/live-timing.js",
  input: { fixes: ltFixes },
  expected: {
    gate: lt.gate,
    lapCount: lt.lapCount,
    lastLapMs: lt.lastLapMs,
    bestLapMs: lt.bestLapMs,
    // lt.deltaS after every addTimingFix call, in input order.
    deltaAfterEachFix: ltDeltas,
    finalDisplay: liveTimingDisplay(lt, ltFixes[ltFixes.length - 1][0]),
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
// ---------------------------------------------------------------------------
// Lap delta: the time-delta trace between two laps on the shared distance grid
// (lapTimeSeries / deltaSeries in public/js/channel-graphs.js). Two things are
// worth pinning: the trapezoidal integration with its walking-pace clamp, and
// the end-scaling to the timed duration — a port that skips the scale still
// draws a plausible chart, it just quietly disagrees with the lap timer.
//
// Speeds are analytic (a sinusoid, rounded to 1 decimal exactly as
// buildLapChannels stores them) and the second lap is slower mid-lap and has a
// slightly shorter grid, so truncation to the overlap is exercised too.
const round1 = (v) => Math.round(v * 10) / 10;
const deltaRefLap = {
  timeMs: 91200,
  speed: Array.from({ length: 90 }, (_, k) => round1(130 + 45 * Math.sin(k / 7))),
};
const deltaSlowLap = {
  timeMs: 93450,
  speed: Array.from({ length: 87 }, (_, k) => round1(126 + 44 * Math.sin(k / 7 + 0.15))),
};
const deltaZeroClampLap = {
  // Two stationary samples at the start: the DELTA_MIN_KPH clamp keeps the
  // cell finite and the end-scale absorbs the error.
  timeMs: 95000,
  speed: [0, 0, ...Array.from({ length: 85 }, (_, k) => round1(120 + 40 * Math.sin(k / 6)))],
};

const lapDeltaFixture = {
  description:
    "Lap-delta reference output from public/js/channel-graphs.js (lapTimeSeries / " +
    "deltaSeries). Ports must reproduce every value to within 1e-9. Regenerate " +
    "with `npm run contracts:logic`.",
  source: "public/js/channel-graphs.js",
  input: {
    dStepM: 20,
    refLap: deltaRefLap,
    slowLap: deltaSlowLap,
    zeroClampLap: deltaZeroClampLap,
  },
  expected: {
    refTimeSeries: lapTimeSeries(deltaRefLap.speed, 20, deltaRefLap.timeMs),
    // Unscaled integration (no timed duration): the raw trapezoid sums.
    refTimeSeriesUnscaled: lapTimeSeries(deltaRefLap.speed, 20, null),
    slowVsRef: deltaSeries(deltaSlowLap, deltaRefLap, 20),
    zeroClampVsRef: deltaSeries(deltaZeroClampLap, deltaRefLap, 20),
  },
};

// ---------------------------------------------------------------------------
// Sectors and the theoretical best lap (#146): public/js/sectors.js. What is
// worth pinning: the fractional-of-own-distance boundaries with their linear
// interpolation of the time series, the round-then-residual rule that makes
// every lap's splits sum exactly to its lap time (a port that rounds all n
// sectors is off by a millisecond and disagrees with the lap timer), and the
// best-per-sector reduction with its earliest-lap tie rule. The laps are the
// delta fixture's, plus a lap with no speed series that must be skipped.
const sectorLaps = [
  deltaRefLap,
  deltaSlowLap,
  deltaZeroClampLap,
  { timeMs: 92000, rpm: Array.from({ length: 90 }, () => 5000) }, // no speed: left out
  { timeMs: 91200, speed: deltaRefLap.speed }, // ties every sector with lap 0: the earlier lap keeps it
];
const sectorChannels = { v: 1, dStepM: 20, laps: sectorLaps.map((l, i) => ({ n: i + 1, ...l })) };
const sectorsFixture = {
  description:
    "Sector-split reference output from public/js/sectors.js (sectorTimes / " +
    "sessionSectors). Ports must reproduce every integer exactly. Regenerate with " +
    "`npm run contracts:logic`.",
  source: "public/js/sectors.js",
  input: { channels: sectorChannels, n: 3, microsectorN: 6 },
  expected: {
    session: sessionSectors(sectorChannels, 3),
    // A finer split of one lap (microsectors), and the degenerate single sector.
    refMicrosectors: sectorTimes(deltaRefLap, 20, 6),
    refSingleSector: sectorTimes(deltaRefLap, 20, 1),
    // An untimed lap falls back to the integrated duration.
    untimedSectors: sectorTimes({ speed: deltaRefLap.speed, timeMs: null }, 20, 3),
    noSpeed: sectorTimes(sectorLaps[3], 20, 3),
  },
};

// ---------------------------------------------------------------------------
// Compare two laps (#165): the pure half of the cross-event lap comparison
// (public/js/compare-laps.js). What is worth pinning: the picker flattening
// (which rides on matchLapsToChannels, so hand-added laps drop out), the
// "current me vs best me" default picks, the linear resample that puts two
// sessions' grids together (exercised at a non-integer ratio), and the
// head-to-head reductions with their inclusive thresholds.

const cmpRound1 = (v) => Math.round(v * 10) / 10;
const cmpSpeed = (len, phase) =>
  Array.from({ length: len }, (_, k) => cmpRound1(120 + 45 * Math.sin(k / 7 + phase)));

const cmpEvents = [
  {
    id: 71,
    start_date: "2026-05-02",
    club: "NASA",
    sessions: [
      {
        id: 401,
        label: "Sat AM",
        laps: [
          { lap_num: 1, time_ms: 92150 },
          { lap_num: 2, time_ms: 90480 },
          // Hand-added after the import: no channel entry, must not be pickable.
          { lap_num: 3, time_ms: 90100 },
        ],
        channels: {
          v: 1,
          dStepM: 20,
          laps: [
            { n: 1, timeMs: 92150, speed: cmpSpeed(90, 0) },
            { n: 2, timeMs: 90480, speed: cmpSpeed(90, 0.1) },
          ],
        },
      },
      // A session with laps but no stored channels contributes nothing.
      { id: 402, label: "Sat PM", laps: [{ lap_num: 1, time_ms: 91000 }], channels: null },
    ],
  },
  {
    id: 72,
    start_date: "2026-07-11",
    club: null,
    sessions: [
      {
        id: 410,
        label: null,
        laps: [
          { lap_num: 1, time_ms: 93400 },
          { lap_num: 2, time_ms: 91020 },
        ],
        // A coarser grid than the May session, so the pair needs resampling.
        channels: {
          v: 1,
          dStepM: 25,
          laps: [
            { n: 1, timeMs: 93400, speed: cmpSpeed(72, 0.2) },
            { n: 2, timeMs: 91020, speed: cmpSpeed(72, 0.3) },
          ],
        },
      },
    ],
  },
];

const cmpRows = comparableLaps(cmpEvents);
const cmpPicks = defaultComparePicks(cmpRows);

// The overall best is also the latest event's best: the fallback case.
// defaultComparePicks reads only date and timeMs, so the rows carry no more.
const cmpFallbackRows = [
  { date: "2026-05-01", timeMs: 95000 },
  { date: "2026-07-01", timeMs: 90000 },
  { date: "2026-07-01", timeMs: 91000 },
];

// A fully-instrumented entry (every channel a PDR import stores) for the
// metrics and resample expectations. Values rounded exactly as
// buildLapChannels would store them.
const cmpFullEntry = {
  n: 2,
  timeMs: 90480,
  speed: cmpSpeed(90, 0),
  rpm: Array.from({ length: 90 }, (_, k) => Math.round(4500 + 1800 * Math.sin(k / 5))),
  latG: Array.from({ length: 90 }, (_, k) => Math.round(1.1 * Math.abs(Math.sin(k / 9)) * 1000) / 1000),
  throttle: Array.from({ length: 90 }, (_, k) => cmpRound1(50 + 50 * Math.sin(k / 4))),
  brake: Array.from({ length: 90 }, (_, k) => cmpRound1(Math.max(0, 80 * Math.sin(k / 3)))),
  steering: Array.from({ length: 90 }, (_, k) => cmpRound1(120 * Math.sin(k / 8))),
};
const cmpSpeedOnlyEntry = { n: 1, timeMs: 93400, speed: cmpSpeed(72, 0.2) };

const cmpPairA = cmpEvents[0].sessions[0].channels.laps[1];
const cmpPairB = cmpEvents[1].sessions[0].channels.laps[1];

const compareLapsFixture = {
  description:
    "Cross-event lap comparison reference output from public/js/compare-laps.js. " +
    "Ports must reproduce the rows and picks exactly, and every resampled or " +
    "reduced value to within 1e-9 (null included). Regenerate with " +
    "`npm run contracts:logic`.",
  source: "public/js/compare-laps.js",
  input: {
    events: cmpEvents,
    fallbackRows: cmpFallbackRows,
    fullEntry: cmpFullEntry,
    speedOnlyEntry: cmpSpeedOnlyEntry,
  },
  expected: {
    comparableLaps: cmpRows,
    defaultComparePicks: cmpPicks,
    defaultPicksFallback: defaultComparePicks(cmpFallbackRows),
    // 25 m → 20 m is a non-integer ratio, so every interior point interpolates.
    resampledTo20: resampleChannelLap(cmpPairB, 25, 20),
    resampledTo50: resampleChannelLap(cmpFullEntry, 20, 50),
    alignedPair: alignLapPair(cmpPairA, 20, cmpPairB, 25),
    drivenLengthA: drivenLengthM(cmpPairA, 20),
    drivenLengthB: drivenLengthM(cmpPairB, 25),
    lengthMismatchRatio: lengthMismatchRatio(cmpPairA, 20, cmpPairB, 25),
    metricsFull: lapMetrics(cmpFullEntry),
    metricsSpeedOnly: lapMetrics(cmpSpeedOnlyEntry),
  },
};

// ---------------------------------------------------------------------------
// Garage: how a server-computed wear estimate is turned into words.
//
// The wear *math* is server-side (src/lib/wear.ts) and arrives pre-computed, so
// there is nothing to port and nothing to pin about it. What the clients do port
// is the reading of it — the due/low/ok thresholds and the "≈2 track days"
// phrasing — and those thresholds are exactly where three implementations would
// drift apart unnoticed: a boundary off by one hour still looks plausible on
// screen. Every case below sits on or beside a threshold for that reason.

const wear = (over = {}) => ({
  hours: 0,
  events: 0,
  cycles: 0,
  expected_hours: null,
  remaining_hours: null,
  pct_used: null,
  source: null,
  wear_per_hour: null,
  last_value: null,
  unit: null,
  ...over,
});

const wearCases = [
  ["no basis for an estimate", wear({ hours: 3.5, events: 2 })],
  ["comfortably in service", wear({ remaining_hours: 9.4, pct_used: 0.3, source: "expected" })],
  // 4h is exactly 2 track days: the low/ok boundary, inclusive on the low side.
  ["exactly at the low threshold", wear({ remaining_hours: 4, pct_used: 0.6, source: "expected" })],
  ["just above the low threshold", wear({ remaining_hours: 4.1, pct_used: 0.6, source: "expected" })],
  ["low, half a day left", wear({ remaining_hours: 1, pct_used: 0.9, source: "measured", wear_per_hour: 0.12 })],
  ["low, one day left", wear({ remaining_hours: 2, pct_used: 0.85, source: "expected" })],
  ["nothing left", wear({ remaining_hours: 0, pct_used: 1, source: "measured", wear_per_hour: 0.2 })],
  // pct_used ≥ 1 makes it due even with hours nominally remaining — a measured
  // fit and a plain expectation can disagree, and the pessimistic one wins.
  ["used up despite remaining hours", wear({ remaining_hours: 1.5, pct_used: 1, source: "expected" })],
  ["overdue", wear({ remaining_hours: -2, pct_used: 1.4, source: "expected" })],
  // Rounds to 2 days, so the noun is plural even though 2 is not 1.
  ["rounds to two track days", wear({ remaining_hours: 4.4, pct_used: 0.5, source: "expected" })],
  // Below 2 days the phrasing keeps half-day precision: 3.4h → ≈1.5 days.
  ["keeps half-day precision", wear({ remaining_hours: 3.4, pct_used: 0.7, source: "expected" })],
  // Exactly one day: the only case that says "track day" singular.
  ["one track day", wear({ remaining_hours: 2, pct_used: 0.8, source: "expected" })],
];

const garageFixture = {
  description:
    "Wear-estimate presentation captured from public/js/garage.js: the due/low/ok " +
    "thresholds and the remaining-life phrasing. The wear math itself is server-side " +
    "(src/lib/wear.ts) and is not ported. Regenerate with `npm run contracts:logic`.",
  source: "public/js/garage.js",
  cases: wearCases.map(([name, w]) => ({
    name,
    wear: w,
    status: partStatus(w),
    remaining: fmtRemaining(w),
  })),
  // fmtHours is used for accrued hours, expected life and remaining life alike,
  // so its rounding shows up in three places on the garage page.
  hours: [null, 0, 0.04, 0.05, 2, 4.25, 4.35, 12.5, 100].map((h) => ({
    input: h,
    output: fmtHours(h),
  })),
  cost: [null, 0, 5, 38900, 38950, 100000].map((c) => ({ input: c, output: fmtCost(c) })),
  kinds: PART_KINDS.map(([kind]) => ({
    kind,
    label: partKindLabel(kind),
    wearLimitHint: WEAR_LIMIT_HINTS[kind] ?? null,
  })),
};

// Which event a CarPlay-started recording attaches to (NS-19). The rule is
// deliberately conservative and the two clients must agree on it exactly: the phone
// and the head unit deciding differently would put one drive in two logbook entries.
//
// `localTodayIso` is deliberately absent. It reads the generating machine's local
// calendar date, so a fixture built from it would encode whoever ran the generator
// rather than the behaviour — it is covered by unit tests on each side instead.
const attachEvents = {
  // [id, start_date, days?]
  threeSingleDays: [
    ["a", "2026-07-25", 1],
    ["b", "2026-07-21", 1],
    ["c", "2026-07-01", 1],
  ],
  weekend: [["a", "2026-07-19", 3]],
  gapAroundToday: [
    ["a", "2026-07-20", 1],
    ["b", "2026-07-22", 1],
  ],
  overlapping: [
    ["long", "2026-07-18", 7],
    ["today", "2026-07-21", 1],
  ],
  // The event form steps by 0.5, so half days reach this rule.
  halfDay: [["h", "2026-07-19", 1.5]],
  twoAndAHalf: [["t", "2026-07-19", 2.5]],
  zeroDays: [["z", "2026-07-21", 0]],
  negativeDays: [["n", "2026-07-21", -3]],
  missingDays: [["x", "2026-07-21"]],
  monthEnd: [["m", "2026-07-31", 2]],
  yearEnd: [["y", "2026-12-31", 2]],
  // US spring forward 2026 is Sunday 8 March; fall back is Sunday 1 November.
  springForward: [["s", "2026-03-07", 2]],
  fallBack: [["f", "2026-10-31", 2]],
  empty: [],
};

const toEvent = ([id, start_date, days]) =>
  days === undefined ? { id, start_date } : { id, start_date, days };

const attachCases = [
  ["threeSingleDays", "2026-07-21"],
  ["weekend", "2026-07-19"],
  ["weekend", "2026-07-21"],
  ["weekend", "2026-07-22"],
  ["gapAroundToday", "2026-07-21"],
  ["overlapping", "2026-07-21"],
  ["halfDay", "2026-07-19"],
  ["halfDay", "2026-07-20"],
  ["twoAndAHalf", "2026-07-20"],
  ["twoAndAHalf", "2026-07-21"],
  ["zeroDays", "2026-07-21"],
  ["zeroDays", "2026-07-22"],
  ["negativeDays", "2026-07-21"],
  ["missingDays", "2026-07-21"],
  ["missingDays", "2026-07-22"],
  ["monthEnd", "2026-08-01"],
  ["yearEnd", "2027-01-01"],
  ["springForward", "2026-03-08"],
  ["springForward", "2026-03-09"],
  ["fallBack", "2026-11-01"],
  ["fallBack", "2026-11-02"],
  ["empty", "2026-07-21"],
].map(([set, todayIso]) => {
  const events = attachEvents[set].map(toEvent);
  return {
    events: set,
    todayIso,
    // What the web implementation actually picks. Null means "record unattached".
    expectedId: pickRecordingEvent(events, todayIso)?.id ?? null,
  };
});

const remoteFixture = {
  note:
    "Reference output of pickRecordingEvent in public/js/record/remote.js. " +
    "Regenerate with `npm run contracts:logic`; never hand-edit.",
  events: Object.fromEntries(
    Object.entries(attachEvents).map(([name, rows]) => [name, rows.map(toEvent)])
  ),
  cases: attachCases,
};

// ---------------------------------------------------------------------------
// Video telemetry parsers (NS-30): the MP4s themselves, and what the JS parsers
// make of them.
//
// Unlike every other fixture here, the input is *binary* — the synthetic MP4s
// from test/fixtures/build.mjs are written to contracts/logic/video/ and
// committed, because a Swift or Kotlin reimplementation of the fixture builder
// would only prove the two builders agree. The parsers are what has to agree,
// and a byte-identical file is the only way to ask them the same question.
//
// The PDR decoder in particular is reverse-engineered sign extension and running
// state (see the comment block in public/pdr.js), so what is pinned below is
// deliberately deep: lap times to the millisecond with their `estimated` flags,
// the GPS trace, the session metrics, and every per-lap channel array element by
// element.

const VIDEO_DIR = path.join(OUT_DIR, "video");

// Every sampled coordinate, so a decoder that is subtly off is caught rather
// than averaged away — but not every one of ~1,500 fixes, which would make the
// fixture unreadable. First, last and every 50th.
const GPS_STRIDE = 50;

function sampleGps(gps) {
  if (!gps) return null;
  const idx = new Set([0, gps.length - 1]);
  for (let i = 0; i < gps.length; i += GPS_STRIDE) idx.add(i);
  return [...idx]
    .sort((a, b) => a - b)
    .map((i) => ({ i, t: gps[i].t, lat: gps[i].lat, lon: gps[i].lon, v: gps[i].v ?? null }));
}

const lapOut = (l) => ({
  lapNumber: l.lapNumber ?? null,
  timeMs: l.timeMs,
  estimated: !!l.estimated,
  startT: l.startT ?? null,
  endT: l.endT ?? null,
});

function parsedOut(p) {
  return {
    kind: p.kind,
    date: p.date ?? null,
    time: p.time ?? null,
    durationS: p.durationS,
    needsLine: !!p.needsLine,
    beaconCount: p.beaconCount ?? 0,
    metrics: p.metrics
      ? {
          topSpeedKph: p.metrics.topSpeedKph ?? null,
          maxRpm: p.metrics.maxRpm ?? null,
          maxLatG: p.metrics.maxLatG ?? null,
          maxBrakeG: p.metrics.maxBrakeG ?? null,
          maxBoostKpa: p.metrics.maxBoostKpa ?? null,
          maxOilC: p.metrics.maxOilC ?? null,
        }
      : null,
    sessionMeta: p.sessionMeta
      ? {
          ambientC: p.sessionMeta.ambientC ?? null,
          intakeC: p.sessionMeta.intakeC ?? null,
          elevationM: p.sessionMeta.elevationM ?? null,
          odometerKm: p.sessionMeta.odometerKm ?? null,
        }
      : null,
    gpsCount: p.gps?.length ?? 0,
    gpsSample: sampleGps(p.gps),
    laps: p.laps.map(lapOut),
    lapChannels: p.lapChannels ?? null,
    lapRecovery: p.lapRecovery
      ? {
          lapM: p.lapRecovery.lapM,
          r: p.lapRecovery.r,
          anchored: p.lapRecovery.anchored,
          phaseR: p.lapRecovery.phaseR ?? null,
          lapCount: p.lapRecovery.laps.length,
        }
      : null,
    // The odometer and raw-latitude series feed lap recovery; their extent is
    // enough to catch a decoder that dropped or duplicated samples.
    channels: p.channels
      ? {
          latCount: p.channels.latPts.length,
          odoCount: p.channels.odoPts.length,
          odoFirst: p.channels.odoPts[0] ?? null,
          odoLast: p.channels.odoPts[p.channels.odoPts.length - 1] ?? null,
        }
      : null,
  };
}

// The three revolutions of the reference circle every fixture drives, and the
// beacon times that make three crossings out of them.
const beaconTimes = [30, 30 + lapS, 30 + 2 * lapS];

const videoFixtures = [
  {
    file: "gopro.mp4",
    note: "GoPro GPMF, GPS5 stream at 10 Hz. No lap markers: needs a picked line.",
    bytes: buildGpmfMp4(points),
    pick: true,
  },
  {
    file: "pdr-beacons.mp4",
    note: "PDR, full records only, beacon-timed laps plus a deg*1e7 GPS trace.",
    bytes: buildPdrMp4({ beaconTimes, gpsPoints: points }),
  },
  {
    file: "pdr-delta.mp4",
    note: "PDR in the real-firmware shape: delta framing, channel dictionary, car channels.",
    bytes: buildPdrDeltaMp4({ beaconTimes }),
  },
  {
    file: "pdr-delta-nobeacon.mp4",
    note: "The same delta-encoded firmware shape without beacons — the input the JS decoder unit tests use, so the Swift ones can ask the same question.",
    bytes: buildPdrDeltaMp4(),
    pick: true,
  },
  {
    file: "pdr-nobeacon.mp4",
    note: "PDR with a GPS trace and no beacons: the line picker times the laps.",
    bytes: buildPdrMp4({ beaconTimes: [], gpsPoints: points }),
    pick: true,
  },
  {
    file: "pdr-real-beacons.mp4",
    note: "PDR whose GPS can't be decoded (one longitude fix) but which has beacons — the lap template a batch anchors against.",
    bytes: buildPdrRealMp4({ beaconTimes }),
  },
  {
    file: "pdr-real-shifted.mp4",
    note: "The same track from a different pit-out angle, no beacons: laps recovered from lat+odometer periodicity, then anchored by the file above.",
    bytes: buildPdrRealMp4({ startAngle: 1.0 }),
  },
];

mkdirSync(VIDEO_DIR, { recursive: true });
const videoCases = [];
for (const f of videoFixtures) {
  writeFileSync(path.join(VIDEO_DIR, f.file), Buffer.from(f.bytes));
  const parsed = await parseTelemetryFile(new File([f.bytes], f.file));
  const entry = { file: f.file, note: f.note, expected: parsedOut(parsed), picked: null };
  if (f.pick) {
    // The same flow the review panel runs: project on the file's own first fix,
    // tap a quarter of a lap in, and let applyGate re-derive laps and channels.
    const pickedIndex = Math.round(0.25 * lapS * 10);
    const state = { results: [{ file: f.file, parsed }], origin: parsed.gps[0], gate: null };
    state.gate = buildGate(projectTrace(parsed.gps, state.origin), pickedIndex);
    applyGate(state);
    entry.picked = {
      pickedIndex,
      gate: state.gate,
      laps: parsed.laps.map(lapOut),
      bestLapTrace: parsed.bestLapTrace,
      lapChannels: parsed.lapChannels ?? null,
    };
  }
  videoCases.push({ entry, parsed });
}

// Batch pass, exactly as the import flow runs it: a beacon-timed recording of
// the same track re-anchors the recovered laps of a beacon-less one, and the
// per-lap channels follow the moved boundaries.
const batchResults = videoCases.map(({ entry, parsed }) => ({ file: entry.file, parsed }));
anchorPdrBatch(batchResults);
for (const r of batchResults) {
  if (r.parsed?.kind === "pdr" && r.parsed.lapRecovery) attachLapChannels(r.parsed);
}
const anchored = batchResults
  .filter((r) => r.parsed?.lapRecovery)
  .map((r) => ({ file: r.file, expected: parsedOut(r.parsed) }));

const videoFixture = {
  description:
    "Reference output of the video telemetry parsers (public/pdr.js, " +
    "public/js/import/gpmf.js, channels.js, pdr-laps.js) over the committed MP4s " +
    "in contracts/logic/video/. The iOS port (NS-30) must reproduce lap times to " +
    "the millisecond, coordinates to 1e-9 and every channel array element for " +
    "element. Regenerate with `npm run contracts:logic`; never hand-edit.",
  source: "public/pdr.js, public/js/import/gpmf.js, public/js/import/channels.js, public/js/import/pdr-laps.js",
  gpsStride: GPS_STRIDE,
  files: videoCases.map(({ entry }) => entry),
  // What anchorPdrBatch changed once every file in the batch was parsed.
  afterBatchAnchor: anchored,
};

// ---------------------------------------------------------------------------
// The prep checklist a new event starts from.
//
// Not logic — a list of strings — but it is *product copy carried in two
// clients*, and the web and iOS copies drifting is invisible until someone
// notices their phone offering a different default from their laptop. A user
// who edits the list in Settings gets their own (`users.checklist_template`);
// this is only what they start from.
const checklistFixture = {
  description:
    "The built-in prep checklist from public/js/checklist.js. The iOS port " +
    "(EventDates.DEFAULT_CHECKLIST) must match it item for item, in order. " +
    "Regenerate with `npm run contracts:logic`; never hand-edit.",
  source: "public/js/checklist.js",
  DEFAULT_CHECKLIST,
};

// ---------------------------------------------------------------------------
// entitlement predicates (NS-32): the `entitlement` object on GET /api/me → every
// client-side tier decision. Both ports must agree with public/js/entitlement.js
// case for case, including that a stale-but-pro cached answer still records.
// ---------------------------------------------------------------------------

const FIXED_EXPIRY = 1_800_000_000_000;
const entitlementCases = [
  { name: "free, never subscribed", entitlement: { tier: "free", source: null, expires_at: null, auto_renew: null } },
  { name: "nothing cached (signed out / never fetched)", entitlement: null },
  { name: "pro via apple, renewing", entitlement: { tier: "pro", source: "apple", expires_at: FIXED_EXPIRY, auto_renew: true } },
  { name: "pro via google, cancelled but paid up", entitlement: { tier: "pro", source: "google", expires_at: FIXED_EXPIRY, auto_renew: false } },
  { name: "pro via apple, auto_renew unknown", entitlement: { tier: "pro", source: "apple", expires_at: FIXED_EXPIRY, auto_renew: null } },
  { name: "legacy (paid app)", entitlement: { tier: "pro", source: "legacy", expires_at: null, auto_renew: null } },
  { name: "lapsed apple subscriber", entitlement: { tier: "free", source: "apple", expires_at: 1_700_000_000_000, auto_renew: false } },
  { name: "lapsed google subscriber", entitlement: { tier: "free", source: "google", expires_at: 1_700_000_000_000, auto_renew: false } },
  { name: "stale cached pro — expires_at already past on the client's clock", entitlement: { tier: "pro", source: "apple", expires_at: 1, auto_renew: true } },
].map((c) => ({
  ...c,
  expected: {
    isPro: isPro(c.entitlement),
    canRecord: canRecord(c.entitlement),
    canViewChannels: canViewChannels(c.entitlement),
    canUseGarage: canUseGarage(c.entitlement),
    canUseSetups: canUseSetups(c.entitlement),
    canViewYearInReview: canViewYearInReview(c.entitlement),
    canCompareEvents: canCompareEvents(c.entitlement),
    manageUrl: manageUrl(c.entitlement),
    // The date text is locale work; the fixture pins the shape around it.
    summary: entitlementSummary(c.entitlement, (ms) => `<${ms}>`),
  },
}));

const entitlementFixture = {
  description:
    "Tier predicates from public/js/entitlement.js over the `entitlement` object GET /api/me " +
    "returns. Ports (Entitlement in the iOS Kit and Android :core) must match every expected " +
    "value; the summary's date is rendered as <ms> so the ports pin the wording without a locale. " +
    "Regenerate with `npm run contracts:logic`; never hand-edit.",
  source: "public/js/entitlement.js",
  cases: entitlementCases,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, "entitlement.json"), JSON.stringify(entitlementFixture, null, 2) + "\n");
writeFileSync(path.join(OUT_DIR, "checklist.json"), JSON.stringify(checklistFixture, null, 2) + "\n");
writeFileSync(path.join(OUT_DIR, "video-parsers.json"), JSON.stringify(videoFixture, null, 2) + "\n");
writeFileSync(path.join(OUT_DIR, "geo-laps.json"), JSON.stringify(fixture, null, 2) + "\n");
writeFileSync(path.join(OUT_DIR, "recorder.json"), JSON.stringify(recorderFixture, null, 2) + "\n");
writeFileSync(path.join(OUT_DIR, "channels.json"), JSON.stringify(channelsFixture, null, 2) + "\n");
writeFileSync(path.join(OUT_DIR, "lap-delta.json"), JSON.stringify(lapDeltaFixture, null, 2) + "\n");
writeFileSync(path.join(OUT_DIR, "compare-laps.json"), JSON.stringify(compareLapsFixture, null, 2) + "\n");
writeFileSync(path.join(OUT_DIR, "sectors.json"), JSON.stringify(sectorsFixture, null, 2) + "\n");
writeFileSync(path.join(OUT_DIR, "live-timing.json"), JSON.stringify(liveTimingFixture, null, 2) + "\n");
writeFileSync(path.join(OUT_DIR, "garage-status.json"), JSON.stringify(garageFixture, null, 2) + "\n");
writeFileSync(path.join(OUT_DIR, "remote-attach.json"), JSON.stringify(remoteFixture, null, 2) + "\n");
console.log(
  `wrote contracts/logic/geo-laps.json (${points.length} points, ${fixture.expected.laps.length} laps)`
);
console.log(
  `wrote contracts/logic/recorder.json (${rec.fixes.length} fixes, ${recorderFixture.expected.laps.length} laps)`
);
console.log(`wrote contracts/logic/channels.json (${channelsFixture.expected.chIdx.length} laps)`);
console.log(`wrote contracts/logic/lap-delta.json (${lapDeltaFixture.expected.slowVsRef.length} grid points)`);
console.log(`wrote contracts/logic/compare-laps.json (${cmpRows.length} pickable laps)`);
console.log(`wrote contracts/logic/sectors.json (${sectorsFixture.expected.session.laps.length} laps split)`);
console.log(
  `wrote contracts/logic/live-timing.json (${ltFixes.length} fixes, ${liveTimingFixture.expected.lapCount} laps)`
);
console.log(`wrote contracts/logic/garage-status.json (${garageFixture.cases.length} wear cases)`);
console.log(`wrote contracts/logic/remote-attach.json (${attachCases.length} cases)`);
console.log(`wrote contracts/logic/checklist.json (${DEFAULT_CHECKLIST.length} items)`);
console.log(`wrote contracts/logic/entitlement.json (${entitlementCases.length} cases)`);
console.log(
  `wrote contracts/logic/video-parsers.json (${videoCases.length} clips) and contracts/logic/video/*.mp4`
);
