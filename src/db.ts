// Data access helpers. All take (db, userId, ...) explicitly so ownership
// scoping is visible at every call site and the functions are testable
// without a Hono context.

import { type EventRow, withComputed } from "./lib/stats";

export const EVENT_SELECT = `
  SELECT e.id, e.track_id, t.name AS track_name,
         e.start_date, e.days, e.club, e.run_group, e.car, e.vehicle_id, e.notes,
         e.conditions, e.temp_f, e.checklist, e.best_time_ms, e.track_hours, e.updated_at,
    (SELECT MIN(l.time_ms) FROM laps l JOIN sessions s ON l.session_id = s.id WHERE s.event_id = e.id) AS lap_best_ms,
    (SELECT COUNT(*)       FROM laps l JOIN sessions s ON l.session_id = s.id WHERE s.event_id = e.id) AS lap_count,
    (SELECT AVG(l.time_ms * 1.0) FROM laps l JOIN sessions s ON l.session_id = s.id WHERE s.event_id = e.id) AS lap_avg,
    (SELECT AVG(l.time_ms * 1.0 * l.time_ms) FROM laps l JOIN sessions s ON l.session_id = s.id WHERE s.event_id = e.id) AS lap_avg_sq,
    (SELECT COUNT(*) FROM sessions s WHERE s.event_id = e.id) AS session_count
  FROM events e JOIN tracks t ON t.id = e.track_id
`;

export async function ownedEvent(db: D1Database, userId: number, eventId: string | number) {
  return db
    .prepare("SELECT id FROM events WHERE id = ? AND user_id = ?")
    .bind(eventId, userId)
    .first<{ id: number }>();
}

export async function ownedSession(db: D1Database, userId: number, sessionId: string | number) {
  return db
    .prepare(
      "SELECT s.id, s.event_id FROM sessions s JOIN events e ON e.id = s.event_id WHERE s.id = ? AND e.user_id = ?"
    )
    .bind(sessionId, userId)
    .first<{ id: number; event_id: number }>();
}

// The canonical id for a track name, or null when the seeded track_catalog
// doesn't know it. The catalog gives the same physical track a stable identity
// across users; user tracks stay free-text and per-user.
export async function catalogIdForName(db: D1Database, name: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT id FROM track_catalog WHERE name = ? COLLATE NOCASE")
    .bind(name)
    .first<{ id: number }>();
  return row ? row.id : null;
}

// Resolve a track by id, or find-or-create by name (COLLATE NOCASE). The name
// carries the layout ("Virginia International Raceway (Full)" vs "(Patriot)")
// — different layouts are separate tracks so bests and goals never mix.
export async function resolveTrack(
  db: D1Database,
  userId: number,
  body: { track_id?: number; track_name?: string }
): Promise<number | null> {
  if (body.track_id) {
    const t = await db
      .prepare("SELECT id FROM tracks WHERE id = ? AND user_id = ?")
      .bind(body.track_id, userId)
      .first<{ id: number }>();
    return t ? t.id : null;
  }
  const name = body.track_name?.trim();
  if (!name) return null;
  const existing = await db
    .prepare("SELECT id FROM tracks WHERE user_id = ? AND name = ? COLLATE NOCASE")
    .bind(userId, name)
    .first<{ id: number }>();
  if (existing) return existing.id;
  const created = await db
    .prepare("INSERT INTO tracks (user_id, name, catalog_id) VALUES (?, ?, ?) RETURNING id")
    .bind(userId, name, await catalogIdForName(db, name))
    .first<{ id: number }>();
  return created!.id;
}

// Totals count past events only — an upcoming event isn't a track day driven
// yet. Matches the frontend's isUpcoming (start_date strictly after today,
// both in UTC), so an event counts from its start date onward.
export async function userTotals(db: D1Database, userId: number) {
  return db
    .prepare(
      "SELECT COUNT(*) AS events, COALESCE(SUM(days), 0) AS track_days FROM events WHERE user_id = ? AND start_date <= date('now')"
    )
    .bind(userId)
    .first();
}

export async function listEvents(db: D1Database, userId: number, trackId?: string | number) {
  const stmt = trackId
    ? db
        .prepare(`${EVENT_SELECT} WHERE e.user_id = ? AND e.track_id = ? ORDER BY e.start_date DESC`)
        .bind(userId, trackId)
    : db.prepare(`${EVENT_SELECT} WHERE e.user_id = ? ORDER BY e.start_date DESC`).bind(userId);
  return (await stmt.all<EventRow>()).results.map(withComputed);
}

// Tracks with per-track aggregates and a best-per-event sparkline series.
// Aggregates cover past events only (same rule as userTotals) — upcoming
// events live in the dashboard's upcoming section, not the tracks list.
export async function tracksSummary(db: D1Database, userId: number) {
  const tracks = (
    await db
      .prepare(
        "SELECT id, name, goal_ms, notes, catalog_id, updated_at FROM tracks WHERE user_id = ? ORDER BY name"
      )
      .bind(userId)
      .all<{
        id: number;
        name: string;
        goal_ms: number | null;
        notes: string | null;
        catalog_id: number | null;
        updated_at: number;
      }>()
  ).results;
  const events = (
    await db
      .prepare(`${EVENT_SELECT} WHERE e.user_id = ? AND e.start_date <= date('now') ORDER BY e.start_date ASC`)
      .bind(userId)
      .all<EventRow>()
  ).results.map(withComputed);

  const byTrack = new Map<number, ReturnType<typeof withComputed>[]>();
  for (const ev of events) {
    if (!byTrack.has(ev.track_id)) byTrack.set(ev.track_id, []);
    byTrack.get(ev.track_id)!.push(ev);
  }
  return tracks.map((t) => {
    const evs = byTrack.get(t.id) ?? [];
    const bests = evs.map((e) => e.best_ms).filter((v): v is number => v != null);
    return {
      ...t,
      event_count: evs.length,
      track_days: evs.reduce((sum, e) => sum + (e.days ?? 0), 0),
      best_ms: bests.length ? Math.min(...bests) : null,
      last_date: evs.length ? evs[evs.length - 1].start_date : null,
      // chronological best-per-event series for sparklines
      series: evs
        .filter((e) => e.best_ms != null)
        .map((e) => ({ date: e.start_date, best_ms: e.best_ms })),
    };
  });
}

// The garage's vehicle link for a free-text car name (COLLATE NOCASE), or
// null when the garage doesn't know it. events.car stays the display string;
// this is what ties events to parts and setups.
export async function vehicleIdForCar(
  db: D1Database,
  userId: number,
  car: string | null | undefined
): Promise<number | null> {
  if (!car?.trim()) return null;
  const row = await db
    .prepare("SELECT id FROM vehicles WHERE user_id = ? AND name = ? COLLATE NOCASE")
    .bind(userId, car.trim())
    .first<{ id: number }>();
  return row ? row.id : null;
}

// A part owned (via its vehicle) by the user, or null.
export async function ownedPart(db: D1Database, userId: number, partId: string | number) {
  return db
    .prepare(
      "SELECT p.id, p.vehicle_id FROM parts p JOIN vehicles v ON v.id = p.vehicle_id WHERE p.id = ? AND v.user_id = ?"
    )
    .bind(partId, userId)
    .first<{ id: number; vehicle_id: number }>();
}

// Past vehicle-linked events with the raw inputs for eventHours — the ledger
// the garage's wear math runs over (lib/wear.ts).
export async function vehicleHoursEvents(db: D1Database, userId: number) {
  return (
    await db
      .prepare(
        `SELECT e.id, e.vehicle_id, e.start_date, e.days, e.track_hours,
           (SELECT SUM(l.time_ms) FROM laps l JOIN sessions s ON l.session_id = s.id WHERE s.event_id = e.id) AS lap_ms_sum
         FROM events e
         WHERE e.user_id = ? AND e.vehicle_id IS NOT NULL AND e.start_date <= date('now')
         ORDER BY e.start_date ASC`
      )
      .bind(userId)
      .all<{
        id: number;
        vehicle_id: number;
        start_date: string;
        days: number;
        track_hours: number | null;
        lap_ms_sum: number | null;
      }>()
  ).results;
}

export async function insertLaps(
  db: D1Database,
  sessionId: number,
  laps: number[],
  startLapNum: number
) {
  if (!laps.length) return;
  await db.batch(
    laps.map((ms, i) =>
      db
        .prepare("INSERT INTO laps (session_id, lap_num, time_ms) VALUES (?, ?, ?)")
        .bind(sessionId, startLapNum + i, ms)
    )
  );
}
