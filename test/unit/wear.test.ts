import { describe, expect, it } from "vitest";
import { eventHours, eventsInWindow, wearEstimate, type HoursEvent } from "../../src/lib/wear";

const TODAY = "2026-07-19";

const ev = (start_date: string, days = 2, extra: Partial<HoursEvent> = {}): HoursEvent => ({
  start_date,
  days,
  track_hours: null,
  lap_ms_sum: null,
  ...extra,
});

describe("eventHours", () => {
  it("defaults to 2h per day", () => {
    expect(eventHours(ev("2026-05-01", 2))).toBe(4);
    expect(eventHours(ev("2026-05-01", 0.5))).toBe(1);
  });

  it("an explicit override wins over everything", () => {
    expect(eventHours(ev("2026-05-01", 2, { track_hours: 5.5 }))).toBe(5.5);
    expect(eventHours(ev("2026-05-01", 2, { track_hours: 1, lap_ms_sum: 20_000_000 }))).toBe(1);
  });

  it("logged lap time only ever pushes the estimate up", () => {
    // 3h of laps on a 1-day event beats the 2h estimate...
    expect(eventHours(ev("2026-05-01", 1, { lap_ms_sum: 3 * 3_600_000 }))).toBe(3);
    // ...but 30min of best-lap-only logging on a 2-day event doesn't pull it down.
    expect(eventHours(ev("2026-05-01", 2, { lap_ms_sum: 30 * 60_000 }))).toBe(4);
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

describe("wearEstimate", () => {
  const base = { installed_on: "2026-01-15", retired_on: null, expected_hours: null, wear_limit: null };
  const season = [ev("2026-02-14"), ev("2026-04-18"), ev("2026-06-13")]; // 4h each

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
