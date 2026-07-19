import { Hono } from "hono";
import type { AppContext } from "../types";
import { ownedPart, vehicleHoursEvents } from "../db";
import { isValidDate, isValidPartKind } from "../lib/validate";
import { wearEstimate } from "../lib/wear";

// The user's garage (Settings → Vehicles). Vehicles feed the event form's
// car field; the one marked is_default pre-fills new events. Each vehicle
// also carries its consumable parts (garage page) — see GET /garage below.

export const vehicles = new Hono<AppContext>();

const clearDefault = (db: D1Database, userId: number) =>
  db.prepare("UPDATE vehicles SET is_default = 0 WHERE user_id = ? AND is_default = 1")
    .bind(userId)
    .run();

const normNotes = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

vehicles.get("/vehicles", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, name, notes, is_default FROM vehicles WHERE user_id = ? ORDER BY is_default DESC, name COLLATE NOCASE"
  )
    .bind(c.get("userId"))
    .all();
  return c.json(rows.results);
});

vehicles.post("/vehicles", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ name?: string; notes?: string | null; is_default?: boolean }>();
  const name = body.name?.trim();
  if (!name) return c.json({ error: "name required" }, 400);
  if ("is_default" in body && typeof body.is_default !== "boolean")
    return c.json({ error: "invalid is_default" }, 400);
  // The first vehicle in the garage becomes the default automatically.
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM vehicles WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  const makeDefault = body.is_default === true || count!.n === 0;
  if (makeDefault) await clearDefault(c.env.DB, userId);
  try {
    const row = await c.env.DB.prepare(
      "INSERT INTO vehicles (user_id, name, notes, is_default) VALUES (?, ?, ?, ?) RETURNING id, name, notes, is_default"
    )
      .bind(userId, name, normNotes(body.notes), makeDefault ? 1 : 0)
      .first();
    return c.json(row, 201);
  } catch {
    return c.json({ error: "a vehicle with that name already exists" }, 409);
  }
});

vehicles.put("/vehicles/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  // Ownership check up front so a foreign id can't clear this user's default
  // as a side effect below.
  const owned = await c.env.DB.prepare("SELECT id FROM vehicles WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first();
  if (!owned) return c.json({ error: "not found" }, 404);

  const body = await c.req.json<{ name?: string; notes?: string | null; is_default?: boolean }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return c.json({ error: "name required" }, 400);
    sets.push("name = ?");
    binds.push(name);
  }
  if ("notes" in body) {
    sets.push("notes = ?");
    binds.push(normNotes(body.notes));
  }
  if ("is_default" in body) {
    if (typeof body.is_default !== "boolean") return c.json({ error: "invalid is_default" }, 400);
    if (body.is_default) await clearDefault(c.env.DB, userId);
    sets.push("is_default = ?");
    binds.push(body.is_default ? 1 : 0);
  }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  binds.push(id, userId);
  try {
    await c.env.DB.prepare(`UPDATE vehicles SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
      .bind(...binds)
      .run();
  } catch {
    // UNIQUE(user_id, name) — the new name collides with another vehicle.
    return c.json({ error: "a vehicle with that name already exists" }, 409);
  }
  return c.json({ ok: true });
});

vehicles.delete("/vehicles/:id", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM vehicles WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), c.get("userId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// ---------- garage: consumable parts + wear -----------------------------------

const todayISO = () => new Date().toISOString().slice(0, 10);

// The whole garage in one payload: every vehicle with its accrued track
// hours and its parts, each carrying measurements and a wear estimate
// (lib/wear.ts). One round trip backs both the vehicle page and the
// dashboard's "due soon" strip, and caches cleanly for offline reads.
vehicles.get("/garage", async (c) => {
  const userId = c.get("userId");
  const db = c.env.DB;
  const today = todayISO();
  const [vehicleRows, partRows, measurementRows, hoursEvents] = await Promise.all([
    db
      .prepare(
        "SELECT id, name, notes, is_default, updated_at FROM vehicles WHERE user_id = ? ORDER BY is_default DESC, name COLLATE NOCASE"
      )
      .bind(userId)
      .all<{ id: number; name: string; notes: string | null; is_default: number; updated_at: number }>(),
    db
      .prepare(
        `SELECT p.id, p.vehicle_id, p.kind, p.name, p.installed_on, p.retired_on,
                p.cost_cents, p.expected_hours, p.wear_limit, p.notes
         FROM parts p JOIN vehicles v ON v.id = p.vehicle_id
         WHERE v.user_id = ? ORDER BY p.installed_on DESC, p.id DESC`
      )
      .bind(userId)
      .all<{
        id: number;
        vehicle_id: number;
        kind: string;
        name: string;
        installed_on: string;
        retired_on: string | null;
        cost_cents: number | null;
        expected_hours: number | null;
        wear_limit: number | null;
        notes: string | null;
      }>(),
    db
      .prepare(
        `SELECT m.id, m.part_id, m.measured_on, m.value, m.unit
         FROM part_measurements m
         JOIN parts p ON p.id = m.part_id JOIN vehicles v ON v.id = p.vehicle_id
         WHERE v.user_id = ? ORDER BY m.measured_on ASC, m.id ASC`
      )
      .bind(userId)
      .all<{ id: number; part_id: number; measured_on: string; value: number; unit: string }>(),
    vehicleHoursEvents(db, userId),
  ]);

  const garage = vehicleRows.results.map((v) => {
    const events = hoursEvents.filter((e) => e.vehicle_id === v.id);
    const parts = partRows.results
      .filter((p) => p.vehicle_id === v.id)
      .map((p) => {
        const measurements = measurementRows.results.filter((m) => m.part_id === p.id);
        return { ...p, measurements, wear: wearEstimate(p, events, measurements, today) };
      });
    const noPart = { installed_on: "0000-01-01", retired_on: null, expected_hours: null, wear_limit: null };
    const totals = wearEstimate(noPart, events, [], today); // whole-vehicle hours/days
    return {
      ...v,
      hours: totals.hours,
      event_days: totals.cycles,
      event_count: totals.events,
      parts,
    };
  });
  return c.json(garage);
});

// Validate part fields off `body`; returns normalized values or an error.
// `creating` requires kind/name/installed_on to be present.
function validatePart(body: any, creating: boolean): { error: string } | { values: Record<string, unknown> } {
  const values: Record<string, unknown> = {};
  if ("kind" in body || creating) {
    if (!isValidPartKind(body.kind)) return { error: "invalid kind" };
    values.kind = body.kind;
  }
  if ("name" in body || creating) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) return { error: "name required" };
    values.name = name;
  }
  if ("installed_on" in body || creating) {
    if (!isValidDate(body.installed_on)) return { error: "invalid installed_on" };
    values.installed_on = body.installed_on;
  }
  if ("retired_on" in body) {
    if (body.retired_on != null && !isValidDate(body.retired_on)) return { error: "invalid retired_on" };
    values.retired_on = body.retired_on ?? null;
  }
  if ("cost_cents" in body) {
    const v = body.cost_cents;
    if (v != null && (!Number.isInteger(v) || v < 0 || v > 100_000_00)) return { error: "invalid cost_cents" };
    values.cost_cents = v ?? null;
  }
  for (const col of ["expected_hours", "wear_limit"] as const) {
    if (!(col in body)) continue;
    const v = body[col];
    if (v != null && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 10_000))
      return { error: `invalid ${col}` };
    values[col] = v ?? null;
  }
  if ("notes" in body) values.notes = normNotes(body.notes);
  return { values };
}

vehicles.post("/vehicles/:id/parts", async (c) => {
  const userId = c.get("userId");
  const vehicleId = c.req.param("id");
  const owned = await c.env.DB.prepare("SELECT id FROM vehicles WHERE id = ? AND user_id = ?")
    .bind(vehicleId, userId)
    .first<{ id: number }>();
  if (!owned) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<any>();
  const checked = validatePart(body, true);
  if ("error" in checked) return c.json({ error: checked.error }, 400);
  const v = checked.values;

  // No expected life given? Default it from history: the average accrued
  // hours of retired parts of the same kind on this vehicle — the "lifecycle
  // average" that makes the second set of pads self-calibrating.
  if (v.expected_hours == null) {
    const prior = await c.env.DB.prepare(
      "SELECT installed_on, retired_on, expected_hours, wear_limit FROM parts WHERE vehicle_id = ? AND kind = ? AND retired_on IS NOT NULL"
    )
      .bind(vehicleId, v.kind)
      .all<{ installed_on: string; retired_on: string; expected_hours: number | null; wear_limit: number | null }>();
    if (prior.results.length) {
      const events = (await vehicleHoursEvents(c.env.DB, userId)).filter(
        (e) => e.vehicle_id === owned.id
      );
      const lives = prior.results
        .map((p) => wearEstimate(p, events, [], todayISO()).hours)
        .filter((h) => h > 0);
      if (lives.length)
        v.expected_hours = Math.round((lives.reduce((a, b) => a + b, 0) / lives.length) * 10) / 10;
    }
  }

  const row = await c.env.DB.prepare(
    `INSERT INTO parts (vehicle_id, kind, name, installed_on, retired_on, cost_cents, expected_hours, wear_limit, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(
      vehicleId,
      v.kind,
      v.name,
      v.installed_on,
      v.retired_on ?? null,
      v.cost_cents ?? null,
      v.expected_hours ?? null,
      v.wear_limit ?? null,
      v.notes ?? null
    )
    .first<{ id: number }>();
  return c.json({ id: row!.id }, 201);
});

vehicles.put("/parts/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!(await ownedPart(c.env.DB, userId, id))) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<any>();
  const checked = validatePart(body, false);
  if ("error" in checked) return c.json({ error: checked.error }, 400);
  const entries = Object.entries(checked.values);
  if (!entries.length) return c.json({ error: "nothing to update" }, 400);
  await c.env.DB.prepare(
    `UPDATE parts SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`
  )
    .bind(...entries.map(([, v]) => v), id)
    .run();
  return c.json({ ok: true });
});

vehicles.delete("/parts/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!(await ownedPart(c.env.DB, userId, id))) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("DELETE FROM parts WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

vehicles.post("/parts/:id/measurements", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!(await ownedPart(c.env.DB, userId, id))) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ measured_on?: unknown; value?: unknown; unit?: unknown }>();
  if (!isValidDate(body.measured_on)) return c.json({ error: "invalid measured_on" }, 400);
  if (typeof body.value !== "number" || !Number.isFinite(body.value) || body.value < 0 || body.value > 10_000)
    return c.json({ error: "invalid value" }, 400);
  const unit = typeof body.unit === "string" && body.unit.trim() ? body.unit.trim().slice(0, 12) : "mm";
  const row = await c.env.DB.prepare(
    "INSERT INTO part_measurements (part_id, measured_on, value, unit) VALUES (?, ?, ?, ?) RETURNING id"
  )
    .bind(id, body.measured_on, Math.round(body.value * 100) / 100, unit)
    .first<{ id: number }>();
  return c.json({ id: row!.id }, 201);
});

vehicles.delete("/parts/:id/measurements/:mid", async (c) => {
  const userId = c.get("userId");
  if (!(await ownedPart(c.env.DB, userId, c.req.param("id")))) return c.json({ error: "not found" }, 404);
  const res = await c.env.DB.prepare("DELETE FROM part_measurements WHERE id = ? AND part_id = ?")
    .bind(c.req.param("mid"), c.req.param("id"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
