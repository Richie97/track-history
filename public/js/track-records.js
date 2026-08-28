// Pure per-track records computation — no DOM, unit-testable.
//
// `events` are computed /api/events rows for one track (any order); each record
// carries the event that set it so the UI can link to it. `sessionLapsByEvent`
// maps event id -> one lap-time array (ms, running order) per session, for the
// events whose laps the caller managed to load — lap-level records (best 3-lap
// average) simply drop out for events missing from the map, so an offline
// cache miss degrades a record instead of breaking the panel.

import { bestNAvg } from "./lap-stats.js";

export function trackRecords(events, sessionLapsByEvent = new Map()) {
  if (!events.length) return null;
  // Chronological, so a reduce with a strict comparison attributes a tied
  // record to the event that set it first.
  const byDate = [...events].sort((a, b) => a.start_date.localeCompare(b.start_date));

  const withBest = byDate.filter((e) => e.best_ms != null);
  const bestEvent = withBest.length ? withBest.reduce((a, b) => (b.best_ms < a.best_ms ? b : a)) : null;

  let best3 = null;
  for (const e of byDate) {
    for (const laps of sessionLapsByEvent.get(e.id) ?? []) {
      const avg = bestNAvg(laps, 3);
      if (avg != null && (best3 == null || avg < best3.ms)) best3 = { ms: avg, event: e };
    }
  }

  const withCv = byDate.filter((e) => e.consistency != null);
  const steadiest = withCv.length ? withCv.reduce((a, b) => (b.consistency < a.consistency ? b : a)) : null;

  const withLaps = byDate.filter((e) => e.lap_count > 0);
  const mostLaps = withLaps.length ? withLaps.reduce((a, b) => (b.lap_count > a.lap_count ? b : a)) : null;

  // Seconds found since the first timed visit. null when the first visit still
  // holds the best — there's no improvement story to tell yet.
  const firstTimed = withBest[0] ?? null;
  const gained_ms =
    firstTimed && bestEvent && firstTimed.id !== bestEvent.id && firstTimed.best_ms > bestEvent.best_ms
      ? firstTimed.best_ms - bestEvent.best_ms
      : null;

  return {
    best: bestEvent && { ms: bestEvent.best_ms, event: bestEvent },
    best3avg: best3,
    consistency: steadiest && { cv: steadiest.consistency, event: steadiest },
    most_laps: mostLaps && { count: mostLaps.lap_count, event: mostLaps },
    totals: {
      events: byDate.length,
      days: byDate.reduce((s, e) => s + (e.days ?? 0), 0),
      laps: byDate.reduce((s, e) => s + (e.lap_count ?? 0), 0),
      hours: Math.round(byDate.reduce((s, e) => s + (e.hours ?? 0), 0) * 10) / 10,
    },
    first_date: byDate[0].start_date,
    gained_ms,
  };
}
