import { describe, expect, it } from "vitest";
import { trackRecords } from "../../public/js/track-records.js";

let nextId = 1;
const ev = (over) => ({
  id: nextId++,
  start_date: "2025-06-01",
  days: 1,
  best_ms: null,
  consistency: null,
  lap_count: 0,
  hours: 0,
  ...over,
});

describe("trackRecords", () => {
  it("is null with no events", () => {
    expect(trackRecords([])).toBeNull();
  });

  it("attributes the best to the event that set it first on a tie", () => {
    const first = ev({ start_date: "2024-05-01", best_ms: 121000 });
    const later = ev({ start_date: "2025-06-01", best_ms: 121000 });
    const r = trackRecords([later, first]);
    expect(r.best.ms).toBe(121000);
    expect(r.best.event.id).toBe(first.id);
  });

  it("handles events with no times at all", () => {
    const r = trackRecords([ev(), ev()]);
    expect(r.best).toBeNull();
    expect(r.best3avg).toBeNull();
    expect(r.consistency).toBeNull();
    expect(r.most_laps).toBeNull();
    expect(r.totals.events).toBe(2);
  });

  it("finds the best 3-lap average across sessions, skipping events without loaded laps", () => {
    const a = ev({ best_ms: 120000, lap_count: 4 });
    const b = ev({ best_ms: 119000, lap_count: 6 });
    const laps = new Map([
      // Two sessions: the second has the better 3-lap average (121000).
      [a.id, [[122000, 124000, 123000, 130000], [121000, 121000, 121000]]],
      // b's laps didn't load (offline miss) — its record drops out gracefully.
    ]);
    const r = trackRecords([a, b], laps);
    expect(r.best3avg.ms).toBe(121000);
    expect(r.best3avg.event.id).toBe(a.id);
  });

  it("needs at least 3 laps in a session for a 3-lap average", () => {
    const a = ev({ lap_count: 2 });
    const r = trackRecords([a], new Map([[a.id, [[120000, 121000]]]]));
    expect(r.best3avg).toBeNull();
  });

  it("picks the steadiest event and the most laps in one event", () => {
    const a = ev({ consistency: 0.012, lap_count: 18 });
    const b = ev({ consistency: 0.008, lap_count: 25 });
    const r = trackRecords([a, b]);
    expect(r.consistency.cv).toBe(0.008);
    expect(r.consistency.event.id).toBe(b.id);
    expect(r.most_laps.count).toBe(25);
    expect(r.most_laps.event.id).toBe(b.id);
  });

  it("sums totals and rounds hours to one decimal", () => {
    const r = trackRecords([
      ev({ days: 2, lap_count: 20, hours: 3.33 }),
      ev({ days: 1.5, lap_count: 10, hours: 1.5 }),
    ]);
    expect(r.totals).toEqual({ events: 2, days: 3.5, laps: 30, hours: 4.8 });
  });

  it("reports seconds found since the first timed visit", () => {
    const first = ev({ start_date: "2024-05-01", best_ms: 125000 });
    const pb = ev({ start_date: "2025-06-01", best_ms: 121500 });
    const r = trackRecords([pb, first]);
    expect(r.first_date).toBe("2024-05-01");
    expect(r.gained_ms).toBe(3500);
  });

  it("has no improvement story when the first visit still holds the best", () => {
    const first = ev({ start_date: "2024-05-01", best_ms: 121000 });
    const later = ev({ start_date: "2025-06-01", best_ms: 124000 });
    expect(trackRecords([first, later]).gained_ms).toBeNull();
    expect(trackRecords([first]).gained_ms).toBeNull();
  });
});
