import { describe, expect, it } from "vitest";
import {
  BRAKING_PCT,
  FULL_THROTTLE_PCT,
  alignLapPair,
  comparableLaps,
  defaultComparePicks,
  drivenLengthM,
  lapMetrics,
  lengthMismatchRatio,
  resampleChannelLap,
} from "../../public/js/compare-laps.js";

const mkEvent = (id, date, sessions) => ({ id, start_date: date, club: null, sessions });
const mkSession = (id, laps, chLaps, label = null) => ({
  id,
  label,
  laps,
  channels: chLaps ? { v: 1, dStepM: 20, laps: chLaps } : null,
});

describe("comparableLaps", () => {
  it("flattens event details into pickable laps, skipping laps without channels", () => {
    const events = [
      mkEvent(7, "2026-06-01", [
        mkSession(
          40,
          [
            { lap_num: 1, time_ms: 92000 },
            { lap_num: 2, time_ms: 91000 },
            { lap_num: 3, time_ms: 90500 }, // hand-added: no channel entry
          ],
          [
            { n: 1, timeMs: 92000, speed: [10, 20] },
            { n: 2, timeMs: 91000, speed: [10, 20] },
          ],
          "AM"
        ),
        mkSession(41, [{ lap_num: 1, time_ms: 95000 }], null), // no channels at all
      ]),
      mkEvent(8, "2026-07-04", [
        mkSession(50, [{ lap_num: 1, time_ms: 89000 }], [{ n: 1, timeMs: 89000, speed: [10, 20] }]),
      ]),
    ];
    expect(comparableLaps(events)).toEqual([
      { eventId: 7, date: "2026-06-01", club: null, sessionId: 40, sessionLabel: "AM", lapNum: 1, timeMs: 92000, chIdx: 0 },
      { eventId: 7, date: "2026-06-01", club: null, sessionId: 40, sessionLabel: "AM", lapNum: 2, timeMs: 91000, chIdx: 1 },
      { eventId: 8, date: "2026-07-04", club: null, sessionId: 50, sessionLabel: null, lapNum: 1, timeMs: 89000, chIdx: 0 },
    ]);
  });

  it("returns an empty list when no session stored channels", () => {
    expect(comparableLaps([mkEvent(1, "2026-01-01", [mkSession(2, [{ lap_num: 1, time_ms: 1000 }], null)])])).toEqual([]);
  });
});

describe("defaultComparePicks", () => {
  const row = (date, timeMs) => ({ date, timeMs });

  it("picks the best lap of the latest event vs the overall best", () => {
    const rows = [
      row("2026-05-01", 90000), // overall best
      row("2026-05-01", 93000),
      row("2026-07-01", 92000), // best of latest → side A
      row("2026-07-01", 94000),
    ];
    expect(defaultComparePicks(rows)).toEqual({ a: 2, b: 0 });
  });

  it("falls back to the best of the rest when the latest best IS the overall best", () => {
    const rows = [row("2026-05-01", 95000), row("2026-07-01", 90000), row("2026-07-01", 91000)];
    expect(defaultComparePicks(rows)).toEqual({ a: 1, b: 2 });
  });

  it("needs two laps", () => {
    expect(defaultComparePicks([])).toBeNull();
    expect(defaultComparePicks([row("2026-05-01", 90000)])).toBeNull();
  });
});

describe("resampleChannelLap", () => {
  it("is the identity when the grid spacings match", () => {
    const entry = { n: 1, timeMs: 90000, speed: [100, 110, 120] };
    expect(resampleChannelLap(entry, 20, 20)).toBe(entry);
  });

  it("linearly interpolates onto a finer grid, endpoints preserved", () => {
    const entry = { n: 1, timeMs: 90000, speed: [100, 110, 120], latG: [0, 1, 0] };
    const out = resampleChannelLap(entry, 20, 10);
    expect(out.speed).toEqual([100, 105, 110, 115, 120]);
    expect(out.latG).toEqual([0, 0.5, 1, 0.5, 0]);
    expect(out.n).toBe(1);
    expect(out.timeMs).toBe(90000);
  });

  it("drops onto a coarser grid without reading past the end", () => {
    const entry = { n: 2, timeMs: 88000, speed: [100, 110, 120, 130, 140] };
    expect(resampleChannelLap(entry, 10, 20).speed).toEqual([100, 120, 140]);
  });

  it("skips channels the entry does not carry", () => {
    const out = resampleChannelLap({ n: 1, timeMs: 90000, speed: [1, 2] }, 20, 10);
    expect(out.throttle).toBeUndefined();
    expect(out.rpm).toBeUndefined();
  });
});

describe("alignLapPair", () => {
  it("passes both entries through unchanged when the grids already agree", () => {
    const a = { n: 1, timeMs: 90000, speed: [1, 2] };
    const b = { n: 2, timeMs: 91000, speed: [3, 4] };
    const pair = alignLapPair(a, 20, b, 20);
    expect(pair).toEqual({ v: 1, dStepM: 20, laps: [a, b] });
    expect(pair.laps[0]).toBe(a);
    expect(pair.laps[1]).toBe(b);
  });

  it("resamples side B onto side A's grid", () => {
    const a = { n: 1, timeMs: 90000, speed: [1, 2, 3] };
    const b = { n: 2, timeMs: 91000, speed: [100, 120] };
    const pair = alignLapPair(a, 10, b, 20);
    expect(pair.dStepM).toBe(10);
    expect(pair.laps[1].speed).toEqual([100, 110, 120]);
  });
});

describe("driven length and mismatch", () => {
  it("measures grid extent in meters", () => {
    expect(drivenLengthM({ speed: [1, 2, 3] }, 20)).toBe(40);
    expect(drivenLengthM({ speed: [1] }, 20)).toBe(0);
    expect(drivenLengthM({}, 20)).toBe(0);
  });

  it("is 0 for identical lengths and relative to the longer lap otherwise", () => {
    const a = { speed: Array(101).fill(1) }; // 2000 m at 20 m
    const b = { speed: Array(91).fill(1) }; // 1800 m
    expect(lengthMismatchRatio(a, 20, a, 20)).toBe(0);
    expect(lengthMismatchRatio(a, 20, b, 20)).toBeCloseTo(0.1, 10);
    // Different grids, same driven length: no mismatch.
    expect(lengthMismatchRatio(a, 20, { speed: Array(201).fill(1) }, 10)).toBe(0);
    expect(lengthMismatchRatio({}, 20, {}, 20)).toBe(0);
  });
});

describe("lapMetrics", () => {
  it("reduces channels to head-to-head numbers, thresholds inclusive", () => {
    const m = lapMetrics({
      n: 1,
      timeMs: 90000,
      speed: [80, 120, 100],
      rpm: [5000, 6400, 6000],
      latG: [0.2, 1.05, 0.8],
      throttle: [FULL_THROTTLE_PCT, 100, 40, 0], // 2 of 4 at/over the cutoff
      brake: [0, BRAKING_PCT, 80, 0], // 2 of 4
    });
    expect(m).toEqual({
      timeMs: 90000,
      topSpeedKph: 120,
      minSpeedKph: 80,
      avgSpeedKph: 100,
      maxRpm: 6400,
      maxLatG: 1.05,
      fullThrottlePct: 50,
      brakingPct: 50,
    });
  });

  it("returns null for channels the lap did not store", () => {
    const m = lapMetrics({ n: 1, timeMs: 90000, speed: [100] });
    expect(m.maxRpm).toBeNull();
    expect(m.maxLatG).toBeNull();
    expect(m.fullThrottlePct).toBeNull();
    expect(m.brakingPct).toBeNull();
    const none = lapMetrics({ n: 1, timeMs: 90000 });
    expect(none.topSpeedKph).toBeNull();
    expect(none.avgSpeedKph).toBeNull();
  });
});
