// Pure computation over event rows — no I/O, unit-testable.

import type { ChecklistItem } from "./validate";
import { eventHours } from "./wear";

export type EventRow = {
  id: number;
  track_id: number;
  track_name: string;
  start_date: string;
  days: number;
  club: string | null;
  run_group: string | null;
  car: string | null;
  vehicle_id: number | null;
  notes: string | null;
  conditions: string | null;
  temp_f: number | null;
  checklist: string | null; // JSON [{text, done}] as stored
  best_time_ms: number | null;
  track_hours: number | null; // manual override of the on-track hours estimate
  updated_at: number;
  lap_best_ms: number | null;
  lap_count: number;
  lap_avg: number | null;
  lap_avg_sq: number | null;
  session_count: number;
};

export type ComputedEvent = Omit<EventRow, "lap_avg" | "lap_avg_sq" | "checklist"> & {
  best_ms: number | null;
  consistency: number | null;
  hours: number; // on-track hours (override, or estimated — see lib/wear.ts)
  checklist: ChecklistItem[] | null;
};

// Parse the stored checklist JSON; malformed data degrades to null rather than throwing.
export function parseChecklist(raw: string | null): ChecklistItem[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function withComputed(e: EventRow): ComputedEvent {
  const bests = [e.best_time_ms, e.lap_best_ms].filter((v): v is number => v != null);
  const best_ms = bests.length ? Math.min(...bests) : null;
  // Coefficient of variation of lap times (stdev / mean), only meaningful with 3+ laps.
  let consistency: number | null = null;
  if (e.lap_count >= 3 && e.lap_avg != null && e.lap_avg_sq != null) {
    const variance = Math.max(0, e.lap_avg_sq - e.lap_avg * e.lap_avg);
    consistency = Math.sqrt(variance) / e.lap_avg;
  }
  const hours = eventHours({
    start_date: e.start_date,
    days: e.days,
    track_hours: e.track_hours,
    lap_ms_sum: e.lap_avg != null ? e.lap_avg * e.lap_count : null,
  });
  const { lap_avg, lap_avg_sq, ...rest } = e;
  return {
    ...rest,
    best_ms,
    consistency,
    hours: Math.round(hours * 10) / 10,
    checklist: parseChecklist(e.checklist),
  };
}
