// Track-time ledger and consumable wear math — pure, unit-testable.
//
// The core idea of the garage logbook: usage is computed, never logged. A
// part accrues the on-track hours of every event on its vehicle between its
// install and retire dates, so wear tracking costs nothing beyond the events
// the user already logs.

export const DEFAULT_HOURS_PER_DAY = 1.25;

// Laps an event needs before its logged lap time stands in for the day-count
// estimate — the same 3+ bar consistency uses. Below it the logging is taken to
// be sparse (a best-lap-only history) and says nothing about seat time.
export const MIN_TIMED_LAPS = 3;

export type HoursEvent = {
  start_date: string; // ISO yyyy-mm-dd
  days: number;
  track_hours: number | null; // per-event override
  lap_ms_sum: number | null; // total logged lap time, ms
  lap_count: number | null; // logged laps across the event's sessions
  id?: number; // the event, which a mount's swap point names (migration 0030)
  // The event's sessions in running order (sort, then id), each with its
  // logged lap time — what a swap point inside the event divides it by
  // (migration 0030). Absent or empty: the event is one indivisible piece.
  sessions?: HoursSession[];
};

export type HoursSession = {
  id: number;
  lap_ms_sum: number | null;
};

// On-track hours for one event. The explicit override wins; otherwise an event
// with at least MIN_TIMED_LAPS logged laps is the sum of its lap times — the
// sessions are the record of the day, so they replace the estimate in both
// directions — and anything sparser falls back to days × 1h15m (DEFAULT_HOURS_PER_DAY).
export function eventHours(e: HoursEvent): number {
  if (e.track_hours != null && e.track_hours > 0) return e.track_hours;
  if ((e.lap_count ?? 0) >= MIN_TIMED_LAPS) return (e.lap_ms_sum ?? 0) / 3_600_000;
  return (e.days || 0) * DEFAULT_HOURS_PER_DAY;
}

// A stretch a part was actually on the car (migration 0029). Both ends are
// inclusive; removed_on is null while it is still fitted.
//
// Either end can also sit at a point inside that day's event (migration 0030):
// *_event_id is the event the swap happened during, *_after_session_id the last
// of its sessions before the swap (null: the event's start, before any session).
// Sessions after the point — logged then or imported later — ran on the part
// that went on. A mid-day swap writes the same point on both parts' mounts, so
// the day's hours divide between them instead of counting twice.
export type Mount = {
  mounted_on: string; // ISO yyyy-mm-dd
  removed_on: string | null;
  mounted_event_id?: number | null;
  mounted_after_session_id?: number | null;
  removed_event_id?: number | null;
  removed_after_session_id?: number | null;
};

export type PartWindow = {
  installed_on: string; // ISO yyyy-mm-dd
  retired_on: string | null; // NULL while in service
  // The stretches it was on the car. Absent means "on the car for its whole
  // life" — the rule before parts could be unequipped, and still the right
  // answer for a whole-vehicle total. Present and empty means on the shelf
  // since it was bought: nothing accrues.
  mounts?: Mount[];
};

// A swap point inside an event: after `after` (a session id), or at its start.
type Point = { event: number; after: number | null };
type Window = { from: string; to: string; fromPoint: Point | null; toPoint: Point | null };

const point = (event: number | null | undefined, after: number | null | undefined): Point | null =>
  event == null ? null : { event, after: after ?? null };

// The windows a part accrues over: each mount, clipped to the part's lifetime
// (installed_on … retired_on) and to today. A swap point survives only on an
// end the clipping left where it was.
function mountWindows(part: PartWindow, today: string): Window[] {
  const lifeEnd = part.retired_on ?? today;
  const mounts: Mount[] = part.mounts ?? [{ mounted_on: part.installed_on, removed_on: part.retired_on }];
  return mounts
    .map((m) => {
      const clippedFrom = m.mounted_on < part.installed_on;
      const from = clippedFrom ? part.installed_on : m.mounted_on;
      let to = m.removed_on ?? lifeEnd;
      let clippedTo = m.removed_on == null;
      if (to > lifeEnd) (to = lifeEnd), (clippedTo = true);
      if (to > today) (to = today), (clippedTo = true);
      return {
        from,
        to,
        fromPoint: clippedFrom ? null : point(m.mounted_event_id, m.mounted_after_session_id),
        toPoint: clippedTo ? null : point(m.removed_event_id, m.removed_after_session_id),
      };
    })
    .filter((w) => w.from <= w.to);
}

export function serviceWindows(part: PartWindow, today: string): { from: string; to: string }[] {
  return mountWindows(part, today).map(({ from, to }) => ({ from, to }));
}

// Whether a date falls inside any of the part's service windows.
export function onCarOn(part: PartWindow, date: string, today: string): boolean {
  return serviceWindows(part, today).some((w) => date >= w.from && date <= w.to);
}

// How much of one event a window covers, 0…1. Without a swap point on this
// event the answer is all or nothing by the event's start date — an event
// counts against a part that was on the car the day it started, which is the
// rule dates alone can give. A point on this event cuts it there: the sessions
// after a mount's start point and up to its end point are the part's, and it
// gets that share of the event, weighted by logged lap time — or by session
// count when no session logged a lap. An event with no sessions yet is one
// indivisible piece that sits after its start point: a part mounted at the
// start runs it, a part removed at the start doesn't.
function windowShare(w: Window, e: HoursEvent): number {
  const sessions = e.sessions ?? [];
  const units = sessions.length || 1;
  // Where a point cuts this event: the index of the first session after it.
  const cutAt = (p: Point | null) => {
    if (!p || p.event !== e.id) return null;
    if (p.after == null) return 0;
    const i = sessions.findIndex((s) => s.id === p.after);
    return i < 0 ? 0 : i + 1;
  };
  const start = cutAt(w.fromPoint);
  const end = cutAt(w.toPoint);
  if (start == null && end == null) return e.start_date >= w.from && e.start_date <= w.to ? 1 : 0;
  // A point on this event decides that end; the other end is the dates'.
  const lo = start ?? (e.start_date >= w.from ? 0 : units);
  const hi = end ?? (e.start_date <= w.to ? units : 0);
  if (hi <= lo) return 0;
  if (!sessions.length) return 1;
  const byLaps = sessions.some((s) => (s.lap_ms_sum ?? 0) > 0);
  const weight = (s: HoursSession) => (byLaps ? s.lap_ms_sum ?? 0 : 1);
  const total = sessions.reduce((sum, s) => sum + weight(s), 0);
  return sessions.slice(lo, hi).reduce((sum, s) => sum + weight(s), 0) / total;
}

// Every already-driven event (an upcoming one isn't wear yet — same rule as
// userTotals) with the share of it the part was on the car for, dropping the
// ones it missed. Two stretches on the same day can both claim an event — off
// and back on without naming a session — so a share never exceeds the whole.
export function eventShares<E extends HoursEvent>(
  part: PartWindow,
  events: E[],
  today: string
): { event: E; share: number }[] {
  const windows = mountWindows(part, today);
  return events
    .filter((e) => e.start_date <= today)
    .map((event) => ({ event, share: Math.min(1, windows.reduce((sum, w) => sum + windowShare(w, event), 0)) }))
    .filter((x) => x.share > 0);
}

// The events that count against a part at all, whole or in part.
export function eventsInWindow<E extends HoursEvent>(part: PartWindow, events: E[], today: string): E[] {
  return eventShares(part, events, today).map((x) => x.event);
}

// The on-track hours a part accrued over a set of shared events.
export function sharedHours(shares: { event: HoursEvent; share: number }[]): number {
  return shares.reduce((sum, { event, share }) => sum + eventHours(event) * share, 0);
}

// Which kinds share a place on the car with `kind`: equipping a part takes the
// equipped parts of these kinds off (POST /parts/:id/equip). A full set of
// tires and a front or rear pair occupy the same corners, so each swaps the
// other; "other" is anything at all and swaps nothing. Mirrored by
// equipSwapKinds in public/js/garage.js — keep the two in step.
export function equipSwapKinds(kind: string): string[] {
  if (kind === "other") return [];
  if (kind === "tires") return ["tires", "tires_front", "tires_rear"];
  if (kind === "tires_front" || kind === "tires_rear") return [kind, "tires"];
  return [kind];
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
      x: sharedHours(eventShares(part, events, today).filter((x) => x.event.start_date <= m.measured_on)),
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
  const shares = eventShares(part, events, today);
  const hours = sharedHours(shares);
  // Event-days ≈ heat cycles: a part that ran any of a day ran a cycle on it.
  const cycles = shares.reduce((sum, { event, share }) => sum + Math.max(1, Math.ceil((event.days || 1) * share)), 0);
  const last = measurements.length
    ? [...measurements].sort((a, b) => a.measured_on.localeCompare(b.measured_on))[measurements.length - 1]
    : null;

  const base: WearEstimate = {
    hours: Math.round(hours * 10) / 10,
    events: shares.length,
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
