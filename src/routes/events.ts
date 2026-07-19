import { Hono } from "hono";
import type { AppContext } from "../types";
import { EVENT_SELECT, listEvents, ownedEvent, resolveTrack, vehicleIdForCar } from "../db";
import { type EventRow, withComputed } from "../lib/stats";
import { isValidConditions, isValidTemp, sanitizeChecklist, sanitizeSetup } from "../lib/validate";

export const events = new Hono<AppContext>();

// Validate conditions/temp_f/checklist/track_hours off `body`, returning
// either the normalized values or an error message. checklist is stored as
// JSON text.
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
  if ("track_hours" in body) {
    const v = body.track_hours;
    if (v != null && (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 200))
      return { error: "invalid track_hours" };
    values.track_hours = v ?? null;
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
    `INSERT INTO events (user_id, track_id, start_date, days, club, run_group, car, vehicle_id, notes,
                         conditions, temp_f, checklist, best_time_ms, track_hours)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(
      c.get("userId"),
      trackId,
      body.start_date,
      body.days ?? 1,
      body.club ?? null,
      body.run_group ?? null,
      body.car ?? null,
      // car is free text; the garage link is matched by name so parts and
      // setups can hang off a real vehicle row.
      await vehicleIdForCar(c.env.DB, c.get("userId"), body.car),
      body.notes ?? null,
      extras.values.conditions ?? null,
      extras.values.temp_f ?? null,
      extras.values.checklist ?? null,
      body.best_time_ms ?? null,
      extras.values.track_hours ?? null
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
  const setups = (
    await c.env.DB.prepare("SELECT day, data FROM setups WHERE event_id = ? ORDER BY day")
      .bind(id)
      .all<{ day: number; data: string }>()
  ).results.map((s) => ({ day: s.day, data: JSON.parse(s.data) }));
  return c.json({ ...withComputed(event), sessions: sessionsWithLaps, setups });
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
  // A car change re-matches the garage link (clearing it when the name no
  // longer names a garage vehicle).
  if ("car" in body) set("vehicle_id", await vehicleIdForCar(c.env.DB, userId, body.car));
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

// ---------- setup sheets (one per event day) ----------------------------------

const parseDay = (raw: string): number | null => {
  const day = Number(raw);
  return Number.isInteger(day) && day >= 1 && day <= 14 ? day : null;
};

events.put("/events/:id/setups/:day", async (c) => {
  const id = c.req.param("id");
  if (!(await ownedEvent(c.env.DB, c.get("userId"), id))) return c.json({ error: "not found" }, 404);
  const day = parseDay(c.req.param("day"));
  if (day == null) return c.json({ error: "invalid day" }, 400);
  const setup = sanitizeSetup(await c.req.json());
  if (setup === undefined) return c.json({ error: "invalid setup" }, 400);
  if (setup === null) return c.json({ error: "empty setup — delete it instead" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO setups (event_id, day, data) VALUES (?, ?, ?)
     ON CONFLICT(event_id, day) DO UPDATE SET data = excluded.data`
  )
    .bind(id, day, JSON.stringify(setup))
    .run();
  return c.json({ ok: true });
});

events.delete("/events/:id/setups/:day", async (c) => {
  const id = c.req.param("id");
  if (!(await ownedEvent(c.env.DB, c.get("userId"), id))) return c.json({ error: "not found" }, 404);
  const day = parseDay(c.req.param("day"));
  if (day == null) return c.json({ error: "invalid day" }, 400);
  const res = await c.env.DB.prepare("DELETE FROM setups WHERE event_id = ? AND day = ?")
    .bind(id, day)
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// Copy-forward prefill for a day's blank setup form: the previous day of the
// same event, else the most recent sheet from an earlier event on the same
// vehicle. Nobody re-types an alignment every session — the form starts from
// the last known state and the user edits what changed.
events.get("/events/:id/setups/prefill", async (c) => {
  const id = c.req.param("id");
  const userId = c.get("userId");
  const event = await c.env.DB.prepare(
    "SELECT id, vehicle_id, start_date FROM events WHERE id = ? AND user_id = ?"
  )
    .bind(id, userId)
    .first<{ id: number; vehicle_id: number | null; start_date: string }>();
  if (!event) return c.json({ error: "not found" }, 404);
  const day = parseDay(c.req.query("day") ?? "1") ?? 1;

  const sameEvent = await c.env.DB.prepare(
    "SELECT data FROM setups WHERE event_id = ? AND day < ? ORDER BY day DESC LIMIT 1"
  )
    .bind(id, day)
    .first<{ data: string }>();
  if (sameEvent) return c.json({ data: JSON.parse(sameEvent.data) });

  if (event.vehicle_id != null) {
    const prior = await c.env.DB.prepare(
      `SELECT s.data FROM setups s JOIN events e ON e.id = s.event_id
       WHERE e.user_id = ? AND e.vehicle_id = ? AND e.id != ? AND e.start_date <= ?
       ORDER BY e.start_date DESC, s.day DESC LIMIT 1`
    )
      .bind(userId, event.vehicle_id, id, event.start_date)
      .first<{ data: string }>();
    if (prior) return c.json({ data: JSON.parse(prior.data) });
  }
  return c.json({ data: null });
});
