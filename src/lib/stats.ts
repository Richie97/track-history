// Pure computation over event rows — no I/O, unit-testable.

import type { ChecklistItem } from "./validate";

export type EventRow = {
  id: number;
  track_id: number;
  track_name: string;
  start_date: string;
  days: number;
  club: string | null;
  run_group: string | null;
  car: string | null;
  notes: string | null;
  conditions: string | null;
  temp_f: number | null;
  checklist: string | null; // JSON [{text, done}] as stored
  best_time_ms: number | null;
  lap_best_ms: number | null;
  lap_count: number;
  lap_avg: number | null;
  lap_avg_sq: number | null;
  session_count: number;
};

export type ComputedEvent = Omit<EventRow, "lap_avg" | "lap_avg_sq" | "checklist"> & {
  best_ms: number | null;
  consistency: number | null;
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
  const { lap_avg, lap_avg_sq, ...rest } = e;
  return { ...rest, best_ms, consistency, checklist: parseChecklist(e.checklist) };
}
