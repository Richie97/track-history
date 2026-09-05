import { Hono } from "hono";
import type { AppContext } from "../types";
import { requireEntitlement } from "../middleware";
import { type VehicleHoursEvent, vehicleHoursEventsStmt } from "../db";
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

// The target hot tyre pressure (psi, all four corners) the session health
// strip's pressure loop aims the next cold pressures at (#190). null clears
// it; a value outside what a road or race tyre ever runs is rejected.
// Returns undefined for an invalid value.
const normTargetPsi = (v: unknown): number | null | undefined => {
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 5 || v > 100) return undefined;
  return Math.round(v * 10) / 10;
};

type VehicleBody = { name?: string; notes?: string | null; is_default?: boolean; target_hot_psi?: number | null };

vehicles.get("/vehicles", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, name, notes, is_default, target_hot_psi FROM vehicles WHERE user_id = ? ORDER BY is_default DESC, name COLLATE NOCASE"
  )
    .bind(c.get("userId"))
    .all();
  return c.json(rows.results);
});

vehicles.post("/vehicles", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<VehicleBody>();
  const name = body.name?.trim();
  if (!name) return c.json({ error: "name required" }, 400);
  if ("is_default" in body && typeof body.is_default !== "boolean")
    return c.json({ error: "invalid is_default" }, 400);
  const targetPsi = normTargetPsi(body.target_hot_psi);
  if (targetPsi === undefined) return c.json({ error: "invalid target_hot_psi" }, 400);
  // The first vehicle in the garage becomes the default automatically.
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM vehicles WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  const makeDefault = body.is_default === true || count!.n === 0;
  if (makeDefault) await clearDefault(c.env.DB, userId);
  try {
    const row = await c.env.DB.prepare(
      "INSERT INTO vehicles (user_id, name, notes, is_default, target_hot_psi) VALUES (?, ?, ?, ?, ?) RETURNING id, name, notes, is_default, target_hot_psi"
    )
      .bind(userId, name, normNotes(body.notes), makeDefault ? 1 : 0, targetPsi)
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

  const body = await c.req.json<VehicleBody>();
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
  if ("target_hot_psi" in body) {
    const targetPsi = normTargetPsi(body.target_hot_psi);
    if (targetPsi === undefined) return c.json({ error: "invalid target_hot_psi" }, 400);
    sets.push("target_hot_psi = ?");
    binds.push(targetPsi);
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
vehicles.get("/garage", requireEntitlement, async (c) => {
  const userId = c.get("userId");
  const db = c.env.DB;
  const today = todayISO();
  // Four independent reads, one batched round trip.
  const [vehicleRes, partRes, measurementRes, hoursRes] = await db.batch([
    db
      .prepare(
        "SELECT id, name, notes, is_default, target_hot_psi, updated_at FROM vehicles WHERE user_id = ? ORDER BY is_default DESC, name COLLATE NOCASE"
      )
      .bind(userId),
    db
      .prepare(
        `SELECT p.id, p.vehicle_id, p.kind, p.name, p.installed_on, p.retired_on,
                p.cost_cents, p.expected_hours, p.wear_limit, p.notes
         FROM parts p JOIN vehicles v ON v.id = p.vehicle_id
         WHERE v.user_id = ? ORDER BY p.installed_on DESC, p.id DESC`
      )
      .bind(userId),
    db
      .prepare(
        `SELECT m.id, m.part_id, m.measured_on, m.value, m.unit
         FROM part_measurements m
         JOIN parts p ON p.id = m.part_id JOIN vehicles v ON v.id = p.vehicle_id
         WHERE v.user_id = ? ORDER BY m.measured_on ASC, m.id ASC`
      )
      .bind(userId),
    vehicleHoursEventsStmt(db, userId),
  ]);
  const vehicleRows = {
    results: vehicleRes.results as {
      id: number;
      name: string;
      notes: string | null;
      is_default: number;
      target_hot_psi: number | null;
      updated_at: number;
    }[],
  };
  const partRows = {
    results: partRes.results as {
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
    }[],
  };
  const measurementRows = {
    results: measurementRes.results as { id: number; part_id: number; measured_on: string; value: number; unit: string }[],
  };
  const hoursEvents = hoursRes.results as VehicleHoursEvent[];

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

// The "lifecycle average": mean accrued hours of this vehicle's retired parts
// of the same kind — what a fresh part's expected life defaults to, making the
// second set of pads self-calibrating. Null when there's no usable history.
async function retiredLifecycleAvg(
  db: D1Database,
  userId: number,
  vehicleId: number,
  kind: string
): Promise<number | null> {
  // Both reads in one round trip; the hours ledger is only a filter away
  // from being needed whenever there is any retired history.
  const [priorRes, hoursRes] = await db.batch([
    db
      .prepare(
        "SELECT installed_on, retired_on, expected_hours, wear_limit FROM parts WHERE vehicle_id = ? AND kind = ? AND retired_on IS NOT NULL"
      )
      .bind(vehicleId, kind),
    vehicleHoursEventsStmt(db, userId),
  ]);
  const prior = {
    results: priorRes.results as { installed_on: string; retired_on: string; expected_hours: number | null; wear_limit: number | null }[],
  };
  if (!prior.results.length) return null;
  const events = (hoursRes.results as VehicleHoursEvent[]).filter((e) => e.vehicle_id === vehicleId);
  const lives = prior.results
    .map((p) => wearEstimate(p, events, [], todayISO()).hours)
    .filter((h) => h > 0);
  if (!lives.length) return null;
  return Math.round((lives.reduce((a, b) => a + b, 0) / lives.length) * 10) / 10;
}

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

vehicles.post("/vehicles/:id/parts", requireEntitlement, async (c) => {
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

  // No expected life given? Default it from history.
  if (v.expected_hours == null)
    v.expected_hours = await retiredLifecycleAvg(c.env.DB, userId, owned.id, v.kind as string);

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

vehicles.put("/parts/:id", requireEntitlement, async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json<any>();
  const checked = validatePart(body, false);
  if ("error" in checked) return c.json({ error: checked.error }, 400);
  const entries = Object.entries(checked.values);
  if (!entries.length) return c.json({ error: "nothing to update" }, 400);
  // Ownership is folded into the update — zero changed rows means the part
  // isn't this user's (or doesn't exist).
  const res = await c.env.DB.prepare(
    `UPDATE parts SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ? AND vehicle_id IN (SELECT id FROM vehicles WHERE user_id = ?)`
  )
    .bind(...entries.map(([, v]) => v), id, userId)
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// One-tap replacement ("I put a fresh set of the same pads on"): retires the
// current part as of the swap date and inserts a same-spec successor, so hours
// reset without re-entering the part. The old row keeps its measurements and
// history; the successor's expected life recomputes from retired lifecycles
// (which now include the old part), falling back to the old part's value.
vehicles.post("/parts/:id/refresh", requireEntitlement, async (c) => {
  const userId = c.get("userId");
  const old = await c.env.DB.prepare(
    `SELECT p.id, p.vehicle_id, p.kind, p.name, p.installed_on, p.retired_on,
            p.cost_cents, p.expected_hours, p.wear_limit, p.notes
     FROM parts p JOIN vehicles v ON v.id = p.vehicle_id
     WHERE p.id = ? AND v.user_id = ?`
  )
    .bind(c.req.param("id"), userId)
    .first<{
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
    }>();
  if (!old) return c.json({ error: "not found" }, 404);
  if (old.retired_on) return c.json({ error: "part is already retired" }, 400);

  const body = await c.req.json<any>().catch(() => ({}));
  const swapDate = body.installed_on ?? todayISO();
  if (!isValidDate(swapDate) || swapDate < old.installed_on)
    return c.json({ error: "invalid installed_on" }, 400);
  let cost = old.cost_cents;
  if ("cost_cents" in body) {
    const v = body.cost_cents;
    if (v != null && (!Number.isInteger(v) || v < 0 || v > 100_000_00))
      return c.json({ error: "invalid cost_cents" }, 400);
    cost = v ?? null;
  }
  let name = old.name;
  if ("name" in body) {
    name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) return c.json({ error: "name required" }, 400);
  }

  await c.env.DB.prepare("UPDATE parts SET retired_on = ? WHERE id = ?").bind(swapDate, old.id).run();
  const expected =
    (await retiredLifecycleAvg(c.env.DB, userId, old.vehicle_id, old.kind)) ?? old.expected_hours;
  const row = await c.env.DB.prepare(
    `INSERT INTO parts (vehicle_id, kind, name, installed_on, cost_cents, expected_hours, wear_limit, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(old.vehicle_id, old.kind, name, swapDate, cost, expected, old.wear_limit, old.notes)
    .first<{ id: number }>();
  return c.json({ id: row!.id, retired_id: old.id }, 201);
});

vehicles.delete("/parts/:id", requireEntitlement, async (c) => {
  const res = await c.env.DB.prepare(
    "DELETE FROM parts WHERE id = ? AND vehicle_id IN (SELECT id FROM vehicles WHERE user_id = ?)"
  )
    .bind(c.req.param("id"), c.get("userId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

vehicles.post("/parts/:id/measurements", requireEntitlement, async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json<{ measured_on?: unknown; value?: unknown; unit?: unknown }>();
  if (!isValidDate(body.measured_on)) return c.json({ error: "invalid measured_on" }, 400);
  if (typeof body.value !== "number" || !Number.isFinite(body.value) || body.value < 0 || body.value > 10_000)
    return c.json({ error: "invalid value" }, 400);
  const unit = typeof body.unit === "string" && body.unit.trim() ? body.unit.trim().slice(0, 12) : "mm";
  // Ownership check and insert in one statement: the SELECT yields no row
  // for a part that isn't this user's, so nothing is inserted and we 404.
  const row = await c.env.DB.prepare(
    `INSERT INTO part_measurements (part_id, measured_on, value, unit)
     SELECT p.id, ?2, ?3, ?4 FROM parts p JOIN vehicles v ON v.id = p.vehicle_id
     WHERE p.id = ?1 AND v.user_id = ?5
     RETURNING id`
  )
    .bind(id, body.measured_on, Math.round(body.value * 100) / 100, unit, userId)
    .first<{ id: number }>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ id: row.id }, 201);
});

vehicles.delete("/parts/:id/measurements/:mid", requireEntitlement, async (c) => {
  const res = await c.env.DB.prepare(
    `DELETE FROM part_measurements WHERE id = ?1 AND part_id = ?2
       AND part_id IN (SELECT p.id FROM parts p JOIN vehicles v ON v.id = p.vehicle_id WHERE v.user_id = ?3)`
  )
    .bind(c.req.param("mid"), c.req.param("id"), c.get("userId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
