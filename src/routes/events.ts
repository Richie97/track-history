import { Hono } from "hono";
import type { AppContext } from "../types";
import { EVENT_SELECT, listEvents, ownedEvent, resolveTrack } from "../db";
import { type EventRow, withComputed } from "../lib/stats";
import { isValidConditions, isValidTemp, sanitizeChecklist } from "../lib/validate";

export const events = new Hono<AppContext>();

// Validate conditions/temp_f/checklist off `body`, returning either the
// normalized values or an error message. checklist is stored as JSON text.
function validateExtras(body: any): { error: string } | { values: Record<string, unknown> } {
  const values: Record<string, unknown> = {};
  if ("conditions" in body) {
    if (!isValidConditions(body.conditions)) return { error: "invalid conditions" };
    values.conditions = body.conditions ?? null;
  }
  if ("temp_f" in body) {
    if (!isValidTemp(body.temp_f)) return { error: "invalid temp_f" };
    values.temp_f = body.temp_f ?? null;
  }
  if ("checklist" in body) {
    const checklist = sanitizeChecklist(body.checklist);
    if (checklist === undefined) return { error: "invalid checklist" };
    values.checklist = checklist ? JSON.stringify(checklist) : null;
  }
  return { values };
}

events.get("/events", async (c) => {
  return c.json(await listEvents(c.env.DB, c.get("userId"), c.req.query("track_id")));
});

events.post("/events", async (c) => {
  const body = await c.req.json<any>();
  if (!body.start_date) return c.json({ error: "start_date required" }, 400);
  const trackId = await resolveTrack(c.env.DB, c.get("userId"), body);
  if (!trackId) return c.json({ error: "track required" }, 400);
  const extras = validateExtras(body);
  if ("error" in extras) return c.json({ error: extras.error }, 400);
  const row = await c.env.DB.prepare(
    `INSERT INTO events (user_id, track_id, start_date, days, club, run_group, car, notes,
                         conditions, temp_f, checklist, best_time_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
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
      extras.values.conditions ?? null,
      extras.values.temp_f ?? null,
      extras.values.checklist ?? null,
      body.best_time_ms ?? null
    )
    .first<{ id: number }>();
  return c.json({ id: row!.id }, 201);
});

events.get("/events/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const event = await c.env.DB.prepare(`${EVENT_SELECT} WHERE e.user_id = ? AND e.id = ?`)
    .bind(userId, id)
    .first<EventRow>();
  if (!event) return c.json({ error: "not found" }, 404);

  const sessions = (
    await c.env.DB.prepare(
      "SELECT id, label, notes, sort, trace, channels FROM sessions WHERE event_id = ? ORDER BY sort, id"
    )
      .bind(id)
      .all<{ id: number; label: string | null; notes: string | null; sort: number; trace: string | null; channels: string | null }>()
  ).results.map((s) => ({
    ...s,
    trace: s.trace ? JSON.parse(s.trace) : null,
    channels: s.channels ? JSON.parse(s.channels) : null,
  }));
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

events.put("/events/:id", async (c) => {
  const id = c.req.param("id");
  const userId = c.get("userId");
  if (!(await ownedEvent(c.env.DB, userId, id))) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<any>();
  const trackId =
    body.track_id || body.track_name ? await resolveTrack(c.env.DB, userId, body) : undefined;
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
  const extras = validateExtras(body);
  if ("error" in extras) return c.json({ error: extras.error }, 400);
  for (const [col, val] of Object.entries(extras.values)) set(col, val);
  if (!fields.length) return c.json({ ok: true });
  values.push(id);
  await c.env.DB.prepare(`UPDATE events SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  return c.json({ ok: true });
});

events.delete("/events/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await ownedEvent(c.env.DB, c.get("userId"), id))) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});
