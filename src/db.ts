// Data access helpers. All take (db, userId, ...) explicitly so ownership
// scoping is visible at every call site and the functions are testable
// without a Hono context.

import { type EventRow, withComputed } from "./lib/stats";

export const EVENT_SELECT = `
  SELECT e.id, e.track_id, t.name AS track_name, t.config AS track_config,
         e.start_date, e.days, e.club, e.run_group, e.car, e.notes,
         e.conditions, e.temp_f, e.checklist, e.best_time_ms,
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

// Resolve a track by id, or find-or-create by (name, config) — both COLLATE
// NOCASE. Config is part of the track identity: "VIR / Full" and "VIR /
// Patriot" are separate tracks so bests and goals never mix.
export async function resolveTrack(
  db: D1Database,
  userId: number,
  body: { track_id?: number; track_name?: string; track_config?: string }
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
  const config = (body.track_config ?? "").trim();
  const existing = await db
    .prepare(
      "SELECT id FROM tracks WHERE user_id = ? AND name = ? COLLATE NOCASE AND config = ? COLLATE NOCASE"
    )
    .bind(userId, name, config)
    .first<{ id: number }>();
  if (existing) return existing.id;
  const created = await db
    .prepare("INSERT INTO tracks (user_id, name, config) VALUES (?, ?, ?) RETURNING id")
    .bind(userId, name, config)
    .first<{ id: number }>();
  return created!.id;
}

export async function userTotals(db: D1Database, userId: number) {
  return db
    .prepare(
      "SELECT COUNT(*) AS events, COALESCE(SUM(days), 0) AS track_days FROM events WHERE user_id = ?"
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
export async function tracksSummary(db: D1Database, userId: number) {
  const tracks = (
    await db
      .prepare("SELECT id, name, config, goal_ms, notes FROM tracks WHERE user_id = ? ORDER BY name, config")
      .bind(userId)
      .all<{ id: number; name: string; config: string; goal_ms: number | null; notes: string | null }>()
  ).results;
  const events = (
    await db
      .prepare(`${EVENT_SELECT} WHERE e.user_id = ? ORDER BY e.start_date ASC`)
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
