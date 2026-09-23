import { describe, expect, it } from "vitest";
import { fmtDays, fmtGain, posterLines, trackDistance, wrappedCards, wrappedSeason } from "../../public/js/wrapped.js";
import { wrappedStoryHtml } from "../../public/js/wrapped-story.js";

// The golden's shape (contracts/golden/wrapped.json), trimmed to what the
// cards read.
const season = (over = {}) => ({
  year: 2026,
  years: [2026, 2025],
  through: null,
  name: "Eric",
  totals: { events: 9, track_days: 14, tracks: 6, laps: 1923, hours: 31.5, miles: 4281.4, miles_tracks_counted: 5 },
  most_driven: { track_id: 3, track_name: "VIR (Full)", track_days: 5, laps: 612, best_ms: 120_030 },
  improvement: { track_id: 7, track_name: "Summit Point", best_before: 94_120, best_this_year: 89_290, gain_ms: 4_830, baseline: "prior_years" },
  fastest: { track_id: 3, track_name: "VIR (Full)", best_ms: 120_030, event_id: 41, date: "2026-06-14" },
  new_tracks: [{ track_id: 9, track_name: "Road Atlanta" }],
  hottest: { event_id: 44, track_name: "VIR (Full)", date: "2026-07-19", temp_c: 34.5 },
  pro: null,
  ...over,
});
const kinds = (d) => wrappedCards(d).map((c) => (c.locked ? `${c.kind}:locked` : c.kind));

describe("wrappedSeason — the dashboard's reveal window", () => {
  it("promotes the running year from 1 November", () => {
    expect(wrappedSeason("2026-10-31")).toBeNull();
    expect(wrappedSeason("2026-11-01")).toBe(2026);
    expect(wrappedSeason("2026-12-31")).toBe(2026);
  });

  it("promotes the year just ended through 31 January", () => {
    expect(wrappedSeason("2027-01-01")).toBe(2026);
    expect(wrappedSeason("2027-01-31")).toBe(2026);
    expect(wrappedSeason("2027-02-01")).toBeNull();
  });

  it("is quiet the rest of the year", () => {
    for (const d of ["2026-03-15", "2026-06-30", "2026-09-23"]) expect(wrappedSeason(d), d).toBeNull();
  });

  it("reads a Date as the viewer's local day", () => {
    expect(wrappedSeason(new Date(2026, 10, 1, 0, 5))).toBe(2026);
    expect(wrappedSeason(new Date(2027, 0, 31, 23, 55))).toBe(2026);
  });
});

describe("wrappedCards — which cards a season gets", () => {
  it("runs in the spec's order, with the Pro cards locked on a free account", () => {
    expect(kinds(season())).toEqual([
      "cover", "numbers", "most_driven", "improvement", "fastest", "new_tracks", "hours", "hottest",
      "tire:locked", "top_speed:locked", "poster",
    ]);
  });

  it("skips a card with no data rather than drawing it empty", () => {
    expect(kinds(season({ improvement: null, fastest: null, new_tracks: [], hottest: null }))).toEqual([
      "cover", "numbers", "most_driven", "hours", "tire:locked", "top_speed:locked", "poster",
    ]);
  });

  it("shows a Pro account's cards, or nothing for the one with no data", () => {
    const tire = { part_id: 1, vehicle_id: 1, vehicle_name: "Corvette", name: "Falken RT660", track_days: 6, hours: 12 };
    expect(kinds(season({ pro: { tire, top_speed: null } })).slice(-3)).toEqual(["hottest", "tire", "poster"]);
    expect(kinds(season({ pro: { tire: null, top_speed: null } })).slice(-2)).toEqual(["hottest", "poster"]);
  });

  it("has no Pro cards at all on the public share, which carries no `pro` key", () => {
    const { pro, ...shared } = season();
    expect(kinds(shared)).not.toContain("tire:locked");
    expect(kinds(shared).at(-1)).toBe("poster");
  });
});

describe("the words", () => {
  it("formats the poster the way the spec's example reads", () => {
    const p = posterLines(season(), "imperial");
    expect(p.title).toBe("My 2026 Track Evolution");
    expect(p.headline).toEqual(["14 track days", "6 tracks", "1,923 laps", "4,281 track miles"]);
    expect(p.rows).toEqual([
      ["Most driven", "VIR (Full)"],
      ["Biggest improvement", "Summit Point, −4.83 s"],
      ["Fastest lap", "VIR (Full), 2:00.03"],
    ]);
    expect(posterLines(season(), "imperial", { share: true }).title).toBe("Eric's 2026 Track Evolution");
  });

  it("drops the distance when no track's length is known", () => {
    const d = season({ totals: { ...season().totals, miles: 0, miles_tracks_counted: 0 } });
    expect(posterLines(d, "imperial").headline).toHaveLength(3);
  });

  it("speaks the account's unit system", () => {
    expect(trackDistance(100, "imperial")).toEqual({ value: "100", unit: "track miles" });
    expect(trackDistance(100, "metric")).toEqual({ value: "161", unit: "track km" });
  });

  it("shows half days as halves, and gains to the hundredth", () => {
    expect(fmtDays(14)).toBe("14");
    expect(fmtDays(2.5)).toBe("2.5");
    expect(fmtGain(4_830)).toBe("4.83 s");
  });
});

describe("wrappedStoryHtml", () => {
  it("renders one card current and the rest inert, with a dot per card", () => {
    const html = wrappedStoryHtml(season(), { units: "imperial", share: false });
    expect(html.match(/class="wr-card /g)).toHaveLength(11);
    expect(html.match(/class="wr-dot[ "]/g)).toHaveLength(11);
    expect(html.match(/ inert>/g)).toHaveLength(10);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("4.83 s");
  });

  it("escapes what the driver typed", () => {
    const html = wrappedStoryHtml(season({ name: "<b>x</b>", most_driven: { ...season().most_driven, track_name: "<i>T</i>" } }), {
      units: "imperial",
      share: true,
    });
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<i>T</i>");
  });
});
