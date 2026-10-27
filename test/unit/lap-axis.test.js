import { describe, expect, it } from "vitest";
import {
  AXIS_MODES,
  DEFAULT_AXIS,
  axisAtGrid,
  axisExtent,
  axisFrame,
  axisPlaces,
  fmtAxisSeconds,
  fmtAxisValue,
  gridAtAxis,
  lapAxisSeries,
  timeAxisTicks,
} from "../../public/js/lap-axis.js";
import { TABS, TAB_OF, channelChartSvg, deltaChartSvg, lapTimeSeries } from "../../public/js/channel-graphs.js";
import { gearRibbonSvg } from "../../public/js/gears.js";
import { CHANNEL_DEFS } from "../../public/js/channel-graphs.js";

// Two laps on a 20 m grid: B is slower through the middle and a grid point
// shorter, so the two axes put them in different places.
const A = { n: 1, timeMs: 10000, speed: [100, 120, 140, 140, 120, 100, 110, 130, 150, 160, 160, 150], throttle: [50, 80, 100, 100, 60, 20, 60, 90, 100, 100, 100, 90], gear: [3, 3, 4, 4, 3, 3, 3, 4, 4, 4, 4, 4] };
const B = { n: 2, timeMs: 11000, speed: [95, 110, 120, 120, 100, 90, 100, 120, 140, 150, 150], throttle: [40, 70, 90, 90, 50, 10, 50, 80, 95, 100, 100], gear: [3, 3, 4, 4, 3, 3, 3, 4, 4, 4, 4] };
const channels = { v: 1, dStepM: 20, laps: [A, B] };

describe("panel tabs", () => {
  it("is three tabs, Traces first", () => {
    expect(TABS.map((t) => t.key)).toEqual(["traces", "grip", "car"]);
    expect(TABS[0].label).toBe("Traces");
  });

  it("puts the delta, speed and every input on Traces", () => {
    for (const k of ["delta", "speed", "throttle", "brake", "steering", "rpm"]) expect(TAB_OF[k]).toBe("traces");
    expect(TAB_OF.latG).toBe("grip");
    expect(TAB_OF.yaw).toBe("grip");
  });
});

describe("lapAxisSeries", () => {
  it("is k times the grid step on distance", () => {
    expect(lapAxisSeries(A, 20, "distance")).toEqual([0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220]);
  });

  it("is the lap's own elapsed time on time, ending on the timed lap", () => {
    const xs = lapAxisSeries(A, 20, "time");
    expect(xs).toEqual(lapTimeSeries(A.speed, 20, A.timeMs));
    expect(xs[xs.length - 1]).toBeCloseTo(10, 9);
  });

  it("has nothing for a lap with no speed on time, but a grid on distance", () => {
    const noSpeed = { n: 3, timeMs: 9000, throttle: [1, 2, 3] };
    expect(lapAxisSeries(noSpeed, 20, "time")).toBeNull();
    expect(lapAxisSeries(noSpeed, 20, "distance")).toEqual([0, 20, 40]);
    expect(lapAxisSeries({}, 20, "distance")).toBeNull();
  });
});

describe("axisExtent / gridAtAxis / axisAtGrid", () => {
  it("is the longest lap on either axis", () => {
    expect(axisExtent([A, B], 20, "distance")).toBe(220);
    expect(axisExtent([A, B], 20, "time")).toBeCloseTo(11, 9);
    expect(axisExtent([], 20, "time")).toBe(0);
  });

  it("finds a fractional grid index, and nothing off the lap", () => {
    const xs = lapAxisSeries(A, 20, "distance");
    expect(gridAtAxis(xs, 50)).toBeCloseTo(2.5, 9);
    expect(gridAtAxis(xs, 0)).toBe(0);
    expect(gridAtAxis(xs, 220)).toBe(11);
    expect(gridAtAxis(xs, 221)).toBeNull();
    expect(gridAtAxis(xs, -1)).toBeNull();
    expect(gridAtAxis(null, 5)).toBeNull();
  });

  it("round-trips", () => {
    const xs = lapAxisSeries(A, 20, "time");
    expect(axisAtGrid(xs, gridAtAxis(xs, 4.2))).toBeCloseTo(4.2, 9);
    expect(axisAtGrid(xs, -3)).toBe(0);
    expect(axisAtGrid(xs, 99)).toBe(xs[xs.length - 1]);
  });
});

describe("axisPlaces", () => {
  it("puts both laps at the same index on distance", () => {
    const p = axisPlaces([A, B], 20, "distance", 100, [0, 1]);
    expect(p.map((x) => x.chIdx)).toEqual([0, 1]);
    expect(p[0].k).toBeCloseTo(5, 9);
    expect(p[1].k).toBeCloseTo(5, 9);
    expect(p[0].frac).toBeCloseTo(5 / 11, 9);
    expect(p[1].frac).toBeCloseTo(5 / 10, 9);
  });

  it("leaves the slower lap behind on time", () => {
    const [a, b] = axisPlaces([A, B], 20, "time", 5, [0, 1]);
    expect(b.k).toBeLessThan(a.k);
  });

  it("drops a lap the value is past, in the caller's order", () => {
    const p = axisPlaces([A, B], 20, "distance", 210, [1, 0]);
    expect(p.map((x) => x.chIdx)).toEqual([0]);
  });
});

describe("time ticks and words", () => {
  it("steps so a lap gets at most six ticks", () => {
    expect(timeAxisTicks(10).map((t) => t.s)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(timeAxisTicks(125).map((t) => t.label)).toEqual(["0:00", "0:30", "1:00", "1:30", "2:00"]);
    expect(timeAxisTicks(0)).toEqual([]);
  });

  it("says minutes and seconds", () => {
    expect(fmtAxisSeconds(65)).toBe("1:05");
    expect(fmtAxisValue(83.46, "time", "imperial")).toBe("1:23.5");
    expect(fmtAxisValue(59.96, "time", "imperial")).toBe("1:00.0");
    expect(fmtAxisValue(1234.4, "distance", "metric")).toBe("1.2 km");
    expect(fmtAxisValue(null, "time", "metric")).toBe("—");
  });

  it("defaults to distance", () => {
    expect(AXIS_MODES).toEqual(["distance", "time"]);
    expect(DEFAULT_AXIS).toBe("distance");
  });
});

describe("charts on a time axis", () => {
  const lit = new Map([[0, "var(--chart-line)"], [1, "var(--chart-line-b)"]]);
  const throttle = CHANNEL_DEFS.find((d) => d.key === "throttle");

  it("labels the axis in m:ss and says so", () => {
    const svg = channelChartSvg(throttle, channels, lit, { axis: axisFrame(channels.laps, 20, "time", "imperial") });
    expect(svg).toContain('data-axis="time"');
    expect(svg).toContain("Throttle by time");
    expect(svg).toContain(">0:10<");
  });

  it("keeps distance as the default", () => {
    const svg = channelChartSvg(throttle, channels, lit);
    expect(svg).toContain('data-axis="distance"');
    expect(svg).toContain('data-x1="220"');
  });

  it("draws the delta against the reference lap's time", () => {
    const svg = deltaChartSvg(channels, lit, 0, 1, { axis: axisFrame(channels.laps, 20, "time", "imperial") });
    expect(svg).toContain('data-axis="time"');
    expect(svg).toContain('data-ref="0"');
  });

  it("leaves the gear ribbon's disagreement boxes off on time", () => {
    const dist = gearRibbonSvg(channels, lit, (i) => `Lap ${i + 1}`);
    const time = gearRibbonSvg(channels, lit, (i) => `Lap ${i + 1}`, { axis: axisFrame(channels.laps, 20, "time", "imperial") });
    expect(time).toContain('data-axis="time"');
    expect(time).not.toContain("laps disagree");
    expect(dist).toContain('data-axis="distance"');
  });
});
