import { Hono } from "hono";
import type { AppContext } from "../types";
import { insertLaps, ownedSession } from "../db";
import { sanitizeChannels, sanitizeLaps, sanitizeTrace } from "../lib/validate";

export const sessions = new Hono<AppContext>();

sessions.post("/events/:id/sessions", async (c) => {
  const eventId = c.req.param("id");
  const body = await c.req.json<{ label?: string; notes?: string; laps?: number[]; trace?: unknown; channels?: unknown }>();
  const trace = sanitizeTrace(body.trace);
  if (trace === undefined) return c.json({ error: "invalid trace" }, 400);
  const channels = sanitizeChannels(body.channels);
  if (channels === undefined) return c.json({ error: "invalid channels" }, 400);
  // Ownership check, next sort value, and insert in one statement: the SELECT
  // yields no row for an event that isn't this user's, so nothing is inserted
  // and RETURNING comes back empty.
  const session = await c.env.DB.prepare(
    `INSERT INTO sessions (event_id, label, notes, sort, trace, channels)
     SELECT e.id, ?2, ?3, (SELECT COALESCE(MAX(sort), 0) + 1 FROM sessions WHERE event_id = e.id), ?4, ?5
     FROM events e WHERE e.id = ?1 AND e.user_id = ?6
     RETURNING id`
  )
    .bind(
      eventId,
      body.label ?? null,
      body.notes ?? null,
      trace ? JSON.stringify(trace) : null,
      channels ? JSON.stringify(channels) : null,
      c.get("userId")
    )
    .first<{ id: number }>();
  if (!session) return c.json({ error: "not found" }, 404);
  await insertLaps(c.env.DB, session.id, sanitizeLaps(body.laps));
  return c.json({ id: session.id }, 201);
});

sessions.put("/sessions/:id", async (c) => {
  const body = await c.req.json<{ label?: string; notes?: string }>();
  const res = await c.env.DB.prepare(
    "UPDATE sessions SET label = ?, notes = ? WHERE id = ? AND event_id IN (SELECT id FROM events WHERE user_id = ?)"
  )
    .bind(body.label ?? null, body.notes ?? null, c.req.param("id"), c.get("userId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

sessions.delete("/sessions/:id", async (c) => {
  const res = await c.env.DB.prepare(
    "DELETE FROM sessions WHERE id = ? AND event_id IN (SELECT id FROM events WHERE user_id = ?)"
  )
    .bind(c.req.param("id"), c.get("userId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

sessions.post("/sessions/:id/laps", async (c) => {
  const s = await ownedSession(c.env.DB, c.get("userId"), c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ laps?: number[] }>();
  const laps = sanitizeLaps(body.laps);
  if (!laps.length) return c.json({ error: "laps required" }, 400);
  await insertLaps(c.env.DB, s.id, laps);
  return c.json({ ok: true }, 201);
});

sessions.delete("/laps/:id", async (c) => {
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
