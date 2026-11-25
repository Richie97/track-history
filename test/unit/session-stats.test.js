import { describe, expect, it } from "vitest";
import { lapStatItems, paceTrend, sessionStatsHtml, sparkPoints, FADING_MS_PER_LAP } from "../../public/js/session-stats.js";

describe("session stats strip", () => {
  it("names a trend only past the drift threshold", () => {
    expect(paceTrend(null)).toBe(null);
    expect(paceTrend(FADING_MS_PER_LAP)).toBe(null);
    expect(paceTrend(FADING_MS_PER_LAP + 1)).toBe("fading");
    expect(paceTrend(-FADING_MS_PER_LAP - 1)).toBe("improving");
  });

  it("reduces the lap times to best-3, warm-up and pace", () => {
    const items = lapStatItems([130_000, 124_000, 121_000, 120_000, 120_200]);
    expect(items.map((i) => i.key)).toEqual(["best3", "warmup", "pace"]);
    expect(items[0]).toMatchObject({ key: "best3", label: "Best 3 avg" });
    expect(items[0].value).toMatch(/^2:00\.4/);
    expect(items[1].value).toMatch(/^Lap \d+$/);
    expect(items[2].value).toMatch(/\/lap$/);
  });

  it("marks a fading session and an improving one", () => {
    const fading = lapStatItems([120_000, 120_500, 121_000, 121_500, 122_000]).find((i) => i.key === "pace");
    expect(fading).toMatchObject({ value: "+0.5s/lap", note: "fading", tone: "warn" });
    const improving = lapStatItems([122_000, 121_500, 121_000, 120_500, 120_000]).find((i) => i.key === "pace");
    expect(improving).toMatchObject({ value: "-0.5s/lap", note: "improving", tone: "good" });
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

  it("draws a cell per item, sentences marked as text, and escapes them", () => {
    const html = sessionStatsHtml(
      [
        { key: "best3", label: "Best 3 avg", value: "2:00.40" },
        { key: "balance", label: "Balance", value: "understeer in <T1>", text: true },
      ],
      [122_000, 120_000, 121_000]
    );
    expect(html).toContain('class="s-stat spark"');
    expect(html).toContain('class="s-stat text"');
    expect(html).toContain("understeer in &lt;T1&gt;");
    expect((html.match(/role="listitem"/g) || []).length).toBe(3);
  });
});
