import { describe, expect, it } from "vitest";
import { type EventRow, withComputed } from "../../src/lib/stats";

const base: EventRow = {
  id: 1,
  track_id: 1,
  track_name: "Test Ring",
  start_date: "2026-05-01",
  days: 1,
  club: null,
  run_group: null,
  car: null,
  notes: null,
  best_time_ms: null,
  lap_best_ms: null,
  lap_count: 0,
  lap_avg: null,
  lap_avg_sq: null,
  session_count: 0,
};

// Build the lap aggregate columns the SQL query would produce.
function withLaps(laps: number[], extra: Partial<EventRow> = {}): EventRow {
  const avg = laps.reduce((s, v) => s + v, 0) / laps.length;
  const avgSq = laps.reduce((s, v) => s + v * v, 0) / laps.length;
  return {
    ...base,
    lap_count: laps.length,
    lap_best_ms: Math.min(...laps),
    lap_avg: avg,
    lap_avg_sq: avgSq,
    ...extra,
  };
}

describe("withComputed best_ms", () => {
  it("is null with neither manual time nor laps", () => {
    expect(withComputed(base).best_ms).toBeNull();
  });

  it("uses the manual time when no laps exist", () => {
    expect(withComputed({ ...base, best_time_ms: 121000 }).best_ms).toBe(121000);
  });

  it("uses the best lap when no manual time exists", () => {
    expect(withComputed(withLaps([125000, 121500, 123000])).best_ms).toBe(121500);
  });

  it("takes the minimum of manual time and best lap", () => {
    expect(withComputed(withLaps([125000, 123000], { best_time_ms: 120000 })).best_ms).toBe(120000);
    expect(withComputed(withLaps([119000, 123000], { best_time_ms: 120000 })).best_ms).toBe(119000);
  });
});

describe("withComputed consistency", () => {
  it("is null with fewer than 3 laps", () => {
    expect(withComputed(withLaps([120000, 121000])).consistency).toBeNull();
  });

  it("is the coefficient of variation with 3+ laps", () => {
    const c = withComputed(withLaps([100000, 110000, 120000])).consistency!;
    // stdev(pop) = 8164.97, mean = 110000 -> cv = 0.07423
    expect(c).toBeCloseTo(0.07423, 4);
  });

  it("is 0 for perfectly consistent laps", () => {
    expect(withComputed(withLaps([120000, 120000, 120000])).consistency).toBe(0);
  });
});

describe("withComputed shape", () => {
  it("strips the intermediate aggregate columns", () => {
    const out = withComputed(withLaps([120000, 121000, 122000]));
    expect(out).not.toHaveProperty("lap_avg");
    expect(out).not.toHaveProperty("lap_avg_sq");
    expect(out).toHaveProperty("lap_count", 3);
  });
});
