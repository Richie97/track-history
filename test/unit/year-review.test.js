import { describe, expect, it } from "vitest";
import { yearReview, yearsAvailable } from "../../public/js/year-review.js";

const ev = (over) => ({
  track_id: 1,
  track_name: "VIR Full",
  start_date: "2025-06-01",
  days: 2,
  best_ms: 121000,
  lap_count: 10,
  ...over,
});

describe("yearsAvailable", () => {
  it("returns distinct years, newest first", () => {
    const events = [ev({ start_date: "2024-05-01" }), ev({ start_date: "2025-06-01" }), ev({ start_date: "2024-09-01" })];
    expect(yearsAvailable(events)).toEqual([2025, 2024]);
  });

  it("is empty with no events", () => {
    expect(yearsAvailable([])).toEqual([]);
  });
});

describe("yearReview", () => {
  it("is null for a year with no events", () => {
    expect(yearReview([ev()], 2023)).toBeNull();
  });

  it("sums events, days and laps for the year", () => {
    const events = [
      ev({ start_date: "2025-04-01", days: 2, lap_count: 12 }),
      ev({ start_date: "2025-07-01", days: 1, lap_count: 8 }),
      ev({ start_date: "2024-07-01", days: 3, lap_count: 99 }), // other year, excluded
    ];
    const r = yearReview(events, 2025);
    expect(r.events).toBe(2);
    expect(r.days).toBe(3);
    expect(r.laps).toBe(20);
    expect(r.tracks_visited).toBe(1);
  });

  it("computes per-track gains against the pre-year best", () => {
    const events = [
      ev({ start_date: "2024-06-01", best_ms: 125000 }),
      ev({ start_date: "2024-09-01", best_ms: 123000 }),
      ev({ start_date: "2025-05-01", best_ms: 121500 }),
    ];
    const [g] = yearReview(events, 2025).gains;
    expect(g.best_before).toBe(123000);
    expect(g.best_this_year).toBe(121500);
    expect(g.gain_ms).toBe(1500);
  });

  it("marks tracks with no prior baseline as new (gain_ms null)", () => {
    const events = [ev({ start_date: "2025-05-01", best_ms: 121000 })];
    const r = yearReview(events, 2025);
    expect(r.new_tracks).toEqual([{ track_id: 1, track_name: "VIR Full" }]);
    expect(r.gains[0].gain_ms).toBeNull();
    expect(r.gains[0].best_before).toBeNull();
  });

  it("a track visited before the year is not new", () => {
    const events = [ev({ start_date: "2024-05-01" }), ev({ start_date: "2025-05-01" })];
    expect(yearReview(events, 2025).new_tracks).toEqual([]);
  });

  it("skips untimed tracks in gains but still counts the visit", () => {
    const events = [ev({ start_date: "2025-05-01", best_ms: null })];
    const r = yearReview(events, 2025);
    expect(r.tracks_visited).toBe(1);
    expect(r.gains).toEqual([]);
  });

  it("sorts gains biggest-improvement first", () => {
    const events = [
      ev({ track_id: 1, start_date: "2024-01-01", best_ms: 125000 }),
      ev({ track_id: 1, start_date: "2025-05-01", best_ms: 124500 }), // +0.5s
      ev({ track_id: 2, track_name: "Road Atlanta", start_date: "2024-01-01", best_ms: 100000 }),
      ev({ track_id: 2, track_name: "Road Atlanta", start_date: "2025-05-01", best_ms: 97000 }), // +3s
    ];
    const r = yearReview(events, 2025);
    expect(r.gains.map((g) => g.track_id)).toEqual([2, 1]);
  });

  it("rolls up the season's spend and prices each track-year's seconds found (#147)", () => {
    const events = [
      ev({ track_id: 1, start_date: "2024-06-01", best_ms: 125000, cost_entry_cents: 40_000 }),
      ev({ track_id: 1, start_date: "2025-05-01", best_ms: 123500, cost_entry_cents: 45_000, cost_fuel_cents: 15_000 }),
      ev({ track_id: 1, start_date: "2025-09-01", best_ms: 123000, cost_entry_cents: 45_000, cost_travel_cents: 15_000 }),
      // A track-year with a gain but no costs, and one with costs but no baseline.
      ev({ track_id: 2, track_name: "Road Atlanta", start_date: "2024-01-01", best_ms: 100000 }),
      ev({ track_id: 2, track_name: "Road Atlanta", start_date: "2025-05-01", best_ms: 97000 }),
      ev({ track_id: 3, track_name: "Summit Point", start_date: "2025-07-01", best_ms: 90000, cost_entry_cents: 30_000 }),
    ];
    const r = yearReview(events, 2025);
    // $1,200 across 2025 at VIR for the 2.0 s it found → $600/s.
    const vir = r.gains.find((g) => g.track_id === 1);
    expect(vir.spend_cents).toBe(120_000);
    expect(vir.gain_ms).toBe(2000);
    expect(vir.cents_per_second).toBe(60_000);
    const atl = r.gains.find((g) => g.track_id === 2);
    expect(atl.spend_cents).toBeNull();
    expect(atl.cents_per_second).toBeNull();
    const smp = r.gains.find((g) => g.track_id === 3);
    expect(smp.spend_cents).toBe(30_000);
    expect(smp.cents_per_second).toBeNull();
    expect(r.spend.total_cents).toBe(150_000);
    expect(r.spend.costed_events).toBe(3);
    expect(r.spend.events).toBe(4);
  });

  it("spend is null for a season nobody costed", () => {
    expect(yearReview([ev({ start_date: "2025-05-01" })], 2025).spend).toBeNull();
  });
});
