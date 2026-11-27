import { describe, expect, it } from "vitest";
import { POSTER_SIZES, posterFileName, posterStats, previewSignature, wrapWords } from "../../public/js/wrapped-image.js";

// One unit per character — enough to pin the wrap without a canvas.
const measure = (s) => s.length;

describe("wrapWords", () => {
  it("wraps greedily at word boundaries", () => {
    expect(wrapWords("Virginia International Raceway (Full)", 24, measure)).toEqual([
      "Virginia International",
      "Raceway (Full)",
    ]);
  });

  it("keeps a word longer than the line whole", () => {
    expect(wrapWords("Supercalifragilistic lap", 10, measure)).toEqual(["Supercalifragilistic", "lap"]);
  });

  it("is empty for an empty string", () => {
    expect(wrapWords("", 10, measure)).toEqual([]);
  });
});

describe("the poster image", () => {
  it("draws a story and a landscape at the sizes the share targets want", () => {
    expect(POSTER_SIZES.story).toEqual({ w: 1080, h: 1920 });
    expect(POSTER_SIZES.wide).toEqual({ w: 1200, h: 630 });
    expect(posterFileName(2026, "story")).toBe("track-evolution-2026-wrapped.png");
    expect(posterFileName(2026, "wide")).toBe("track-evolution-2026-wrapped-wide.png");
  });

  it("carries the numbers card's cells, distance only when measured", () => {
    const totals = { events: 9, track_days: 14, tracks: 6, laps: 1923, hours: 31.5, miles: 4281.4, miles_tracks_counted: 5 };
    expect(posterStats({ totals }, "imperial")).toEqual([
      ["14", "track days"],
      ["6", "tracks"],
      ["1,923", "laps"],
      ["4,281", "track miles"],
    ]);
    expect(posterStats({ totals: { ...totals, miles_tracks_counted: 0 } }, "imperial")).toHaveLength(3);
  });
});

describe("previewSignature", () => {
  const season = {
    year: 2026,
    name: "Eric",
    totals: { track_days: 3, tracks: 1, laps: 40, miles: 100, miles_tracks_counted: 1 },
    most_driven: { track_name: "Road Atlanta" },
    improvement: null,
    fastest: null,
    pro: { tire: { name: "Secret Tire Compound" } },
  };

  it("is the public poster's words: third person, and never the Pro tire", () => {
    const sig = previewSignature(season, "imperial");
    expect(sig).toContain("Eric's 2026 Track Evolution");
    expect(sig).toContain("Road Atlanta");
    expect(sig).not.toContain("Secret Tire Compound");
    expect(sig).toBe(previewSignature({ ...season, pro: null }, "imperial"));
  });

  it("changes when what the image says changes", () => {
    const sig = previewSignature(season, "imperial");
    expect(previewSignature({ ...season, totals: { ...season.totals, laps: 41 } }, "imperial")).not.toBe(sig);
    expect(previewSignature(season, "metric")).not.toBe(sig);
  });
});
