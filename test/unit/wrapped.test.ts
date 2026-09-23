import { describe, expect, it } from "vitest";
import {
  lapLengthM,
  median,
  polylineLength,
  seasonWrapped,
  wrappedYears,
  type WrappedEvent,
  type WrappedInputs,
} from "../../src/lib/wrapped";

let seq = 0;
const ev = (o: Partial<WrappedEvent> & { track_id: number; start_date: string }): WrappedEvent => ({
  id: ++seq,
  track_name: `Track ${o.track_id}`,
  days: 1,
  best_ms: null,
  lap_count: 0,
  hours: 2,
  temp_f: null,
  ambient_hi_c: null,
  ...o,
});

const inputs = (events: WrappedEvent[], extra: Partial<WrappedInputs> = {}): WrappedInputs => ({
  name: "Eric",
  events,
  catalogLengths: [],
  channelLaps: [],
  traces: [],
  ...extra,
});

const TODAY = "2026-09-23";

describe("seasonWrapped — the season", () => {
  it("is null for a year with no past events (the route's 404)", () => {
    expect(seasonWrapped(inputs([ev({ track_id: 1, start_date: "2025-05-01" })]), 2026, TODAY)).toBeNull();
    // An upcoming event is not a track day driven yet.
    expect(seasonWrapped(inputs([ev({ track_id: 1, start_date: "2026-10-01" })]), 2026, TODAY)).toBeNull();
  });

  it("counts past events of the calendar year only", () => {
    const w = seasonWrapped(
      inputs([
        ev({ track_id: 1, start_date: "2025-12-31", days: 5, lap_count: 50 }),
        ev({ track_id: 1, start_date: "2026-01-01", days: 2, lap_count: 30, hours: 4 }),
        ev({ track_id: 2, start_date: "2026-09-23", days: 1, lap_count: 10, hours: 2.5 }),
        ev({ track_id: 2, start_date: "2026-09-24", days: 3, lap_count: 99 }),
      ]),
      2026,
      TODAY
    )!;
    expect(w.totals).toMatchObject({ events: 2, track_days: 3, tracks: 2, laps: 40, hours: 6.5 });
  });

  it("lists every year with a past event, newest first", () => {
    const evs = [
      ev({ track_id: 1, start_date: "2024-03-01" }),
      ev({ track_id: 1, start_date: "2026-03-01" }),
      ev({ track_id: 1, start_date: "2024-06-01" }),
      ev({ track_id: 1, start_date: "2027-01-01" }),
    ];
    expect(wrappedYears(evs, TODAY)).toEqual([2026, 2024]);
    expect(seasonWrapped(inputs(evs), 2024, TODAY)!.years).toEqual([2026, 2024]);
  });

  it("says `through` today while the year is running, null once it has ended", () => {
    const evs = [ev({ track_id: 1, start_date: "2025-03-01" }), ev({ track_id: 1, start_date: "2026-03-01" })];
    expect(seasonWrapped(inputs(evs), 2026, TODAY)!.through).toBe(TODAY);
    expect(seasonWrapped(inputs(evs), 2025, TODAY)!.through).toBeNull();
  });
});

describe("most driven", () => {
  it("is the track with the most track days", () => {
    const w = seasonWrapped(
      inputs([
        ev({ track_id: 1, start_date: "2026-03-01", days: 1, lap_count: 90 }),
        ev({ track_id: 2, start_date: "2026-04-01", days: 2, lap_count: 10, best_ms: 90_000 }),
        ev({ track_id: 2, start_date: "2026-05-01", days: 1, lap_count: 5, best_ms: 88_000 }),
      ]),
      2026,
      TODAY
    )!;
    expect(w.most_driven).toEqual({ track_id: 2, track_name: "Track 2", track_days: 3, laps: 15, best_ms: 88_000 });
  });

  it("breaks a tie on days by laps, then by events", () => {
    const byLaps = seasonWrapped(
      inputs([
        ev({ track_id: 1, start_date: "2026-03-01", days: 2, lap_count: 10 }),
        ev({ track_id: 2, start_date: "2026-04-01", days: 2, lap_count: 20 }),
      ]),
      2026,
      TODAY
    )!;
    expect(byLaps.most_driven!.track_id).toBe(2);

    const byEvents = seasonWrapped(
      inputs([
        ev({ track_id: 1, start_date: "2026-03-01", days: 2, lap_count: 10 }),
        ev({ track_id: 2, start_date: "2026-04-01", days: 1, lap_count: 5 }),
        ev({ track_id: 2, start_date: "2026-05-01", days: 1, lap_count: 5 }),
      ]),
      2026,
      TODAY
    )!;
    expect(byEvents.most_driven!.track_id).toBe(2);
  });

  it("has a null best when nothing there was timed", () => {
    const w = seasonWrapped(inputs([ev({ track_id: 1, start_date: "2026-03-01" })]), 2026, TODAY)!;
    expect(w.most_driven!.best_ms).toBeNull();
  });
});

describe("biggest improvement", () => {
  it("is the largest positive gain against a prior year's best", () => {
    const w = seasonWrapped(
      inputs([
        ev({ track_id: 1, start_date: "2025-05-01", best_ms: 100_000 }),
        ev({ track_id: 1, start_date: "2026-05-01", best_ms: 98_000 }),
        ev({ track_id: 2, start_date: "2024-05-01", best_ms: 94_120 }),
        ev({ track_id: 2, start_date: "2025-05-01", best_ms: 95_000 }),
        ev({ track_id: 2, start_date: "2026-06-01", best_ms: 89_290 }),
      ]),
      2026,
      TODAY
    )!;
    expect(w.improvement).toEqual({
      track_id: 2,
      track_name: "Track 2",
      best_before: 94_120,
      best_this_year: 89_290,
      gain_ms: 4_830,
      baseline: "prior_years",
    });
  });

  it("falls back to a first year's in-year gain when no prior-year track improved", () => {
    const w = seasonWrapped(
      inputs([
        // Slower than last year: no prior-years gain.
        ev({ track_id: 1, start_date: "2025-05-01", best_ms: 100_000 }),
        ev({ track_id: 1, start_date: "2026-05-01", best_ms: 101_000 }),
        // New this year: first timed event 95 s, then 92 s.
        ev({ track_id: 2, start_date: "2026-06-01" }),
        ev({ track_id: 2, start_date: "2026-07-01", best_ms: 95_000 }),
        ev({ track_id: 2, start_date: "2026-08-01", best_ms: 92_000 }),
      ]),
      2026,
      TODAY
    )!;
    expect(w.improvement).toMatchObject({ track_id: 2, best_before: 95_000, best_this_year: 92_000, gain_ms: 3_000, baseline: "first_event" });
  });

  it("prefers any prior-years gain over a bigger first-year one", () => {
    const w = seasonWrapped(
      inputs([
        ev({ track_id: 1, start_date: "2025-05-01", best_ms: 100_000 }),
        ev({ track_id: 1, start_date: "2026-05-01", best_ms: 99_900 }),
        ev({ track_id: 2, start_date: "2026-07-01", best_ms: 99_000 }),
        ev({ track_id: 2, start_date: "2026-08-01", best_ms: 90_000 }),
      ]),
      2026,
      TODAY
    )!;
    expect(w.improvement).toMatchObject({ track_id: 1, gain_ms: 100, baseline: "prior_years" });
  });

  it("never uses the in-year fallback at a track with a prior baseline", () => {
    // Slower than last year overall, but quicker through the year — the card
    // would call it a first year, which it isn't.
    const w = seasonWrapped(
      inputs([
        ev({ track_id: 1, start_date: "2025-05-01", best_ms: 90_000 }),
        ev({ track_id: 1, start_date: "2026-05-01", best_ms: 99_000 }),
        ev({ track_id: 1, start_date: "2026-06-01", best_ms: 95_000 }),
      ]),
      2026,
      TODAY
    )!;
    expect(w.improvement).toBeNull();
  });

  it("is null when no timed track gained anything", () => {
    const w = seasonWrapped(inputs([ev({ track_id: 1, start_date: "2026-05-01", best_ms: 99_000 })]), 2026, TODAY)!;
    expect(w.improvement).toBeNull();
  });
});

describe("fastest lap", () => {
  it("is the year's lowest best, with its event and date", () => {
    const a = ev({ track_id: 1, start_date: "2026-03-01", best_ms: 120_030 });
    const b = ev({ track_id: 2, start_date: "2026-04-01", best_ms: 89_000 });
    const w = seasonWrapped(
      inputs([a, b, ev({ track_id: 3, start_date: "2025-01-01", best_ms: 50_000 })]),
      2026,
      TODAY
    )!;
    expect(w.fastest).toEqual({ track_id: 2, track_name: "Track 2", best_ms: 89_000, event_id: b.id, date: "2026-04-01" });
  });

  it("keeps the earliest on a tie, and is null with nothing timed", () => {
    const a = ev({ track_id: 1, start_date: "2026-03-01", best_ms: 90_000 });
    const w = seasonWrapped(inputs([ev({ track_id: 2, start_date: "2026-04-01", best_ms: 90_000 }), a]), 2026, TODAY)!;
    expect(w.fastest!.event_id).toBe(a.id);
    expect(seasonWrapped(inputs([ev({ track_id: 1, start_date: "2026-03-01" })]), 2026, TODAY)!.fastest).toBeNull();
  });
});

describe("new tracks", () => {
  it("are the year's tracks with no event before the year", () => {
    const w = seasonWrapped(
      inputs([
        ev({ track_id: 1, start_date: "2025-05-01" }),
        ev({ track_id: 1, start_date: "2026-05-01" }),
        ev({ track_id: 2, start_date: "2026-06-01" }),
      ]),
      2026,
      TODAY
    )!;
    expect(w.new_tracks).toEqual([{ track_id: 2, track_name: "Track 2" }]);
  });
});

describe("hottest day", () => {
  it("reads each event's recorded high over its typed temperature", () => {
    const hot = ev({ track_id: 1, start_date: "2026-07-19", ambient_hi_c: 34.5, temp_f: 70 });
    const w = seasonWrapped(
      inputs([hot, ev({ track_id: 2, start_date: "2026-08-01", temp_f: 90 })]),
      2026,
      TODAY
    )!;
    // 90 °F is 32.2 °C, cooler than the 34.5 °C recorded — and the 70 °F typed
    // on the recorded day is never the figure.
    expect(w.hottest).toEqual({ event_id: hot.id, track_name: "Track 1", date: "2026-07-19", temp_c: 34.5 });
  });

  it("falls back to the typed temperature, converted", () => {
    const w = seasonWrapped(inputs([ev({ track_id: 1, start_date: "2026-07-19", temp_f: 95 })]), 2026, TODAY)!;
    expect(w.hottest!.temp_c).toBe(35);
  });

  it("is null with no reading at all", () => {
    expect(seasonWrapped(inputs([ev({ track_id: 1, start_date: "2026-07-19" })]), 2026, TODAY)!.hottest).toBeNull();
  });
});

describe("track miles", () => {
  it("resolves a lap length catalog first, then telemetry laps, then traces", () => {
    expect(lapLengthM(5263, [4000], [3000])).toBe(5263);
    expect(lapLengthM(null, [3000, 3100, 5000], [9999])).toBe(3100);
    expect(lapLengthM(null, [], [2000, 2200])).toBe(2100);
    expect(lapLengthM(null, [], [])).toBeNull();
  });

  it("measures a trace as a closed loop", () => {
    // A 100 m square whose last point stops short of the first.
    expect(polylineLength([[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]])).toBe(400);
    expect(polylineLength(JSON.stringify([[0, 0], [30, 40]]))).toBe(100);
    expect(polylineLength("not json")).toBeNull();
    expect(polylineLength([[0, 0]])).toBeNull();
  });

  it("sums logged laps × lap length and counts the tracks it could measure", () => {
    const w = seasonWrapped(
      inputs(
        [
          ev({ track_id: 1, start_date: "2026-03-01", lap_count: 100 }), // catalog 1609.344 m
          ev({ track_id: 2, start_date: "2026-04-01", lap_count: 10 }), // channel laps
          ev({ track_id: 3, start_date: "2026-05-01", lap_count: 20 }), // trace
          ev({ track_id: 4, start_date: "2026-06-01", lap_count: 50 }), // unknown
          ev({ track_id: 1, start_date: "2025-01-01", lap_count: 1000 }), // another year
        ],
        {
          catalogLengths: [
            { track_id: 1, length_m: 1609.344 },
            { track_id: 2, length_m: null },
          ],
          channelLaps: [
            { track_id: 2, length_m: 3218.688 },
            { track_id: 2, length_m: 3218.688 },
          ],
          traces: [{ track_id: 3, trace: [[0, 0], [804.672, 0]] }], // closed: 1609.344 m
        }
      ),
      2026,
      TODAY
    )!;
    expect(w.totals.miles).toBe(100 + 20 + 20);
    expect(w.totals.tracks).toBe(4);
    expect(w.totals.miles_tracks_counted).toBe(3);
  });

  it("takes the median, so one odd lap doesn't move it", () => {
    expect(median([1, 2, 100])).toBe(2);
    expect(median([1, 3])).toBe(2);
    expect(median([])).toBeNull();
  });
});
