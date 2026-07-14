import { Hono } from "hono";
import type { AppContext } from "../types";
import { insertLaps, ownedEvent, ownedSession } from "../db";
import { sanitizeLaps, sanitizeTrace } from "../lib/validate";

export const sessions = new Hono<AppContext>();

sessions.post("/events/:id/sessions", async (c) => {
  const eventId = c.req.param("id");
  if (!(await ownedEvent(c.env.DB, c.get("userId"), eventId))) {
    return c.json({ error: "not found" }, 404);
  }
  const body = await c.req.json<{ label?: string; notes?: string; laps?: number[]; trace?: unknown }>();
  const trace = sanitizeTrace(body.trace);
  if (trace === undefined) return c.json({ error: "invalid trace" }, 400);
  const maxSort = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(sort), 0) AS s FROM sessions WHERE event_id = ?"
  )
    .bind(eventId)
    .first<{ s: number }>();
  const session = await c.env.DB.prepare(
    "INSERT INTO sessions (event_id, label, notes, sort, trace) VALUES (?, ?, ?, ?, ?) RETURNING id"
  )
    .bind(eventId, body.label ?? null, body.notes ?? null, (maxSort?.s ?? 0) + 1, trace ? JSON.stringify(trace) : null)
    .first<{ id: number }>();
  await insertLaps(c.env.DB, session!.id, sanitizeLaps(body.laps), 1);
  return c.json({ id: session!.id }, 201);
});

sessions.put("/sessions/:id", async (c) => {
  const s = await ownedSession(c.env.DB, c.get("userId"), c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ label?: string; notes?: string }>();
  await c.env.DB.prepare("UPDATE sessions SET label = ?, notes = ? WHERE id = ?")
    .bind(body.label ?? null, body.notes ?? null, s.id)
    .run();
  return c.json({ ok: true });
});

sessions.delete("/sessions/:id", async (c) => {
  const s = await ownedSession(c.env.DB, c.get("userId"), c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(s.id).run();
  return c.json({ ok: true });
});

sessions.post("/sessions/:id/laps", async (c) => {
  const s = await ownedSession(c.env.DB, c.get("userId"), c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ laps?: number[] }>();
  const laps = sanitizeLaps(body.laps);
  if (!laps.length) return c.json({ error: "laps required" }, 400);
  const maxLap = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(lap_num), 0) AS n FROM laps WHERE session_id = ?"
  )
    .bind(s.id)
    .first<{ n: number }>();
  await insertLaps(c.env.DB, s.id, laps, (maxLap?.n ?? 0) + 1);
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
