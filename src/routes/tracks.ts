import { Hono } from "hono";
import type { AppContext } from "../types";
import { catalogIdForName, eventListStmt, tracksSummary } from "../db";
import { type EventRow, withComputed } from "../lib/stats";
import { isValidGoal } from "../lib/validate";
import { requireEntitlement } from "../middleware";

export const tracks = new Hono<AppContext>();

// Setup sheets across all events at a track, joined with each event's
// outcome stats — the raw material for the track page's "setup vs. lap
// times" table. One row per event-day sheet; outcome columns repeat per
// event since laps aren't attributed to days.
tracks.get("/tracks/:id/setups", requireEntitlement, async (c) => {
  const userId = c.get("userId");
  const trackId = c.req.param("id");
  // The event list and the setup sheets are independent — one round trip.
  const [eventsRes, setupsRes] = await c.env.DB.batch([
    eventListStmt(c.env.DB, userId, trackId),
    c.env.DB.prepare(
      `SELECT s.event_id, s.day, s.data FROM setups s
       JOIN events e ON e.id = s.event_id
       WHERE e.user_id = ? AND e.track_id = ?
       ORDER BY e.start_date ASC, s.day ASC`
    ).bind(userId, trackId),
  ]);
  const events = (eventsRes.results as EventRow[]).map(withComputed);
  const rows = setupsRes.results as { event_id: number; day: number; data: string }[];
  return c.json(
    rows.flatMap((r) => {
      const e = events.find((ev) => ev.id === r.event_id);
      if (!e) return [];
      return [
        {
          event_id: r.event_id,
          day: r.day,
          start_date: e.start_date,
          car: e.car,
          conditions: e.conditions,
          temp_f: e.temp_f,
          best_ms: e.best_ms,
          consistency: e.consistency,
          data: JSON.parse(r.data),
        },
      ];
    })
  );
});

tracks.get("/tracks", async (c) => {
  return c.json(await tracksSummary(c.env.DB, c.get("userId")));
});

// The per-track community leaderboard: every opted-in user's best lap at the
// same physical track, matched across users by tracks.catalog_id (a track the
// catalog doesn't know has no cross-user identity, so no leaderboard). Strictly
// opt-in on both sides of the data: only leaderboard_opt_in users appear, and
// only their display name, best lap and its event date — never notes, laps or
// anything else user-entered. `opted_in` is the viewer's own flag so the UI
// can offer the opt-in without a second request.
tracks.get("/tracks/:id/leaderboard", async (c) => {
  const userId = c.get("userId");
  // The owned-track row and the viewer's flag are independent — one round trip.
  const [trackRes, meRes] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT catalog_id FROM tracks WHERE id = ? AND user_id = ?").bind(
      c.req.param("id"),
      userId
    ),
    c.env.DB.prepare("SELECT leaderboard_opt_in FROM users WHERE id = ?").bind(userId),
  ]);
  const track = (trackRes.results[0] ?? null) as { catalog_id: number | null } | null;
  if (!track) return c.json({ error: "not found" }, 404);
  const optedIn = Boolean(
    (meRes.results[0] as { leaderboard_opt_in?: number } | undefined)?.leaderboard_opt_in
  );
  if (track.catalog_id == null) return c.json({ catalog_id: null, opted_in: optedIn, entries: [] });

  // Best per user = MIN over manual event bests and logged laps — the same
  // rule as withComputed (src/lib/stats.ts), pushed into SQL so one query
  // covers every user. The bare `d` column rides along with MIN(ms):
  // SQLite's documented min/max behavior picks it from the winning row.
  const rows = await c.env.DB.prepare(
    `SELECT b.user_id, u.name, MIN(b.ms) AS best_ms, b.d AS date
     FROM (
       SELECT t.user_id AS user_id, e.best_time_ms AS ms, e.start_date AS d
         FROM tracks t JOIN events e ON e.track_id = t.id
        WHERE t.catalog_id = ?1 AND e.best_time_ms IS NOT NULL
       UNION ALL
       SELECT t.user_id, l.time_ms, e.start_date
         FROM tracks t
         JOIN events e ON e.track_id = t.id
         JOIN sessions s ON s.event_id = e.id
         JOIN laps l ON l.session_id = s.id
        WHERE t.catalog_id = ?1
     ) b
     JOIN users u ON u.id = b.user_id
     WHERE u.leaderboard_opt_in = 1
     GROUP BY b.user_id
     ORDER BY best_ms ASC
     LIMIT 100`
  )
    .bind(track.catalog_id)
    .all<{ user_id: number; name: string | null; best_ms: number; date: string }>();

  return c.json({
    catalog_id: track.catalog_id,
    opted_in: optedIn,
    entries: rows.results.map((r) => ({
      name: r.name,
      best_ms: r.best_ms,
      date: r.date,
      you: r.user_id === userId,
    })),
  });
});

// The seeded track catalog — backs the track-name suggestions in the event form.
tracks.get("/catalog", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, name FROM track_catalog ORDER BY name").all<{
    id: number;
    name: string;
  }>();
  return c.json(rows.results);
});

tracks.post("/tracks", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const name = body.name?.trim();
  if (!name) return c.json({ error: "name required" }, 400);
  try {
    const row = await c.env.DB.prepare(
      "INSERT INTO tracks (user_id, name, catalog_id) VALUES (?, ?, ?) RETURNING id, name, catalog_id"
    )
      .bind(c.get("userId"), name, await catalogIdForName(c.env.DB, name))
      .first();
    return c.json(row, 201);
  } catch {
    return c.json({ error: "track already exists" }, 409);
  }
});

tracks.put("/tracks/:id", async (c) => {
  const body = await c.req.json<{
    name?: string;
    notes?: string | null;
    goal_ms?: number | null;
  }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return c.json({ error: "name required" }, 400);
    sets.push("name = ?");
    binds.push(name);
    // Renaming can change which canonical track this is — re-match the catalog.
    sets.push("catalog_id = ?");
    binds.push(await catalogIdForName(c.env.DB, name));
  }
  if ("notes" in body) {
    sets.push("notes = ?");
    binds.push(typeof body.notes === "string" && body.notes.trim() ? body.notes : null);
  }
  if ("goal_ms" in body) {
    if (!isValidGoal(body.goal_ms)) return c.json({ error: "invalid goal" }, 400);
    sets.push("goal_ms = ?");
    binds.push(body.goal_ms ?? null);
  }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  binds.push(c.req.param("id"), c.get("userId"));
  try {
    const res = await c.env.DB.prepare(
      `UPDATE tracks SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`
    )
      .bind(...binds)
      .run();
    if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  } catch {
    // UNIQUE(user_id, name) — the new name collides with another track.
    return c.json({ error: "a track with that name already exists" }, 409);
  }
  return c.json({ ok: true });
});

tracks.delete("/tracks/:id", async (c) => {
  const id = c.req.param("id");
  const userId = c.get("userId");
  const inUse = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE track_id = ? AND user_id = ?"
  )
    .bind(id, userId)
    .first<{ n: number }>();
  if (inUse && inUse.n > 0) return c.json({ error: "track has events" }, 409);
  const res = await c.env.DB.prepare("DELETE FROM tracks WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
