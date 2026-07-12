import { describe, expect, it } from "vitest";
import { lineChart, niceTimeTicks } from "../../public/js/chart.js";

describe("niceTimeTicks", () => {
  it("picks a step at least span/count from the nice-step table", () => {
    expect(niceTimeTicks(0, 4000)).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it("aligns ticks to step boundaries inside the range", () => {
    expect(niceTimeTicks(150, 950)).toEqual([200, 400, 600, 800]);
  });

  it("falls back to a huge step for very large spans", () => {
    const ticks = niceTimeTicks(0, 10_000_000);
    expect(ticks[1] - ticks[0]).toBe(300000);
  });
});

describe("lineChart", () => {
  const points = [
    { x: 1, y: 125000, xlabel: "May 1" },
    { x: 2, y: 122000, xlabel: "Jun 1" },
    { x: 3, y: 121000, xlabel: "Jul 1" },
  ];

  it("returns empty svg for no points", () => {
    const { svg } = lineChart([]);
    expect(svg).toBe("");
  });

  it("renders one marker per point plus a path", () => {
    const { svg } = lineChart(points);
    expect(svg.match(/<circle /g)).toHaveLength(3);
    expect(svg).toContain("<path d=\"M");
  });

  it("plots faster laps lower (y axis inverted)", () => {
    const { svg } = lineChart(points);
    const cys = [...svg.matchAll(/cy="([\d.]+)"/g)].map((m) => Number(m[1]));
    // last point is the fastest lap -> largest pixel y (lowest on screen)
    expect(cys[2]).toBeGreaterThan(cys[0]);
  });

  it("renders sparklines with a single end dot and no grid", () => {
    const { svg } = lineChart(points, { sparkline: true });
    expect(svg.match(/<circle /g)).toHaveLength(1);
    expect(svg).not.toContain("<line ");
  });

  it("draws an unbeaten goal in the danger colour", () => {
    const { svg } = lineChart(points, { goal: 120000 });
    expect(svg).toContain("var(--danger)");
    expect(svg).not.toContain("✓");
  });

  it("draws a beaten goal in the positive colour with a check", () => {
    const { svg } = lineChart(points, { goal: 121000 });
    expect(svg).toContain("var(--positive)");
    expect(svg).toContain("✓");
  });

  it("escapes user-controlled x labels", () => {
    const { svg } = lineChart([{ x: 1, y: 100000, xlabel: "<img>" }]);
    expect(svg).not.toContain("<img>");
    expect(svg).toContain("&lt;img&gt;");
  });
});
