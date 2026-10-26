import { describe, expect, it } from "vitest";
import { lapTimeSeries, matchLapsToChannels } from "../../public/js/channel-graphs.js";
import { sessionCorners } from "../../public/js/corners.js";
import {
  DEFAULT_SYNC_MODE,
  FOLLOW_RATE_MAX,
  FOLLOW_RATE_MIN,
  RESYNC_MS,
  SYNC_MODES,
  clipTimeAtGrid,
  cornerPlace,
  cornerStops,
  fmtDeltaS,
  fmtGap,
  fmtStageTime,
  followRate,
  gridAtElapsed,
  makeSide,
  matchByFraction,
  needsResync,
  playheadAt,
  playheadText,
  referenceLap,
  scrubRange,
  sideAtClipTime,
  stageSides,
  valueAt,
} from "../../public/js/video-sync.js";

// Two laps on the same 20 m grid: A is quick, B a touch slower everywhere and
// much slower through the corner at k 10–14, so "place" and "time" disagree.
const N = 30;
const latG = Array.from({ length: N }, (_, k) => (k >= 10 && k <= 14 ? 1.1 : k >= 22 && k <= 25 ? 0.8 : 0.05));
const speedA = Array.from({ length: N }, (_, k) => (k >= 10 && k <= 14 ? 90 : 160));
const speedB = speedA.map((v, k) => (k >= 10 && k <= 14 ? v - 20 : v - 4));
const entryA = { n: 3, timeMs: 15_000, speed: speedA, latG, throttle: speedA.map((v) => (v > 100 ? 100 : 20)), brake: speedA.map((v, k) => (k === 9 ? 70 : 0)), gear: speedA.map((v) => (v > 100 ? 4 : 3)) };
const entryB = { n: 5, timeMs: 16_200, speed: speedB, latG };
const A = makeSide("A", entryA, 20, { lapOffsetMs: 3_000, durationMs: 22_000 });
const B = makeSide("B", entryB, 20, { lapOffsetMs: 3_400, durationMs: 23_600 });
const corners = sessionCorners({ v: 1, dStepM: 20, laps: [entryA, entryB] });

describe("gridAtElapsed / valueAt", () => {
  const t = [0, 1, 3, 6];
  it("clamps before the line and past the end", () => {
    expect(gridAtElapsed(t, -1)).toBe(0);
    expect(gridAtElapsed(t, 0)).toBe(0);
    expect(gridAtElapsed(t, 6)).toBe(3);
    expect(gridAtElapsed(t, 9)).toBe(3);
  });
  it("interpolates between points and lands exactly on one", () => {
    expect(gridAtElapsed(t, 2)).toBe(1.5);
    expect(gridAtElapsed(t, 3)).toBe(2);
    expect(gridAtElapsed(t, 4.5)).toBe(2.5);
  });
  it("is the inverse of valueAt on the time curve", () => {
    for (const k of [0, 0.25, 7.5, 13.2, N - 1]) expect(gridAtElapsed(A.t, valueAt(A.t, k))).toBeCloseTo(k, 9);
  });
  it("valueAt clamps k and returns null for a missing series", () => {
    expect(valueAt([1, 3], 0.5)).toBe(2);
    expect(valueAt([1, 3], -4)).toBe(1);
    expect(valueAt([1, 3], 9)).toBe(3);
    expect(valueAt(undefined, 1)).toBe(null);
    expect(valueAt([], 1)).toBe(null);
  });
});

describe("lapTimeSeries under the playhead", () => {
  it("stays strictly increasing through a standstill, so gridAtElapsed is well defined", () => {
    const t = lapTimeSeries([0, 0, 0, 40, 80, 0, 0, 60], 20, 30_000);
    for (let k = 1; k < t.length; k++) expect(t[k]).toBeGreaterThan(t[k - 1]);
  });
});

describe("makeSide", () => {
  it("integrates the time curve once and takes a stored one instead", () => {
    expect(A.t[A.t.length - 1]).toBeCloseTo(15, 9);
    const stored = Array.from({ length: N }, (_, k) => k / 2);
    expect(makeSide("A", entryA, 20, null, stored).t).toBe(stored);
  });
  it("is null without a speed trace, and drops a clip with no offset", () => {
    expect(makeSide("A", { timeMs: 1 }, 20, null)).toBe(null);
    expect(makeSide("A", entryA, 20, { durationMs: 1 }).clip).toBe(null);
  });
});

describe("sideAtClipTime / clipTimeAtGrid", () => {
  it("round-trips at the line, mid-lap and the end", () => {
    for (const k of [0, 12.5, N - 1]) {
      const c = clipTimeAtGrid(A, k);
      const s = sideAtClipTime(A, c);
      expect(s.k).toBeCloseTo(k, 9);
      expect(s.inLap).toBe(true);
    }
    expect(clipTimeAtGrid(A, 0)).toBe(3_000);
    expect(clipTimeAtGrid(A, N - 1)).toBeCloseTo(18_000, 6);
  });
  it("is out of the lap in the pre- and post-roll", () => {
    expect(sideAtClipTime(A, 1_000)).toEqual({ e: -2, k: 0, inLap: false });
    const post = sideAtClipTime(A, 20_000);
    expect(post.inLap).toBe(false);
    expect(post.k).toBe(N - 1);
  });
  it("scrubs from two seconds before the line to two after", () => {
    expect(scrubRange(A).min).toBe(-2);
    expect(scrubRange(A).max).toBeCloseTo(17, 9);
  });
});

describe("playheadAt", () => {
  it("holds both cars at one distance in place mode", () => {
    const s = playheadAt({ a: A, b: B }, "A", 8, "place");
    expect(s.b.k).toBeCloseTo(s.a.k, 9);
    expect(s.b.e).toBeGreaterThan(8); // B is slower, so later at the same place
    expect(s.deltaS).toBeCloseTo(s.a.e - s.b.e, 9);
    expect(s.deltaS).toBeLessThan(0);
    expect(s.gapM).toBe(null);
    expect(s.b.clipMs).toBeCloseTo(3_400 + 1000 * s.b.e, 6);
  });
  it("holds both at one time in time mode, the gap negative when B is behind", () => {
    const s = playheadAt({ a: A, b: B }, "A", 8, "time");
    expect(s.b.e).toBe(8);
    expect(s.b.k).toBeLessThan(s.a.k);
    expect(s.gapM).toBeCloseTo((s.b.k - s.a.k) * 20, 9);
    expect(s.gapM).toBeLessThan(0);
  });
  it("follows a swapped master and still reports A's delta", () => {
    const s = playheadAt({ a: A, b: B }, "B", 8, "place");
    expect(s.masterKey).toBe("B");
    expect(s.b.e).toBe(8);
    expect(s.a.k).toBeCloseTo(s.b.k, 9);
    expect(s.deltaS).toBeLessThan(0);
  });
  it("is out of the lap before the line, with both cars the same time short of it", () => {
    const s = playheadAt({ a: A, b: B }, "A", -1.5, "place");
    expect(s.inLap).toBe(false);
    expect(s.b.e).toBe(-1.5);
    expect(s.a.inLap).toBe(false);
    expect(s.deltaS).toBe(null);
    expect(s.a.clipMs).toBe(1_500);
  });
  it("rolls both out the same time past the line in place mode", () => {
    const s = playheadAt({ a: A, b: B }, "A", 15.5, "place");
    expect(s.inLap).toBe(false);
    expect(s.b.e).toBeCloseTo(16.7, 9);
  });
  it("matches laps by fraction when their lengths differ past the warning", () => {
    const short = makeSide("B", { ...entryB, speed: speedB.slice(0, 25) }, 20, null);
    expect(matchByFraction(A, short)).toBe(true);
    const s = playheadAt({ a: A, b: short }, "A", 7, "place");
    expect(s.byFraction).toBe(true);
    expect(s.b.k).toBeCloseTo((s.a.k * 24) / 29, 9);
    expect(s.b.clipMs).toBe(null);
    expect(s.b.inClip).toBe(false);
  });
  it("is one-sided without B", () => {
    const s = playheadAt({ a: A, b: null }, "A", 4);
    expect(s.mode).toBe(DEFAULT_SYNC_MODE);
    expect(s.b).toBe(null);
    expect(s.deltaS).toBe(null);
    expect(s.a.now.speedKph).toBe(160);
    expect(s.a.now.gear).toBe(4);
  });
  it("says when a side's clip doesn't hold the moment", () => {
    const late = makeSide("A", entryA, 20, { lapOffsetMs: 500, durationMs: 9_000 });
    expect(playheadAt({ a: late, b: null }, "A", -1).a.inClip).toBe(false);
    expect(playheadAt({ a: late, b: null }, "A", 4).a.inClip).toBe(true);
    expect(playheadAt({ a: late, b: null }, "A", 10).a.inClip).toBe(false);
  });
});

describe("followRate / needsResync", () => {
  it("is the master's speed over the follower's, clamped", () => {
    expect(followRate({ a: A, b: B }, "A", 12)).toBeCloseTo(90 / 70, 9);
    expect(followRate({ a: A, b: null }, "A", 12)).toBe(1);
    const crawl = makeSide("B", { ...entryB, speed: speedB.map(() => 10) }, 20, null);
    expect(followRate({ a: A, b: crawl }, "A", 2)).toBe(FOLLOW_RATE_MAX);
    expect(followRate({ a: A, b: crawl }, "B", 2)).toBe(FOLLOW_RATE_MIN);
  });
  it("re-seeks only past RESYNC_MS", () => {
    expect(RESYNC_MS).toBe(150);
    expect(needsResync(1000, 1149)).toBe(false);
    expect(needsResync(1000, 1150)).toBe(false);
    expect(needsResync(1000, 1151)).toBe(true);
    expect(needsResync(1000, 849)).toBe(true);
  });
});

describe("words", () => {
  it("formats the clock, the delta and the gap", () => {
    expect(fmtStageTime(36)).toBe("0:36.0");
    expect(fmtStageTime(139.84)).toBe("2:19.8");
    expect(fmtStageTime(-1.5)).toBe("−0:01.5");
    expect(fmtStageTime(-0.01)).toBe("0:00.0");
    expect(fmtStageTime(59.96)).toBe("1:00.0");
    expect(fmtDeltaS(0.314)).toBe("+0.31 s");
    expect(fmtDeltaS(-0.12)).toBe("−0.12 s");
    expect(fmtDeltaS(0.004)).toBe("0.00 s");
    expect(fmtGap(26.2, "metric")).toBe("B ahead 26 m");
    expect(fmtGap(-26.2, "imperial")).toBe("A ahead 86 ft");
    expect(fmtGap(0.1, "metric")).toBe("Level");
  });
  it("places k among the corners", () => {
    expect(corners.map((c) => [c.k0, c.k1])).toEqual([[10, 14], [22, 25]]);
    expect(cornerPlace(corners, 3)).toBe("before T1");
    expect(cornerPlace(corners, 12)).toBe("in T1");
    expect(cornerPlace(corners, 18)).toBe("after T1");
    expect(cornerPlace(corners, 28)).toBe("after T2");
    expect(cornerPlace([], 5)).toBe(null);
  });
  it("words a corner, a straight and the run-up, in both systems", () => {
    const inCorner = playheadAt({ a: A, b: B }, "A", valueAt(A.t, 12), "place");
    expect(playheadText(inCorner, corners, "metric")).toEqual({
      place: "240 m · in T1",
      value: `${fmtStageTime(inCorner.a.e)}, 240 m, in T1, 90 km/h, throttle 20 %, ${fmtDeltaS(inCorner.deltaS)}`,
      delta: fmtDeltaS(inCorner.deltaS),
    });
    const braking = playheadAt({ a: A, b: null }, "A", valueAt(A.t, 9), "place");
    expect(playheadText(braking, corners, "imperial").value).toBe(`${fmtStageTime(braking.a.e)}, 591 ft, before T1, 99 mph, braking 70 %`);
    const time = playheadAt({ a: A, b: B }, "A", 12, "time");
    expect(playheadText(time, corners, "metric").delta).toBe(fmtGap(time.gapM, "metric"));
    expect(playheadText(playheadAt({ a: A, b: B }, "A", -1, "place"), corners, "metric")).toEqual({
      place: "Before the line",
      value: "−0:01.0, Before the line",
      delta: null,
    });
    expect(playheadText(playheadAt({ a: A, b: B }, "A", 16, "place"), corners, "metric").place).toBe("After the line");
  });
  it("stops at each corner's start", () => {
    expect(cornerStops(corners, A.t)).toEqual([
      { label: "T1", e: valueAt(A.t, 10) },
      { label: "T2", e: valueAt(A.t, 22) },
    ]);
  });
});

describe("referenceLap / stageSides", () => {
  const laps = [
    { lap_num: 1, time_ms: 95_000 },
    { lap_num: 2, time_ms: 91_000 },
    { lap_num: 3, time_ms: 92_000 },
    { lap_num: 4, time_ms: 90_500 }, // typed in: no channels
  ];
  const ch = [{ timeMs: 95_000 }, { timeMs: 91_000 }, { timeMs: 92_000 }];
  const matched = matchLapsToChannels(laps, ch);
  it("is the session best, the next-best for the best, or nothing alone", () => {
    expect(referenceLap(matched, 0).chIdx).toBe(1);
    expect(referenceLap(matched, 1).chIdx).toBe(2);
    expect(referenceLap(matchLapsToChannels([laps[0]], [ch[0]]), 0)).toBe(null);
  });
  it("puts the opened lap on A when lit, else the newest, and the fastest other on B", () => {
    expect(stageSides([0, 2, 1], ch, 2)).toEqual({ a: 2, b: 1 });
    expect(stageSides([0, 2], ch, 1)).toEqual({ a: 2, b: 0 });
    expect(stageSides([1], ch, 1)).toEqual({ a: 1, b: null });
    expect(stageSides([], ch, 1)).toBe(null);
  });
  it("names the two modes, place first", () => {
    expect(SYNC_MODES).toEqual(["place", "time"]);
    expect(DEFAULT_SYNC_MODE).toBe("place");
  });
});
