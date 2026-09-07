import { Hono } from "hono";
import type { AppContext } from "../types";
import { catalogIdForName, eventListStmt, tracksSummary } from "../db";
import { type EventRow, withComputed } from "../lib/stats";
import { isValidGoal } from "../lib/validate";
import { isEntitled, stripProFields } from "../lib/entitlement";
import { parseStoredChannels, publicLapChannels } from "../lib/leaderboard";
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

// The per-track community leaderboard: every opted-in user's best
// device-timed lap at the same physical track, matched across users by
// tracks.catalog_id (a track the catalog doesn't know has no cross-user
// identity, so no leaderboard). Strictly opt-in on both sides of the data:
// only leaderboard_opt_in users appear, and only their display name, best lap
// and its event date — never notes, laps or anything else user-entered.
// `opted_in` and `share_laps` are the viewer's own flags so the UI can offer
// both consents without a second request.
//
// An entry's `lap_id` is non-null only when *that row's owner* turned on
// leaderboard_share_laps (NS-35) — it is what makes the row openable, through
// the /laps/:lapId sibling below. Null is the normal case and means the row is
// a time, not a lap.
tracks.get("/tracks/:id/leaderboard", async (c) => {
  const userId = c.get("userId");
  // The owned-track row and the viewer's flags are independent — one round trip.
  const [trackRes, meRes] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT catalog_id FROM tracks WHERE id = ? AND user_id = ?").bind(
      c.req.param("id"),
      userId
    ),
    c.env.DB.prepare(
      "SELECT leaderboard_opt_in, leaderboard_share_laps FROM users WHERE id = ?"
    ).bind(userId),
  ]);
  const track = (trackRes.results[0] ?? null) as { catalog_id: number | null } | null;
  if (!track) return c.json({ error: "not found" }, 404);
  const meRow = meRes.results[0] as
    | { leaderboard_opt_in?: number; leaderboard_share_laps?: number }
    | undefined;
  const optedIn = Boolean(meRow?.leaderboard_opt_in);
  const shareLaps = Boolean(meRow?.leaderboard_share_laps);
  if (track.catalog_id == null)
    return c.json({ catalog_id: null, opted_in: optedIn, share_laps: shareLaps, entries: [] });

  // Best per user = MIN over *device-timed* laps only (NS-33): laps whose
  // session's channel data carries an entry with the same time, i.e. laps the
  // GPS recorder or a telemetry import produced (laps.device_timed, trigger-
  // maintained by migration 0018). This deliberately does NOT follow
  // withComputed's MIN(manual best, best lap) rule — an event's manual
  // best_time_ms and hand-entered laps stay in the logbook and never rank,
  // because a typed number is free and a ranking has to cost something.
  // "Fixing" the discrepancy reopens that hole. The bare `d` and `lap` columns
  // ride along with MIN(ms): SQLite's documented min/max behavior picks them
  // from the winning row — which is exactly the property the /laps/:lapId
  // route relies on, since the lap it will serve has to be *this* row's lap.
  const rows = await c.env.DB.prepare(
    `SELECT b.user_id, u.name, MIN(b.ms) AS best_ms, b.d AS date, b.lap AS lap_id,
            u.leaderboard_share_laps AS shares
     FROM (
       SELECT t.user_id AS user_id, l.time_ms AS ms, e.start_date AS d, l.id AS lap
         FROM tracks t
         JOIN events e ON e.track_id = t.id
         JOIN sessions s ON s.event_id = e.id
         JOIN laps l ON l.session_id = s.id
        WHERE t.catalog_id = ?1 AND l.device_timed = 1
     ) b
     JOIN users u ON u.id = b.user_id
     WHERE u.leaderboard_opt_in = 1
     GROUP BY b.user_id
     ORDER BY best_ms ASC
     LIMIT 100`
  )
    .bind(track.catalog_id)
    .all<{
      user_id: number;
      name: string | null;
      best_ms: number;
      date: string;
      lap_id: number;
      shares: number;
    }>();

  return c.json({
    catalog_id: track.catalog_id,
    opted_in: optedIn,
    share_laps: shareLaps,
    entries: rows.results.map((r) => ({
      name: r.name,
      best_ms: r.best_ms,
      date: r.date,
      you: r.user_id === userId,
      // Withheld unless the owner published the lap. Your own row is openable
      // whatever your setting — it is your lap, and being able to see what the
      // leaderboard is about to publish before you publish it is the point.
      lap_id: r.shares || r.user_id === userId ? r.lap_id : null,
    })),
  });
});

// One leaderboard lap, opened from a row above (NS-35). Everything about this
// route is a re-check rather than a lookup: `lap_id` came from a response and a
// client can send any number, so every condition the leaderboard row satisfied
// is asserted again here, and a lap that fails any of them is a 404 — never a
// 403, which would confirm the lap exists.
//
// The conditions, and why each one:
//   1. The viewer owns `:id` and it has a catalog identity — the same gate the
//      leaderboard itself passes, so a lap is only reachable from a track the
//      viewer actually has.
//   2. The lap is at *that* catalog track, is device-timed, and its owner has
//      both consents (or is the viewer).
//   3. **It is that owner's ranked lap** — its time equals their minimum
//      device-timed time at the catalog track. This is the condition that keeps
//      the leaderboard from becoming a read handle on a stranger's logbook: one
//      lap per driver per track is published, and it is the one already named
//      on the board. (Two of their laps tied at exactly that time would both
//      open. They are the same published time, so nothing beyond it is
//      disclosed.)
//
// What comes back is decided by lib/leaderboard.ts, and `channels` is the one
// Pro field, stripped for a free account exactly as it is on the event detail
// (NS-32 rule 4) — the racing line and the times are free.
tracks.get("/tracks/:id/leaderboard/laps/:lapId", async (c) => {
  const userId = c.get("userId");
  const lapId = Number(c.req.param("lapId"));
  if (!Number.isInteger(lapId)) return c.json({ error: "not found" }, 404);

  const track = (await c.env.DB.prepare(
    "SELECT catalog_id FROM tracks WHERE id = ? AND user_id = ?"
  )
    .bind(c.req.param("id"), userId)
    .first()) as { catalog_id: number | null } | null;
  if (!track || track.catalog_id == null) return c.json({ error: "not found" }, 404);

  const lap = (await c.env.DB.prepare(
    `SELECT l.id AS lap_id, l.time_ms, t.user_id AS owner_id, u.name,
            e.start_date AS date,
            s.trace, s.channels, s.ambient_c, s.elevation_m
       FROM laps l
       JOIN sessions s ON s.id = l.session_id
       JOIN events e ON e.id = s.event_id
       JOIN tracks t ON t.id = e.track_id
       JOIN users u ON u.id = t.user_id
      WHERE l.id = ?1
        AND t.catalog_id = ?2
        AND l.device_timed = 1
        AND u.leaderboard_opt_in = 1
        AND (u.leaderboard_share_laps = 1 OR t.user_id = ?3)`
  )
    .bind(lapId, track.catalog_id, userId)
    .first()) as {
    lap_id: number;
    time_ms: number;
    owner_id: number;
    name: string | null;
    date: string;
    trace: string | null;
    channels: string | null;
    ambient_c: number | null;
    elevation_m: number | null;
  } | null;
  if (!lap) return c.json({ error: "not found" }, 404);

  // Condition 3: this must be the owner's *ranked* lap, not merely one of
  // theirs. Same predicate as the leaderboard's MIN, scoped to the one user.
  const best = await c.env.DB.prepare(
    `SELECT MIN(l.time_ms) AS ms
       FROM tracks t
       JOIN events e ON e.track_id = t.id
       JOIN sessions s ON s.event_id = e.id
       JOIN laps l ON l.session_id = s.id
      WHERE t.catalog_id = ?1 AND t.user_id = ?2 AND l.device_timed = 1`
  )
    .bind(track.catalog_id, lap.owner_id)
    .first<{ ms: number | null }>();
  if (!best || best.ms !== lap.time_ms) return c.json({ error: "not found" }, 404);

  const channels = publicLapChannels(parseStoredChannels(lap.channels), lap.time_ms);
  return c.json(
    stripProFields(
      {
        lap_id: lap.lap_id,
        name: lap.name,
        you: lap.owner_id === userId,
        time_ms: lap.time_ms,
        date: lap.date,
        // Device-measured context, the same two columns the logbook shows
        // outside the Pro strip (migration 0020). A temperature is context for
        // a lap time, and neither is user-entered — `events.temp_f`, which is
        // typed, deliberately does not appear here.
        ambient_c: lap.ambient_c,
        elevation_m: lap.elevation_m,
        // Local-meter [x, y, v] points (migration 0005), so the racing line
        // ports to the track map with no new decoder and carries no absolute
        // position.
        trace: lap.trace ? (JSON.parse(lap.trace) as unknown) : null,
        channels,
      },
      isEntitled(c.get("entitledUntil"), Date.now())
    )
  );
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
