import { describe, expect, it } from "vitest";
import { channelChartSvg } from "../../public/js/channel-graphs.js";
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
