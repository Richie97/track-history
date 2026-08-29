import { describe, expect, it } from "vitest";
import {
  channelChartSvg,
  deltaChartSvg,
  deltaSeries,
  lapTimeSeries,
  matchLapsToChannels,
} from "../../public/js/channel-graphs.js";
import { niceNumTicks } from "../../public/js/chart.js";

const mkChannels = () => ({
  v: 1,
  dStepM: 20,
  laps: [
    { n: 1, timeMs: 48000, speed: Array.from({ length: 90 }, (_, k) => 120 + 40 * Math.sin(k / 6)), rpm: Array(90).fill(5000) },
    { n: 2, timeMs: 47000, speed: Array.from({ length: 90 }, (_, k) => 125 + 40 * Math.sin(k / 6)) },
  ],
});

describe("niceNumTicks", () => {
  it("produces 1/2/2.5/5-stepped ticks covering the range", () => {
    expect(niceNumTicks(0, 100, 4)).toEqual([0, 25, 50, 75, 100]);
    expect(niceNumTicks(0, 1780, 6)).toEqual([0, 500, 1000, 1500]); // 1780/6≈297 snaps to 500
    const g = niceNumTicks(0, 1.4, 3);
    expect(g[0]).toBe(0);
    expect(g[g.length - 1]).toBeLessThanOrEqual(1.4);
  });
});

describe("matchLapsToChannels", () => {
  it("pairs lap rows to channel entries by exact time, -1 for laps without channels", () => {
    const chLaps = [
      { n: 1, timeMs: 48000 },
      { n: 2, timeMs: 47000 },
    ];
    const laps = [
      { lap_num: 1, time_ms: 48000 },
      { lap_num: 2, time_ms: 47000 },
      { lap_num: 3, time_ms: 49000 }, // hand-added after import: no channel data
    ];
    expect(matchLapsToChannels(laps, chLaps)).toEqual([
      { lap: laps[0], chIdx: 0 },
      { lap: laps[1], chIdx: 1 },
      { lap: laps[2], chIdx: -1 },
    ]);
  });

  it("matches duplicate times one-to-one in order", () => {
    const chLaps = [
      { n: 1, timeMs: 47000 },
      { n: 2, timeMs: 47000 },
    ];
    const laps = [
      { lap_num: 1, time_ms: 47000 },
      { lap_num: 2, time_ms: 47000 },
    ];
    expect(matchLapsToChannels(laps, chLaps).map((r) => r.chIdx)).toEqual([0, 1]);
  });
});

describe("lapTimeSeries", () => {
  it("integrates elapsed time from constant speed: one second per 20 m cell at 72 km/h", () => {
    const t = lapTimeSeries(Array(11).fill(72), 20, null);
    expect(t[0]).toBe(0);
    expect(t[10]).toBeCloseTo(10, 9);
    expect(t[3]).toBeCloseTo(3, 9);
  });

  it("scales so the last point lands exactly on the timed duration", () => {
    const t = lapTimeSeries(Array(11).fill(72), 20, 25000); // integral says 10 s, timer says 25 s
    expect(t[10]).toBeCloseTo(25, 9);
    expect(t[5]).toBeCloseTo(12.5, 9); // uniformly rescaled
  });

  it("clamps zero-speed samples instead of producing Infinity", () => {
    const t = lapTimeSeries([0, 0, 72, 72], 20, null);
    expect(t.every(Number.isFinite)).toBe(true);
    expect(t[3]).toBeGreaterThan(t[2]);
  });
});

describe("deltaSeries", () => {
  it("is positive where the lap is slower than the reference", () => {
    const ref = { speed: Array(30).fill(144), timeMs: null }; // 0.5 s/cell
    const lap = { speed: Array(30).fill(72), timeMs: null }; // 1 s/cell
    const d = deltaSeries(lap, ref, 20);
    expect(d[0]).toBe(0);
    expect(d[10]).toBeCloseTo(5, 9); // +0.5 s per cell
    expect(d).toHaveLength(30);
  });

  it("ends at the timed lap-time difference when durations are given", () => {
    const ref = { speed: Array(30).fill(100), timeMs: 47000 };
    const lap = { speed: Array(30).fill(100), timeMs: 48200 };
    const d = deltaSeries(lap, ref, 20);
    expect(d[d.length - 1]).toBeCloseTo(1.2, 9);
  });

  it("truncates to the shorter lap and rejects laps without speed or too little overlap", () => {
    const ref = { speed: Array(30).fill(100), timeMs: null };
    expect(deltaSeries({ speed: Array(20).fill(100), timeMs: null }, ref, 20)).toHaveLength(20);
    expect(deltaSeries({ rpm: Array(30).fill(5000) }, ref, 20)).toBeNull();
    expect(deltaSeries({ speed: Array(5).fill(100), timeMs: null }, ref, 20)).toBeNull();
  });
});

describe("deltaChartSvg", () => {
  it("draws one delta path per highlighted lap, none for the reference itself", () => {
    const lit = new Map([
      [0, "var(--chart-line)"],
      [1, "var(--chart-line-b)"],
    ]);
    const svg = deltaChartSvg(mkChannels(), lit, 1, 2); // lap 2 (idx 1) is the reference
    expect(svg).toContain('data-channel="delta"');
    expect((svg.match(/<path/g) || []).length).toBe(1); // only lap 1's delta
    expect(svg).toContain("vs lap 2");
  });

  it("returns '' when only the reference is highlighted", () => {
    const lit = new Map([[1, "var(--chart-line)"]]);
    expect(deltaChartSvg(mkChannels(), lit, 1, 2)).toBe("");
  });
});

describe("channelChartSvg", () => {
  it("draws every lap, highlighted on top of the dim envelope", () => {
    const lit = new Map([[1, "var(--chart-line)"]]);
    const svg = channelChartSvg(
      { key: "speed", label: "Speed", unit: "mph", conv: (v) => v * 0.621371, dp: 0, floor0: false },
      mkChannels(),
      lit
    );
    expect(svg).toContain('data-channel="speed"');
    expect((svg.match(/<path/g) || []).length).toBe(2);
    expect(svg).toContain('stroke="var(--chart-dim)"'); // lap 1: context
    expect(svg).toContain('stroke="var(--chart-line)"'); // lap 2: highlighted
    expect(svg).toContain("Speed (mph)");
  });

  it("skips laps missing the channel and returns '' when none carry it", () => {
    const chans = mkChannels();
    const rpmSvg = channelChartSvg(
      { key: "rpm", label: "RPM", unit: "rpm", conv: (v) => v, dp: 0, floor0: false },
      chans,
      new Map()
    );
    expect((rpmSvg.match(/<path/g) || []).length).toBe(1); // only lap 1 has rpm
    const none = channelChartSvg(
      { key: "latG", label: "Lateral G", unit: "G", conv: (v) => v, dp: 2, floor0: true },
      chans,
      new Map()
    );
    expect(none).toBe("");
  });
});
