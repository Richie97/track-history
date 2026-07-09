import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppContext } from "./index";

type Ctx = Context<AppContext>;

export const api = new Hono<AppContext>();

// --- auth middleware -------------------------------------------------------

api.use("*", async (c, next) => {
  const token = getCookie(c, "session");
  if (token) {
    const row = await c.env.DB.prepare(
      "SELECT user_id FROM auth_sessions WHERE token = ? AND expires_at > ?"
    )
      .bind(token, Date.now())
      .first<{ user_id: number }>();
    if (row) {
      c.set("userId", row.user_id);
      return next();
    }
  }
  return c.json({ error: "unauthorized" }, 401);
});

// --- helpers ---------------------------------------------------------------

type EventRow = {
  id: number;
  track_id: number;
  track_name: string;
  start_date: string;
  days: number;
  club: string | null;
  run_group: string | null;
  car: string | null;
  notes: string | null;
  best_time_ms: number | null;
  lap_best_ms: number | null;
  lap_count: number;
  lap_avg: number | null;
  lap_avg_sq: number | null;
  session_count: number;
};

const EVENT_SELECT = `
  SELECT e.id, e.track_id, t.name AS track_name, e.start_date, e.days, e.club,
         e.run_group, e.car, e.notes, e.best_time_ms,
    (SELECT MIN(l.time_ms) FROM laps l JOIN sessions s ON l.session_id = s.id WHERE s.event_id = e.id) AS lap_best_ms,
    (SELECT COUNT(*)       FROM laps l JOIN sessions s ON l.session_id = s.id WHERE s.event_id = e.id) AS lap_count,
    (SELECT AVG(l.time_ms * 1.0) FROM laps l JOIN sessions s ON l.session_id = s.id WHERE s.event_id = e.id) AS lap_avg,
    (SELECT AVG(l.time_ms * 1.0 * l.time_ms) FROM laps l JOIN sessions s ON l.session_id = s.id WHERE s.event_id = e.id) AS lap_avg_sq,
    (SELECT COUNT(*) FROM sessions s WHERE s.event_id = e.id) AS session_count
  FROM events e JOIN tracks t ON t.id = e.track_id
`;

function withComputed(e: EventRow) {
  const bests = [e.best_time_ms, e.lap_best_ms].filter((v): v is number => v != null);
  const best_ms = bests.length ? Math.min(...bests) : null;
  // Coefficient of variation of lap times (stdev / mean), only meaningful with 3+ laps.
  let consistency: number | null = null;
  if (e.lap_count >= 3 && e.lap_avg != null && e.lap_avg_sq != null) {
    const variance = Math.max(0, e.lap_avg_sq - e.lap_avg * e.lap_avg);
    consistency = Math.sqrt(variance) / e.lap_avg;
  }
  const { lap_avg, lap_avg_sq, ...rest } = e;
  return { ...rest, best_ms, consistency };
}

async function ownedEvent(c: Ctx, eventId: string | number) {
  return c.env.DB.prepare("SELECT id FROM events WHERE id = ? AND user_id = ?")
    .bind(eventId, c.get("userId"))
    .first<{ id: number }>();
}

async function ownedSession(c: Ctx, sessionId: string | number) {
  return c.env.DB.prepare(
    "SELECT s.id, s.event_id FROM sessions s JOIN events e ON e.id = s.event_id WHERE s.id = ? AND e.user_id = ?"
  )
    .bind(sessionId, c.get("userId"))
    .first<{ id: number; event_id: number }>();
}

// Resolve a track by id, or find-or-create by name.
async function resolveTrack(
  c: Ctx,
  body: { track_id?: number; track_name?: string }
): Promise<number | null> {
  const userId = c.get("userId");
  if (body.track_id) {
    const t = await c.env.DB.prepare("SELECT id FROM tracks WHERE id = ? AND user_id = ?")
      .bind(body.track_id, userId)
      .first<{ id: number }>();
    return t ? t.id : null;
  }
  const name = body.track_name?.trim();
  if (!name) return null;
  const existing = await c.env.DB.prepare(
    "SELECT id FROM tracks WHERE user_id = ? AND name = ? COLLATE NOCASE"
  )
    .bind(userId, name)
    .first<{ id: number }>();
  if (existing) return existing.id;
  const created = await c.env.DB.prepare(
    "INSERT INTO tracks (user_id, name) VALUES (?, ?) RETURNING id"
  )
    .bind(userId, name)
    .first<{ id: number }>();
  return created!.id;
}

// --- me --------------------------------------------------------------------

api.get("/me", async (c) => {
  const userId = c.get("userId");
  const user = await c.env.DB.prepare("SELECT id, email, name, picture FROM users WHERE id = ?")
    .bind(userId)
    .first();
  const totals = await c.env.DB.prepare(
    "SELECT COUNT(*) AS events, COALESCE(SUM(days), 0) AS track_days FROM events WHERE user_id = ?"
  )
    .bind(userId)
    .first();
  return c.json({ user, totals });
});

// --- tracks ----------------------------------------------------------------

api.get("/tracks", async (c) => {
  const userId = c.get("userId");
  const tracks = (
    await c.env.DB.prepare("SELECT id, name FROM tracks WHERE user_id = ? ORDER BY name")
      .bind(userId)
      .all<{ id: number; name: string }>()
  ).results;
  const events = (
    await c.env.DB.prepare(`${EVENT_SELECT} WHERE e.user_id = ? ORDER BY e.start_date ASC`)
      .bind(userId)
      .all<EventRow>()
  ).results.map(withComputed);

  const byTrack = new Map<number, ReturnType<typeof withComputed>[]>();
  for (const ev of events) {
    if (!byTrack.has(ev.track_id)) byTrack.set(ev.track_id, []);
    byTrack.get(ev.track_id)!.push(ev);
  }
  const result = tracks.map((t) => {
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
  return c.json(result);
});

api.post("/tracks", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const name = body.name?.trim();
  if (!name) return c.json({ error: "name required" }, 400);
  try {
    const row = await c.env.DB.prepare(
      "INSERT INTO tracks (user_id, name) VALUES (?, ?) RETURNING id, name"
    )
      .bind(c.get("userId"), name)
      .first();
    return c.json(row, 201);
  } catch {
    return c.json({ error: "track already exists" }, 409);
  }
});

api.put("/tracks/:id", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const name = body.name?.trim();
  if (!name) return c.json({ error: "name required" }, 400);
  const res = await c.env.DB.prepare("UPDATE tracks SET name = ? WHERE id = ? AND user_id = ?")
    .bind(name, c.req.param("id"), c.get("userId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

api.delete("/tracks/:id", async (c) => {
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

// --- events ----------------------------------------------------------------

api.get("/events", async (c) => {
  const userId = c.get("userId");
  const trackId = c.req.query("track_id");
  const stmt = trackId
    ? c.env.DB.prepare(
        `${EVENT_SELECT} WHERE e.user_id = ? AND e.track_id = ? ORDER BY e.start_date DESC`
      ).bind(userId, trackId)
    : c.env.DB.prepare(`${EVENT_SELECT} WHERE e.user_id = ? ORDER BY e.start_date DESC`).bind(
        userId
      );
  const events = (await stmt.all<EventRow>()).results.map(withComputed);
  return c.json(events);
});

api.post("/events", async (c) => {
  const body = await c.req.json<any>();
  if (!body.start_date) return c.json({ error: "start_date required" }, 400);
  const trackId = await resolveTrack(c, body);
  if (!trackId) return c.json({ error: "track required" }, 400);
  const row = await c.env.DB.prepare(
    `INSERT INTO events (user_id, track_id, start_date, days, club, run_group, car, notes, best_time_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(
      c.get("userId"),
      trackId,
      body.start_date,
      body.days ?? 1,
      body.club ?? null,
      body.run_group ?? null,
      body.car ?? null,
      body.notes ?? null,
      body.best_time_ms ?? null
    )
    .first<{ id: number }>();
  return c.json({ id: row!.id }, 201);
});

api.get("/events/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const event = await c.env.DB.prepare(`${EVENT_SELECT} WHERE e.user_id = ? AND e.id = ?`)
    .bind(userId, id)
    .first<EventRow>();
  if (!event) return c.json({ error: "not found" }, 404);

  const sessions = (
    await c.env.DB.prepare("SELECT id, label, notes, sort FROM sessions WHERE event_id = ? ORDER BY sort, id")
      .bind(id)
      .all<{ id: number; label: string | null; notes: string | null; sort: number }>()
  ).results;
  const laps = (
    await c.env.DB.prepare(
      "SELECT l.id, l.session_id, l.lap_num, l.time_ms FROM laps l JOIN sessions s ON s.id = l.session_id WHERE s.event_id = ? ORDER BY l.session_id, l.lap_num"
    )
      .bind(id)
      .all<{ id: number; session_id: number; lap_num: number; time_ms: number }>()
  ).results;

  const sessionsWithLaps = sessions.map((s) => ({
    ...s,
    laps: laps.filter((l) => l.session_id === s.id),
  }));
  return c.json({ ...withComputed(event), sessions: sessionsWithLaps });
});

api.put("/events/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await ownedEvent(c, id))) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<any>();
  const trackId = body.track_id || body.track_name ? await resolveTrack(c, body) : undefined;
  if (trackId === null) return c.json({ error: "invalid track" }, 400);

  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, val: unknown) => {
    fields.push(`${col} = ?`);
    values.push(val);
  };
  if (trackId !== undefined) set("track_id", trackId);
  for (const col of ["start_date", "days", "club", "run_group", "car", "notes", "best_time_ms"]) {
    if (col in body) set(col, body[col]);
  }
  if (!fields.length) return c.json({ ok: true });
  values.push(id);
  await c.env.DB.prepare(`UPDATE events SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  return c.json({ ok: true });
});

api.delete("/events/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await ownedEvent(c, id))) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// --- sessions & laps -------------------------------------------------------

api.post("/events/:id/sessions", async (c) => {
  const eventId = c.req.param("id");
  if (!(await ownedEvent(c, eventId))) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ label?: string; notes?: string; laps?: number[] }>();
  const maxSort = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(sort), 0) AS s FROM sessions WHERE event_id = ?"
  )
    .bind(eventId)
    .first<{ s: number }>();
  const session = await c.env.DB.prepare(
    "INSERT INTO sessions (event_id, label, notes, sort) VALUES (?, ?, ?, ?) RETURNING id"
  )
    .bind(eventId, body.label ?? null, body.notes ?? null, (maxSort?.s ?? 0) + 1)
    .first<{ id: number }>();
  const laps = (body.laps ?? []).filter((ms) => Number.isFinite(ms) && ms > 0);
  if (laps.length) {
    await c.env.DB.batch(
      laps.map((ms, i) =>
        c.env.DB.prepare("INSERT INTO laps (session_id, lap_num, time_ms) VALUES (?, ?, ?)").bind(
          session!.id,
          i + 1,
          Math.round(ms)
        )
      )
    );
  }
  return c.json({ id: session!.id }, 201);
});

api.put("/sessions/:id", async (c) => {
  const s = await ownedSession(c, c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ label?: string; notes?: string }>();
  await c.env.DB.prepare("UPDATE sessions SET label = ?, notes = ? WHERE id = ?")
    .bind(body.label ?? null, body.notes ?? null, s.id)
    .run();
  return c.json({ ok: true });
});

api.delete("/sessions/:id", async (c) => {
  const s = await ownedSession(c, c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(s.id).run();
  return c.json({ ok: true });
});

api.post("/sessions/:id/laps", async (c) => {
  const s = await ownedSession(c, c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ laps?: number[] }>();
  const laps = (body.laps ?? []).filter((ms) => Number.isFinite(ms) && ms > 0);
  if (!laps.length) return c.json({ error: "laps required" }, 400);
  const maxLap = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(lap_num), 0) AS n FROM laps WHERE session_id = ?"
  )
    .bind(s.id)
    .first<{ n: number }>();
  await c.env.DB.batch(
    laps.map((ms, i) =>
      c.env.DB.prepare("INSERT INTO laps (session_id, lap_num, time_ms) VALUES (?, ?, ?)").bind(
        s.id,
        (maxLap?.n ?? 0) + i + 1,
        Math.round(ms)
      )
    )
  );
  return c.json({ ok: true }, 201);
});

api.delete("/laps/:id", async (c) => {
  const res = await c.env.DB.prepare(
    `DELETE FROM laps WHERE id = ? AND session_id IN (
       SELECT s.id FROM sessions s JOIN events e ON e.id = s.event_id WHERE e.user_id = ?
     )`
  )
    .bind(c.req.param("id"), c.get("userId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
