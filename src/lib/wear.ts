// Track-time ledger and consumable wear math — pure, unit-testable.
//
// The core idea of the garage logbook: usage is computed, never logged. A
// part accrues the on-track hours of every event on its vehicle between its
// install and retire dates, so wear tracking costs nothing beyond the events
// the user already logs.

export const DEFAULT_HOURS_PER_DAY = 2;

export type HoursEvent = {
  start_date: string; // ISO yyyy-mm-dd
  days: number;
  track_hours: number | null; // per-event override
  lap_ms_sum: number | null; // total logged lap time, ms
};

// On-track hours for one event. The explicit override wins; otherwise the
// larger of the day-count estimate (days × 2h) and the logged lap time.
// Sparse logging (best-lap-only history) badly underestimates seat time, so
// laps only ever push the estimate up, never down.
export function eventHours(e: HoursEvent): number {
  if (e.track_hours != null && e.track_hours > 0) return e.track_hours;
  const estimate = (e.days || 0) * DEFAULT_HOURS_PER_DAY;
  const logged = (e.lap_ms_sum ?? 0) / 3_600_000;
  return Math.max(estimate, logged);
}

export type PartWindow = {
  installed_on: string; // ISO yyyy-mm-dd
  retired_on: string | null; // NULL while in service
};

// Events that count against a part: started within its service window and
// already driven (an upcoming event isn't wear yet — same rule as userTotals).
export function eventsInWindow<E extends HoursEvent>(
  part: PartWindow,
  events: E[],
  today: string
): E[] {
  const end = part.retired_on ?? today;
  return events.filter(
    (e) => e.start_date <= today && e.start_date >= part.installed_on && e.start_date <= end
  );
}

export type Measurement = {
  measured_on: string; // ISO yyyy-mm-dd
  value: number;
  unit: string;
};

export type WearEstimate = {
  hours: number; // accrued on-track hours
  events: number; // events in the service window
  cycles: number; // event-days in the window ≈ heat cycles for tires
  expected_hours: number | null;
  // Remaining life. source tells the UI how much to trust it:
  //  "measured" — fitted from 2+ wear measurements (value vs accrued hours)
  //  "expected" — plain expected_hours − accrued
  //  null       — no basis for a projection
  remaining_hours: number | null;
  pct_used: number | null; // 0..1, clamped
  source: "measured" | "expected" | null;
  wear_per_hour: number | null; // in the measurement unit; measured source only
  last_value: number | null;
  unit: string | null;
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// Least-squares fit of measurement value against hours accrued at each
// measurement date. Needs 2+ points and a genuine downward trend; otherwise
// the caller falls back to expected_hours.
function fitWear(
  part: PartWindow & { wear_limit: number | null },
  events: HoursEvent[],
  measurements: Measurement[],
  today: string
): { remaining_hours: number; pct_used: number; wear_per_hour: number } | null {
  if (measurements.length < 2) return null;
  const pts = [...measurements]
    .sort((a, b) => a.measured_on.localeCompare(b.measured_on))
    .map((m) => ({
      x: eventsInWindow(part, events, today)
        .filter((e) => e.start_date <= m.measured_on)
        .reduce((sum, e) => sum + eventHours(e), 0),
      y: m.value,
    }));
  const n = pts.length;
  const sx = pts.reduce((a, p) => a + p.x, 0);
  const sy = pts.reduce((a, p) => a + p.y, 0);
  const sxx = pts.reduce((a, p) => a + p.x * p.x, 0);
  const sxy = pts.reduce((a, p) => a + p.x * p.y, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null; // all measurements at the same accrued hours
  const slope = (n * sxy - sx * sy) / denom;
  if (slope >= 0) return null; // not wearing — nothing to project
  const intercept = (sy - slope * sx) / n; // fitted "new" value at 0 hours
  const limit = part.wear_limit ?? 0;
  const last = pts[pts.length - 1];
  if (last.y <= limit) return { remaining_hours: 0, pct_used: 1, wear_per_hour: -slope };
  return {
    remaining_hours: (last.y - limit) / -slope,
    pct_used: clamp01((intercept - last.y) / Math.max(intercept - limit, 1e-9)),
    wear_per_hour: -slope,
  };
}

export function wearEstimate(
  part: PartWindow & { expected_hours: number | null; wear_limit: number | null },
  events: HoursEvent[],
  measurements: Measurement[],
  today: string
): WearEstimate {
  const inWindow = eventsInWindow(part, events, today);
  const hours = inWindow.reduce((sum, e) => sum + eventHours(e), 0);
  const cycles = inWindow.reduce((sum, e) => sum + Math.max(1, Math.ceil(e.days || 1)), 0);
  const last = measurements.length
    ? [...measurements].sort((a, b) => a.measured_on.localeCompare(b.measured_on))[measurements.length - 1]
    : null;

  const base: WearEstimate = {
    hours: Math.round(hours * 10) / 10,
    events: inWindow.length,
    cycles,
    expected_hours: part.expected_hours,
    remaining_hours: null,
    pct_used: null,
    source: null,
    wear_per_hour: null,
    last_value: last?.value ?? null,
    unit: last?.unit ?? null,
  };

  const fitted = fitWear(part, events, measurements, today);
  if (fitted) {
    return {
      ...base,
      remaining_hours: Math.round(fitted.remaining_hours * 10) / 10,
      pct_used: fitted.pct_used,
      source: "measured",
      wear_per_hour: fitted.wear_per_hour,
    };
  }
  if (part.expected_hours != null && part.expected_hours > 0) {
    return {
      ...base,
      remaining_hours: Math.round(Math.max(0, part.expected_hours - hours) * 10) / 10,
      pct_used: clamp01(hours / part.expected_hours),
      source: "expected",
    };
  }
  return base;
}
