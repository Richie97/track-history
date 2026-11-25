import { describe, expect, it } from "vitest";
import { lapStatItems, peakStatItems, sessionPeaks, sessionStatsHtml, sparkPoints } from "../../public/js/session-stats.js";

describe("session stats strip", () => {
  it("reduces the lap times to best-3 and warm-up", () => {
    const items = lapStatItems([130_000, 124_000, 121_000, 120_000, 120_200]);
    expect(items.map((i) => i.key)).toEqual(["best3", "warmup"]);
    expect(items[0]).toMatchObject({ key: "best3", label: "Best 3 avg" });
    expect(items[0].value).toMatch(/^2:00\.4/);
    expect(items[1].value).toMatch(/^Lap \d+$/);
  });

  it("finds the session's top speed and peak cornering G across its laps", () => {
    const channels = {
      laps: [
        { speed: [80, 190.2, 120], latG: [0.2, 1.1] },
        { speed: [90, 201.6], latG: [1.34, 0.9] },
        { rpm: [4000] },
      ],
    };
    expect(sessionPeaks(channels)).toEqual({ topSpeedKph: 201.6, maxLatG: 1.34 });
    expect(peakStatItems(channels, "metric")).toEqual([
      { key: "topSpeed", label: "Top speed", value: "202 km/h" },
      { key: "maxG", label: "Max G", value: "1.34 G" },
    ]);
    expect(peakStatItems(channels, "imperial")[0].value).toBe("125 mph");
  });

  it("leaves out a peak the session stored no channel for", () => {
    expect(sessionPeaks(null)).toEqual({ topSpeedKph: null, maxLatG: null });
    expect(peakStatItems({ laps: [{ speed: [100] }] }, "metric").map((i) => i.key)).toEqual(["topSpeed"]);
    expect(peakStatItems({ laps: [{ rpm: [4000] }] }, "metric")).toEqual([]);
  });

  it("has nothing to say about no laps", () => {
    expect(lapStatItems([])).toEqual([]);
    expect(sessionStatsHtml([], [])).toBe("");
  });

  it("plots slower laps higher and finds the best lap", () => {
    expect(sparkPoints([120_000, 121_000], 96, 30)).toBe(null);
    const { points, best } = sparkPoints([122_000, 120_000, 121_000], 96, 30, 3);
    expect(best).toBe(1);
    expect(points[0]).toEqual({ x: 3, y: 3 });
    expect(points[1]).toEqual({ x: 48, y: 27 });
    expect(points[2].x).toBe(93);
  });

  it("draws a cell per figure, a line per sentence, and escapes them", () => {
    const html = sessionStatsHtml(
      [
        { key: "best3", label: "Best 3 avg", value: "2:00.40" },
        { key: "limits", label: "Limits", value: "ABS in <T1>", text: true },
      ],
      [122_000, 120_000, 121_000]
    );
    expect(html).toContain('class="s-stat spark"');
    expect(html).toContain('class="s-note"');
    expect(html).toContain("ABS in &lt;T1&gt;");
    expect((html.match(/role="listitem"/g) || []).length).toBe(3);
  });
});
