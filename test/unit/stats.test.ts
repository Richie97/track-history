import { describe, expect, it } from "vitest";
import { CLEAN_FACTOR, type EventRow, withComputed } from "../../src/lib/stats";

const base: EventRow = {
  id: 1,
  track_id: 1,
  track_name: "Test Ring",
  start_date: "2026-05-01",
  days: 1,
  club: null,
  run_group: null,
  car: null,
  vehicle_id: null,
  notes: null,
  conditions: null,
  temp_f: null,
  checklist: null,
  best_time_ms: null,
  track_hours: null,
  cost_entry_cents: null,
  cost_fuel_cents: null,
  cost_travel_cents: null,
  cost_misc_cents: null,
  updated_at: 1,
  ambient_lo_c: null,
  ambient_hi_c: null,
  elevation_m: null,
  lap_best_ms: null,
  lap_count: 0,
  lap_avg: null,
  lap_avg_sq: null,
  clean_count: 0,
  clean_avg: null,
  clean_avg_sq: null,
  session_count: 0,
};

// Build the lap aggregate columns the SQL query would produce: every lap for
// lap_*, and for clean_* only the laps within CLEAN_FACTOR of their own
// session's best (src/db.ts's `sb` CTE).
function withSessions(sessions: number[][], extra: Partial<EventRow> = {}): EventRow {
  const laps = sessions.flat();
  const clean = sessions.flatMap((s) => s.filter((ms) => ms <= Math.min(...s) * CLEAN_FACTOR));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : null);
  return {
    ...base,
    lap_count: laps.length,
    lap_best_ms: Math.min(...laps),
    lap_avg: mean(laps),
    lap_avg_sq: mean(laps.map((v) => v * v)),
    clean_count: clean.length,
    clean_avg: mean(clean),
    clean_avg_sq: mean(clean.map((v) => v * v)),
    session_count: sessions.length,
    ...extra,
  };
}

const withLaps = (laps: number[], extra: Partial<EventRow> = {}) => withSessions([laps], extra);

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

  it("is the coefficient of variation with 3+ clean laps", () => {
    const c = withComputed(withLaps([100000, 103000, 106000])).consistency!;
    // stdev(pop) = 2449.49, mean = 103000 -> cv = 0.023781
    expect(c).toBeCloseTo(0.023781, 5);
  });

  it("is 0 for perfectly consistent laps", () => {
    expect(withComputed(withLaps([120000, 120000, 120000])).consistency).toBe(0);
  });

  // NS-42: an out-lap and a cool-down are not driver inconsistency.
  it("leaves out laps beyond 107% of the session's best", () => {
    const withOutLap = withComputed(withLaps([160000, 122000, 121000, 123000, 150000]));
    const cleanOnly = withComputed(withLaps([122000, 121000, 123000]));
    expect(withOutLap.consistency).toBeCloseTo(cleanOnly.consistency!, 12);
    // …while the lap count and the hours still count every lap.
    expect(withOutLap.lap_count).toBe(5);
  });

  it("counts clean laps toward the minimum, not all laps", () => {
    // Only 100000 is within 107% of 100000 — one clean lap is no figure.
    expect(withComputed(withLaps([100000, 110000, 120000])).consistency).toBeNull();
  });

  it("keeps a lap exactly at 107% (inclusive)", () => {
    expect(withComputed(withLaps([100000, 107000, 100000])).consistency).not.toBeNull();
  });

  it("judges each session against its own best", () => {
    // A wet session 10% slower than the dry one: against the event's best it
    // would vanish; against its own best every lap is clean.
    const out = withComputed(withSessions([[120000, 121000], [132000, 133000]]));
    expect(out.consistency).not.toBeNull();
  });
});

describe("withComputed shape", () => {
  it("strips the intermediate aggregate columns", () => {
    const out = withComputed(withLaps([120000, 121000, 122000]));
    expect(out).not.toHaveProperty("lap_avg");
    expect(out).not.toHaveProperty("lap_avg_sq");
    expect(out).not.toHaveProperty("clean_count");
    expect(out).not.toHaveProperty("clean_avg");
    expect(out).not.toHaveProperty("clean_avg_sq");
    expect(out).toHaveProperty("lap_count", 3);
  });
});

describe("withComputed checklist", () => {
  it("parses stored JSON into items", () => {
    const out = withComputed({ ...base, checklist: '[{"text":"Tech inspection","done":true}]' });
    expect(out.checklist).toEqual([{ text: "Tech inspection", done: true }]);
  });

  it("degrades malformed or non-array JSON to null", () => {
    expect(withComputed({ ...base, checklist: "{not json" }).checklist).toBeNull();
    expect(withComputed({ ...base, checklist: '{"a":1}' }).checklist).toBeNull();
    expect(withComputed(base).checklist).toBeNull();
  });
});

describe("withComputed cost_cents", () => {
  it("totals the entered cost line items and is null when none was entered", () => {
    expect(withComputed(base).cost_cents).toBeNull();
    expect(withComputed({ ...base, cost_entry_cents: 45_000, cost_fuel_cents: 8_000 }).cost_cents).toBe(53_000);
  });
});
