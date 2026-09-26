import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOURS_PER_DAY,
  equipSwapKinds,
  eventHours,
  eventShares,
  eventsInWindow,
  serviceWindows,
  sharedHours,
  wearEstimate,
  type HoursEvent,
} from "../../src/lib/wear";

const TODAY = "2026-07-19";

const ev = (start_date: string, days = 2, extra: Partial<HoursEvent> = {}): HoursEvent => ({
  start_date,
  days,
  track_hours: null,
  lap_ms_sum: null,
  lap_count: null,
  ...extra,
});

describe("eventHours", () => {
  it("defaults to 1h15m per day", () => {
    expect(DEFAULT_HOURS_PER_DAY).toBe(1.25);
    expect(eventHours(ev("2026-05-01", 2))).toBe(2.5);
    expect(eventHours(ev("2026-05-01", 0.5))).toBe(0.625);
  });

  it("an explicit override wins over everything", () => {
    expect(eventHours(ev("2026-05-01", 2, { track_hours: 5.5 }))).toBe(5.5);
    expect(eventHours(ev("2026-05-01", 2, { track_hours: 1, lap_ms_sum: 20_000_000 }))).toBe(1);
  });

  it("3+ logged laps replace the day-count estimate in both directions", () => {
    // 3h of laps on a 1-day event beats the 1h15m estimate...
    expect(eventHours(ev("2026-05-01", 1, { lap_ms_sum: 3 * 3_600_000, lap_count: 90 }))).toBe(3);
    // ...and 45min of laps on a 1-day event pulls it down from 1h15m.
    expect(eventHours(ev("2026-05-01", 1, { lap_ms_sum: 45 * 60_000, lap_count: 22 }))).toBeCloseTo(0.75);
    // Exactly MIN_TIMED_LAPS counts.
    expect(eventHours(ev("2026-05-01", 2, { lap_ms_sum: 6 * 60_000, lap_count: 3 }))).toBeCloseTo(0.1);
  });

  it("fewer than 3 laps is sparse logging and keeps the estimate", () => {
    // A best-lap-only history says nothing about seat time.
    expect(eventHours(ev("2026-05-01", 2, { lap_ms_sum: 2 * 120_000, lap_count: 2 }))).toBe(2.5);
    expect(eventHours(ev("2026-05-01", 1, { lap_ms_sum: 5 * 3_600_000, lap_count: 2 }))).toBe(1.25);
  });
});

describe("eventsInWindow", () => {
  const events = [ev("2025-04-12"), ev("2025-11-01"), ev("2026-02-14"), ev("2026-08-08")];

  it("keeps events between install and retire, excluding upcoming ones", () => {
    const part = { installed_on: "2025-06-01", retired_on: null };
    expect(eventsInWindow(part, events, TODAY).map((e) => e.start_date)).toEqual([
      "2025-11-01",
      "2026-02-14",
    ]);
  });

  it("a retired part stops accruing at its retire date", () => {
    const part = { installed_on: "2025-01-01", retired_on: "2025-12-31" };
    expect(eventsInWindow(part, events, TODAY).map((e) => e.start_date)).toEqual([
      "2025-04-12",
      "2025-11-01",
    ]);
  });
});

describe("mounts (equip / unequip)", () => {
  // An explicit 4h each, so the wear math here doesn't move with the default.
  const h4 = { track_hours: 4 };
  const events = [ev("2026-03-10", 2, h4), ev("2026-04-10", 2, h4), ev("2026-05-10", 2, h4), ev("2026-08-01", 2, h4)];

  it("with no mounts listed, the part was on for its whole life", () => {
    expect(serviceWindows({ installed_on: "2026-03-01", retired_on: null }, TODAY)).toEqual([{ from: "2026-03-01", to: TODAY }]);
  });

  it("accrues only across the stretches it was on the car", () => {
    const part = {
      installed_on: "2026-03-01",
      retired_on: null,
      mounts: [
        { mounted_on: "2026-03-01", removed_on: "2026-04-01" },
        { mounted_on: "2026-05-01", removed_on: null },
      ],
    };
    expect(eventsInWindow(part, events, TODAY).map((e) => e.start_date)).toEqual(["2026-03-10", "2026-05-10"]);
    expect(wearEstimate({ ...part, expected_hours: 10, wear_limit: null }, events, [], TODAY).hours).toBe(8);
  });

  it("a part on the shelf since it was bought accrues nothing", () => {
    expect(eventsInWindow({ installed_on: "2026-03-01", retired_on: null, mounts: [] }, events, TODAY)).toEqual([]);
  });

  it("clips mounts to the part's lifetime and to today", () => {
    const part = {
      installed_on: "2026-03-05",
      retired_on: "2026-04-15",
      mounts: [{ mounted_on: "2026-03-01", removed_on: "2026-09-01" }],
    };
    expect(serviceWindows(part, TODAY)).toEqual([{ from: "2026-03-05", to: "2026-04-15" }]);
    expect(serviceWindows({ installed_on: "2026-03-01", retired_on: null, mounts: [{ mounted_on: "2026-08-01", removed_on: null }] }, TODAY)).toEqual([]);
  });

  it("an event on the swap day counts once, not twice", () => {
    const part = {
      installed_on: "2026-03-01",
      retired_on: null,
      mounts: [
        { mounted_on: "2026-03-01", removed_on: "2026-04-10" },
        { mounted_on: "2026-04-10", removed_on: null },
      ],
    };
    expect(eventsInWindow(part, events, TODAY)).toHaveLength(3);
  });

  it("swaps what shares a place: a full set against either pair, never 'other'", () => {
    expect(equipSwapKinds("tires")).toEqual(["tires", "tires_front", "tires_rear"]);
    expect(equipSwapKinds("tires_front")).toEqual(["tires_front", "tires"]);
    expect(equipSwapKinds("tires_rear")).toEqual(["tires_rear", "tires"]);
    expect(equipSwapKinds("pads_front")).toEqual(["pads_front"]);
    expect(equipSwapKinds("other")).toEqual([]);
  });
});

describe("wearEstimate", () => {
  const base = { installed_on: "2026-01-15", retired_on: null, expected_hours: null, wear_limit: null };
  // An explicit 4h each, so the projection math doesn't move with the default.
  const season = [ev("2026-02-14", 2, { track_hours: 4 }), ev("2026-04-18", 2, { track_hours: 4 }), ev("2026-06-13", 2, { track_hours: 4 })];

  it("accrues hours and event-day cycles with no projection basis", () => {
    const w = wearEstimate(base, season, [], TODAY);
    expect(w.hours).toBe(12);
    expect(w.events).toBe(3);
    expect(w.cycles).toBe(6); // 3 × 2-day events
    expect(w.remaining_hours).toBeNull();
    expect(w.source).toBeNull();
  });

  it("falls back to expected_hours when there are no measurements", () => {
    const w = wearEstimate({ ...base, expected_hours: 20 }, season, [], TODAY);
    expect(w.source).toBe("expected");
    expect(w.remaining_hours).toBe(8);
    expect(w.pct_used).toBeCloseTo(0.6);
  });

  it("expected-life remaining floors at zero", () => {
    const w = wearEstimate({ ...base, expected_hours: 10 }, season, [], TODAY);
    expect(w.remaining_hours).toBe(0);
    expect(w.pct_used).toBe(1);
  });

  it("fits wear-per-hour from 2+ measurements and projects to the wear limit", () => {
    // Hours at each measurement date: 4, 8, 12. Perfect-ish linear wear.
    const measurements = [
      { measured_on: "2026-02-20", value: 16.5, unit: "mm" },
      { measured_on: "2026-04-22", value: 11.5, unit: "mm" },
      { measured_on: "2026-06-16", value: 6.4, unit: "mm" },
    ];
    const w = wearEstimate({ ...base, wear_limit: 3, expected_hours: 24 }, season, measurements, TODAY);
    expect(w.source).toBe("measured"); // measurements beat the expected-hours prior
    expect(w.wear_per_hour).toBeCloseTo(1.2625, 3);
    expect(w.remaining_hours).toBeCloseTo(2.7, 1); // (6.4 - 3) / 1.2625
    expect(w.last_value).toBe(6.4);
    expect(w.pct_used).toBeGreaterThan(0.7);
  });

  it("a measurement at or under the limit means replace now", () => {
    const measurements = [
      { measured_on: "2026-02-20", value: 10, unit: "mm" },
      { measured_on: "2026-06-16", value: 2.5, unit: "mm" },
    ];
    const w = wearEstimate({ ...base, wear_limit: 3 }, season, measurements, TODAY);
    expect(w.source).toBe("measured");
    expect(w.remaining_hours).toBe(0);
    expect(w.pct_used).toBe(1);
  });

  it("ignores a non-wearing trend and falls back to expected", () => {
    const measurements = [
      { measured_on: "2026-02-20", value: 10, unit: "mm" },
      { measured_on: "2026-06-16", value: 10.5, unit: "mm" }, // measured thicker — noise
    ];
    const w = wearEstimate({ ...base, expected_hours: 20 }, season, measurements, TODAY);
    expect(w.source).toBe("expected");
  });

  it("single measurement is not enough to fit", () => {
    const w = wearEstimate(
      base,
      season,
      [{ measured_on: "2026-06-16", value: 9.5, unit: "mm" }],
      TODAY
    );
    expect(w.source).toBeNull();
    expect(w.last_value).toBe(9.5);
  });
});

describe("swaps between sessions (migration 0030)", () => {
  // Event 7, one day, four 20-minute sessions (ids 100…103): 80 minutes of laps.
  const min = 60_000;
  const day = (start_date: string, lapMs: (number | null)[], extra: Partial<HoursEvent> = {}): HoursEvent => {
    const sessions = lapMs.map((ms, i) => ({ id: 100 + i, lap_ms_sum: ms }));
    return ev(start_date, 1, {
      id: 7,
      sessions,
      lap_ms_sum: lapMs.reduce<number>((a, b) => a + (b ?? 0), 0),
      lap_count: 40,
      ...extra,
    });
  };
  // The part that came off / went on at a point in event 7 (after = null: its start).
  const outgoing = (after: number | null, removed_on = "2026-05-02", event: number | null = 7) => ({
    installed_on: "2026-03-01",
    retired_on: null,
    mounts: [{ mounted_on: "2026-03-01", removed_on, removed_event_id: event, removed_after_session_id: after }],
  });
  const incoming = (after: number | null, mounted_on = "2026-05-02", event: number | null = 7) => ({
    installed_on: mounted_on,
    retired_on: null,
    mounts: [{ mounted_on, removed_on: null, mounted_event_id: event, mounted_after_session_id: after }],
  });
  const quarter = [20 * min, 20 * min, 20 * min, 20 * min];

  it("divides a mid-day swap's hours between the two parts instead of counting them twice", () => {
    const events = [day("2026-05-02", quarter)];
    const old = eventShares(outgoing(101), events, TODAY);
    const fresh = eventShares(incoming(101), events, TODAY);
    expect(old.map((x) => x.share)).toEqual([0.5]);
    expect(fresh.map((x) => x.share)).toEqual([0.5]);
    expect(sharedHours(old) + sharedHours(fresh)).toBeCloseTo(eventHours(events[0]));
  });

  it("without a point both parts still get the whole day, as dates alone always gave", () => {
    const events = [day("2026-05-02", quarter)];
    expect(eventShares(outgoing(null, "2026-05-02", null), events, TODAY).map((x) => x.share)).toEqual([1]);
    expect(eventShares(incoming(null, "2026-05-02", null), events, TODAY).map((x) => x.share)).toEqual([1]);
  });

  it("a swap at the event's start gives the whole event to the part that went on", () => {
    const events = [day("2026-05-02", quarter)];
    expect(eventShares(outgoing(null), events, TODAY)).toEqual([]);
    expect(eventShares(incoming(null), events, TODAY)[0].share).toBe(1);
  });

  it("sessions logged after the swap was recorded run on the part that went on", () => {
    // Swapped after session 101 when only two sessions were in; two more were imported later.
    const events = [day("2026-05-02", quarter)];
    expect(eventShares(incoming(101), events, TODAY)[0].share).toBe(0.5);
    // Swapped after the last session: the new part ran none of the day.
    expect(eventShares(incoming(103), events, TODAY)).toEqual([]);
    expect(eventShares(outgoing(103), events, TODAY)[0].share).toBe(1);
  });

  it("an event with no sessions yet is one piece after its start", () => {
    const empty = day("2026-05-02", [], { lap_count: 0, lap_ms_sum: null });
    expect(eventShares(incoming(null), [empty], TODAY)[0].share).toBe(1);
    expect(eventShares(outgoing(null), [empty], TODAY)).toEqual([]);
  });

  it("weights the split by each session's logged lap time", () => {
    const events = [day("2026-05-02", [10 * min, 20 * min, 30 * min, 40 * min])];
    expect(eventShares(outgoing(101), events, TODAY)[0].share).toBeCloseTo(0.3);
    expect(eventShares(incoming(101), events, TODAY)[0].share).toBeCloseTo(0.7);
  });

  it("splits by session count when no session logged a lap", () => {
    const events = [day("2026-05-02", [null, null, null, null], { lap_count: 0, lap_ms_sum: null })];
    expect(eventShares(outgoing(100), events, TODAY)[0].share).toBeCloseTo(0.25);
    expect(eventShares(incoming(100), events, TODAY)[0].share).toBeCloseTo(0.75);
  });

  it("credits a set swapped on a weekend's second day with the sessions it ran", () => {
    // Started Saturday; the new set went on Sunday after the second session.
    const weekend = { ...day("2026-05-02", quarter), days: 2 };
    expect(eventShares(incoming(101, "2026-05-03"), [weekend], TODAY)[0].share).toBe(0.5);
    expect(eventShares(outgoing(101, "2026-05-03"), [weekend], TODAY)[0].share).toBe(0.5);
    // Dates alone: the event started before the new set went on, so it gets none.
    expect(eventShares(incoming(null, "2026-05-03", null), [weekend], TODAY)).toEqual([]);
  });

  it("a point in another event leaves the date rule in charge of this one", () => {
    const events = [day("2026-05-02", quarter)];
    expect(eventShares(incoming(101, "2026-05-02", 99), events, TODAY)[0].share).toBe(1);
  });

  it("a session the event no longer has cuts at the event's start", () => {
    const events = [day("2026-05-02", quarter)];
    expect(eventShares(incoming(999), events, TODAY)[0].share).toBe(1);
  });

  it("a part off and back on the same day, without points, never gets more than the whole", () => {
    const events = [day("2026-05-02", [20 * min, 20 * min])];
    const part = {
      installed_on: "2026-03-01",
      retired_on: null,
      mounts: [
        { mounted_on: "2026-03-01", removed_on: "2026-05-02" },
        { mounted_on: "2026-05-02", removed_on: null },
      ],
    };
    expect(eventShares(part, events, TODAY)[0].share).toBe(1);
  });

  it("carries the share into the wear estimate's hours and heat cycles", () => {
    const events = [ev("2026-04-01", 1, { track_hours: 2 }), day("2026-05-02", quarter)];
    const w = wearEstimate({ ...outgoing(101), expected_hours: 10, wear_limit: null }, events, [], TODAY);
    expect(w.hours).toBeCloseTo(2 + (80 / 60) * 0.5, 1);
    expect(w.events).toBe(2);
    expect(w.cycles).toBe(2);
    expect(eventsInWindow(outgoing(101), events, TODAY)).toHaveLength(2);
  });

  it("drops a point on an end the clipping moved: a mount clipped to retirement ends on the date", () => {
    const events = [day("2026-05-02", [20 * min, 20 * min])];
    const part = {
      installed_on: "2026-03-01",
      retired_on: "2026-05-02",
      mounts: [{ mounted_on: "2026-03-01", removed_on: "2026-06-01", removed_event_id: 7, removed_after_session_id: 100 }],
    };
    expect(eventShares(part, events, TODAY)[0].share).toBe(1);
    expect(serviceWindows(part, TODAY)).toEqual([{ from: "2026-03-01", to: "2026-05-02" }]);
  });
});
