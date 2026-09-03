import { Hono } from "hono";
import type { AppContext } from "../types";
import { eventSelect, listEvents, ownedEvent, resolveTrack, vehicleIdForCar } from "../db";
import { type EventRow, withComputed } from "../lib/stats";
import { isValidConditions, isValidTemp, sanitizeChecklist, sanitizeSetup } from "../lib/validate";
import { requireEntitlement } from "../middleware";
import { isEntitled, stripProFields } from "../lib/entitlement";

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
  const extras = validateExtras(body);
  if ("error" in extras) return c.json({ error: extras.error }, 400);
  // car is free text; the garage link is matched by name so parts and setups
  // can hang off a real vehicle row. Independent of the track lookup, so the
  // two queries run concurrently.
  const [trackId, vehicleId] = await Promise.all([
    resolveTrack(c.env.DB, c.get("userId"), body),
    vehicleIdForCar(c.env.DB, c.get("userId"), body.car),
  ]);
  if (!trackId) return c.json({ error: "track required" }, 400);
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
      vehicleId,
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
  const db = c.env.DB;
  // One round trip for the whole page; child rows are discarded on the 404
  // path, so nothing leaks when the event isn't this user's.
  const [eventRes, sessionRes, lapRes, setupRes] = await db.batch([
    db.prepare(eventSelect("WHERE e.user_id = ? AND e.id = ?")).bind(userId, id),
    db
      .prepare(
        "SELECT id, label, notes, sort, trace, channels FROM sessions WHERE event_id = ? ORDER BY sort, id"
      )
      .bind(id),
    db
      .prepare(
        "SELECT l.id, l.session_id, l.lap_num, l.time_ms FROM laps l JOIN sessions s ON s.id = l.session_id WHERE s.event_id = ? ORDER BY l.session_id, l.lap_num"
      )
      .bind(id),
    db.prepare("SELECT day, data FROM setups WHERE event_id = ? ORDER BY day").bind(id),
  ]);
  const event = eventRes.results[0] as EventRow | undefined;
  if (!event) return c.json({ error: "not found" }, 404);

  // `channels` is the one Pro field (NS-32 rule 4): a free account gets the
  // session, its laps and its `trace` — the track map is free — with the
  // per-lap channel arrays nulled, which is exactly the shape every client
  // already renders as "no channel data".
  const entitled = isEntitled(c.get("entitledUntil"), Date.now());
  const sessions = (
    sessionRes.results as { id: number; label: string | null; notes: string | null; sort: number; trace: string | null; channels: string | null }[]
  ).map((s) =>
    stripProFields(
      {
        ...s,
        trace: s.trace ? JSON.parse(s.trace) : null,
        channels: s.channels ? JSON.parse(s.channels) : null,
      },
      entitled
    )
  );
  const laps = lapRes.results as { id: number; session_id: number; lap_num: number; time_ms: number }[];

  const sessionsWithLaps = sessions.map((s) => ({
    ...s,
    laps: laps.filter((l) => l.session_id === s.id),
  }));
  const setups = (setupRes.results as { day: number; data: string }[]).map((s) => ({
    day: s.day,
    data: JSON.parse(s.data),
  }));
  return c.json({ ...withComputed(event), sessions: sessionsWithLaps, setups });
});

events.put("/events/:id", async (c) => {
  const id = c.req.param("id");
  const userId = c.get("userId");
  if (!(await ownedEvent(c.env.DB, userId, id))) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<any>();
  // The track lookup and the garage-link re-match are independent — run them
  // concurrently. A car change re-matches the garage link (clearing it when
  // the name no longer names a garage vehicle).
  const [trackId, vehicleId] = await Promise.all([
    body.track_id || body.track_name ? resolveTrack(c.env.DB, userId, body) : undefined,
    "car" in body ? vehicleIdForCar(c.env.DB, userId, body.car) : undefined,
  ]);
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
  if ("car" in body) set("vehicle_id", vehicleId ?? null);
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
  const res = await c.env.DB.prepare("DELETE FROM events WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), c.get("userId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// ---------- setup sheets (one per event day) ----------------------------------

const parseDay = (raw: string): number | null => {
  const day = Number(raw);
  return Number.isInteger(day) && day >= 1 && day <= 14 ? day : null;
};

events.put("/events/:id/setups/:day", requireEntitlement, async (c) => {
  const id = c.req.param("id");
  const day = parseDay(c.req.param("day"));
  if (day == null) return c.json({ error: "invalid day" }, 400);
  const setup = sanitizeSetup(await c.req.json());
  if (setup === undefined) return c.json({ error: "invalid setup" }, 400);
  if (setup === null) return c.json({ error: "empty setup — delete it instead" }, 400);
  // Ownership is folded into the upsert: the SELECT yields no row for an
  // event that isn't this user's, so nothing is written and we 404.
  const res = await c.env.DB.prepare(
    `INSERT INTO setups (event_id, day, data)
     SELECT id, ?2, ?3 FROM events WHERE id = ?1 AND user_id = ?4
     ON CONFLICT(event_id, day) DO UPDATE SET data = excluded.data`
  )
    .bind(id, day, JSON.stringify(setup), c.get("userId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

events.delete("/events/:id/setups/:day", requireEntitlement, async (c) => {
  const id = c.req.param("id");
  const day = parseDay(c.req.param("day"));
  if (day == null) return c.json({ error: "invalid day" }, 400);
  // Ownership-scoped like the upsert above; a foreign event and a missing
  // sheet both leave changes at 0 and 404, same as before.
  const res = await c.env.DB.prepare(
    "DELETE FROM setups WHERE event_id = ?1 AND day = ?2 AND EXISTS (SELECT 1 FROM events WHERE id = ?1 AND user_id = ?3)"
  )
    .bind(id, day, c.get("userId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// Copy-forward prefill for a day's blank setup form: the previous day of the
// same event, else the most recent sheet from an earlier event on the same
// vehicle. Nobody re-types an alignment every session — the form starts from
// the last known state and the user edits what changed.
events.get("/events/:id/setups/prefill", requireEntitlement, async (c) => {
  const id = c.req.param("id");
  const userId = c.get("userId");
  const day = parseDay(c.req.query("day") ?? "1") ?? 1;
  // The event row and the same-event lookup are independent — one round trip.
  const [eventRes, sameRes] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT id, vehicle_id, start_date FROM events WHERE id = ? AND user_id = ?").bind(
      id,
      userId
    ),
    c.env.DB.prepare(
      "SELECT data FROM setups WHERE event_id = ? AND day < ? ORDER BY day DESC LIMIT 1"
    ).bind(id, day),
  ]);
  const event = eventRes.results[0] as
    | { id: number; vehicle_id: number | null; start_date: string }
    | undefined;
  if (!event) return c.json({ error: "not found" }, 404);

  const sameEvent = sameRes.results[0] as { data: string } | undefined;
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
