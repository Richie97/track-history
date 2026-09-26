import { Hono } from "hono";
import type { AppContext } from "../types";
import { requireEntitlement } from "../middleware";
import {
  type VehicleHoursEvent,
  type VehicleHoursSession,
  type VehicleOdometerReading,
  vehicleHoursEventsStmt,
  vehicleHoursSessionsStmt,
  vehicleOdometerStmt,
  withHoursSessions,
} from "../db";
import { isValidDate, isValidPartKind, isValidSteeringRatio, isValidWheelbaseMm } from "../lib/validate";
import { MAX_FIT_SESSIONS, steeringFit } from "../lib/steering";
import { type Mount, equipSwapKinds, wearEstimate } from "../lib/wear";
import { partOdometer, vehicleOdometer } from "../lib/odometer";
import { eventCostCents } from "../lib/costs";

// The user's garage (Settings → Vehicles). Vehicles feed the event form's
// car field; the one marked is_default pre-fills new events. Each vehicle
// also carries its consumable parts (garage page) — see GET /garage below.
//
// A vehicle also carries two spec-sheet constants, `wheelbase_mm` and
// `steering_ratio` (#208), and an optional `catalog_id` into the seeded
// car_catalog (#221). The catalog is identity, not ownership: picking a row
// pre-fills the two numbers *at pick time* and is never consulted again for
// that vehicle, so a corrected number is the user's and a later catalog fix
// doesn't silently rewrite a car that reads correctly.

export const vehicles = new Hono<AppContext>();

// Every column a vehicle response carries; the list, the create and the garage
// all select the same set so the three shapes cannot drift apart.
const VEHICLE_COLUMNS = "id, name, notes, is_default, target_hot_psi, catalog_id, wheelbase_mm, steering_ratio";

const clearDefault = (db: D1Database, userId: number) =>
  db.prepare("UPDATE vehicles SET is_default = 0 WHERE user_id = ? AND is_default = 1")
    .bind(userId)
    .run();

const normNotes = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

// The target hot tire pressure (psi, all four corners) the session health
// strip's pressure loop aims the next cold pressures at (#190). null clears
// it; a value outside what a road or race tire ever runs is rejected.
// Returns undefined for an invalid value.
const normTargetPsi = (v: unknown): number | null | undefined => {
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 5 || v > 100) return undefined;
  return Math.round(v * 10) / 10;
};

type VehicleBody = {
  name?: string;
  notes?: string | null;
  is_default?: boolean;
  target_hot_psi?: number | null;
  catalog_id?: number | null;
  wheelbase_mm?: number | null;
  steering_ratio?: number | null;
};

// The geometry columns a vehicle write can carry, validated off the body.
// Returns the normalized values for the keys *present* (absent keys stay
// absent, so a PUT leaves them alone), or the error to answer with.
function geometryFrom(body: VehicleBody): { error: string } | { values: Partial<Record<"wheelbase_mm" | "steering_ratio", number | null>> } {
  const values: Partial<Record<"wheelbase_mm" | "steering_ratio", number | null>> = {};
  if ("wheelbase_mm" in body) {
    if (!isValidWheelbaseMm(body.wheelbase_mm)) return { error: "invalid wheelbase_mm" };
    values.wheelbase_mm = body.wheelbase_mm ?? null;
  }
  if ("steering_ratio" in body) {
    if (!isValidSteeringRatio(body.steering_ratio)) return { error: "invalid steering_ratio" };
    values.steering_ratio = body.steering_ratio == null ? null : Math.round(body.steering_ratio * 100) / 100;
  }
  return { values };
}

type CatalogGeometry = { id: number; wheelbase_mm: number; steering_ratio: number | null };

// Resolve a body's `catalog_id`: absent → undefined (leave alone), null →
// null (unlink), a known id → the row, anything else → an error. The row's
// geometry is what a pick pre-fills.
async function resolveCatalog(
  db: D1Database,
  body: VehicleBody
): Promise<{ error: string } | { catalog: CatalogGeometry | null | undefined }> {
  if (!("catalog_id" in body)) return { catalog: undefined };
  if (body.catalog_id == null) return { catalog: null };
  if (!Number.isInteger(body.catalog_id)) return { error: "invalid catalog_id" };
  const row = await db
    .prepare("SELECT id, wheelbase_mm, steering_ratio FROM car_catalog WHERE id = ?")
    .bind(body.catalog_id)
    .first<CatalogGeometry>();
  if (!row) return { error: "unknown catalog_id" };
  return { catalog: row };
}

// The pick rule: a catalog row pre-fills *both* numbers unless the body
// carries its own value for one — an explicit value (or null) always wins.
// Both are filled, including a null ratio, so a car swapped from one catalog
// entry to another never keeps the previous car's ratio.
function prefillFromCatalog(
  catalog: CatalogGeometry | null | undefined,
  values: Partial<Record<"wheelbase_mm" | "steering_ratio", number | null>>
) {
  if (!catalog) return;
  if (!("wheelbase_mm" in values)) values.wheelbase_mm = catalog.wheelbase_mm;
  if (!("steering_ratio" in values)) values.steering_ratio = catalog.steering_ratio;
}

vehicles.get("/vehicles", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT ${VEHICLE_COLUMNS} FROM vehicles WHERE user_id = ? ORDER BY is_default DESC, name COLLATE NOCASE`
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
  const geometry = geometryFrom(body);
  if ("error" in geometry) return c.json({ error: geometry.error }, 400);
  const picked = await resolveCatalog(c.env.DB, body);
  if ("error" in picked) return c.json({ error: picked.error }, 400);
  prefillFromCatalog(picked.catalog, geometry.values);
  // The first vehicle in the garage becomes the default automatically.
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM vehicles WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  const makeDefault = body.is_default === true || count!.n === 0;
  if (makeDefault) await clearDefault(c.env.DB, userId);
  try {
    const row = await c.env.DB.prepare(
      `INSERT INTO vehicles (user_id, name, notes, is_default, target_hot_psi, catalog_id, wheelbase_mm, steering_ratio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${VEHICLE_COLUMNS}`
    )
      .bind(
        userId,
        name,
        normNotes(body.notes),
        makeDefault ? 1 : 0,
        targetPsi,
        picked.catalog?.id ?? null,
        geometry.values.wheelbase_mm ?? null,
        geometry.values.steering_ratio ?? null
      )
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
  const geometry = geometryFrom(body);
  if ("error" in geometry) return c.json({ error: geometry.error }, 400);
  const picked = await resolveCatalog(c.env.DB, body);
  if ("error" in picked) return c.json({ error: picked.error }, 400);
  if (picked.catalog !== undefined) {
    sets.push("catalog_id = ?");
    binds.push(picked.catalog?.id ?? null);
    // Re-picking is a pick: the new row's numbers replace the old ones unless
    // the body says otherwise. Unlinking (null) leaves the numbers as they are.
    prefillFromCatalog(picked.catalog, geometry.values);
  }
  for (const [col, value] of Object.entries(geometry.values)) {
    sets.push(`${col} = ?`);
    binds.push(value);
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

// ---------- the measured steering ratio (#223) --------------------------------

// The per-session steering fits behind the vehicle form's "Measured from 6
// sessions: 15.8:1" line: `steeringFit` (lib/steering.ts, the mirror of
// public/js/balance.js) over the car's most recent MAX_FIT_SESSIONS sessions
// that stored channels, newest first, keeping only the ones that fit. The
// client pools them with `estimateSteeringRatio` against the wheelbase *in the
// form* — which may not be the stored one yet — so the ratio is not computed
// here. Its own route rather than a field on GET /garage: the dashboard reads
// the garage on every load, and eight channel blobs per car is a read worth
// making only when the form that shows the line is open. Pro, like the rest
// of the garage. A foreign vehicle is a 404, the same as everywhere else.
vehicles.get("/vehicles/:id/steering-fit", requireEntitlement, async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const db = c.env.DB;
  const [owned, sessionRes] = await db.batch([
    db.prepare("SELECT id FROM vehicles WHERE id = ? AND user_id = ?").bind(id, userId),
    db
      .prepare(
        `SELECT s.id AS session_id, s.event_id, e.start_date, s.channels
         FROM sessions s JOIN events e ON e.id = s.event_id
         WHERE e.user_id = ?1 AND e.vehicle_id = ?2 AND s.channels IS NOT NULL
         ORDER BY e.start_date DESC, s.id DESC
         LIMIT ?3`
      )
      .bind(userId, id, MAX_FIT_SESSIONS),
  ]);
  if (!owned.results.length) return c.json({ error: "not found" }, 404);
  const rows = sessionRes.results as { session_id: number; event_id: number; start_date: string; channels: string }[];
  const fits = [];
  for (const row of rows) {
    const fit = steeringFit(JSON.parse(row.channels));
    if (!fit) continue;
    fits.push({ session_id: row.session_id, event_id: row.event_id, start_date: row.start_date, ...fit });
  }
  return c.json({ fits });
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
  // Six independent reads, one batched round trip.
  const [vehicleRes, partRes, measurementRes, mountRes, hoursRes, sessionRes, odometerRes] = await db.batch([
    db
      .prepare(
        `SELECT ${VEHICLE_COLUMNS}, updated_at FROM vehicles WHERE user_id = ? ORDER BY is_default DESC, name COLLATE NOCASE`
      )
      .bind(userId),
    db
      .prepare(
        `SELECT p.id, p.vehicle_id, p.kind, p.name, p.size, p.installed_on, p.retired_on,
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
    partMountsStmt(db, userId),
    vehicleHoursEventsStmt(db, userId),
    vehicleHoursSessionsStmt(db, userId),
    vehicleOdometerStmt(db, userId),
  ]);
  const vehicleRows = {
    results: vehicleRes.results as {
      id: number;
      name: string;
      notes: string | null;
      is_default: number;
      target_hot_psi: number | null;
      catalog_id: number | null;
      wheelbase_mm: number | null;
      steering_ratio: number | null;
      updated_at: number;
    }[],
  };
  const partRows = {
    results: partRes.results as {
      id: number;
      vehicle_id: number;
      kind: string;
      name: string;
      size: string | null;
      installed_on: string;
      retired_on: string | null;
      cost_cents: number | null;
      expected_hours: number | null;
      wear_limit: number | null;
      notes: string | null;
    }[],
  };
  const mountsByPart = groupMounts(mountRes.results as MountRow[]);
  const measurementRows = {
    results: measurementRes.results as { id: number; part_id: number; measured_on: string; value: number; unit: string }[],
  };
  const hoursEvents = withHoursSessions(hoursRes.results as VehicleHoursEvent[], sessionRes.results as VehicleHoursSession[]);
  const odometerReadings = odometerRes.results as VehicleOdometerReading[];

  const garage = vehicleRows.results.map((v) => {
    const events = hoursEvents.filter((e) => e.vehicle_id === v.id);
    const readings = odometerReadings.filter((r) => r.vehicle_id === v.id);
    const parts = partRows.results
      .filter((p) => p.vehicle_id === v.id)
      .map((p) => {
        const measurements = measurementRows.results.filter((m) => m.part_id === p.id);
        const mounts = mountsByPart.get(p.id) ?? [];
        const withMounts = { ...p, mounts };
        return {
          ...p,
          // On the car right now: an open mount on a part that isn't retired.
          // A part that is neither equipped nor retired is on the shelf — a
          // spare set, the street pads — and accrues nothing until it goes
          // back on.
          equipped: !p.retired_on && mounts.some((m) => m.removed_on == null),
          mounts,
          measurements,
          wear: wearEstimate(withMounts, events, measurements, today),
          // The car's own odometer across the part's recorded sessions (#192):
          // reported beside the hours estimate, never an input to it.
          odometer: partOdometer(withMounts, readings, today),
        };
      });
    const noPart = { installed_on: "0000-01-01", retired_on: null, expected_hours: null, wear_limit: null };
    const totals = wearEstimate(noPart, events, [], today); // whole-vehicle hours/days
    return {
      ...v,
      hours: totals.hours,
      event_days: totals.cycles,
      event_count: totals.events,
      // What the car has cost (#147), in cents: its past track days' entered
      // costs (the same events the hours accrue from — an upcoming one isn't
      // spent yet, on the same rule) and every part ever fitted, retired ones
      // included, since a season's real cost includes the tires it consumed.
      // Zero rather than null when nothing was entered: these are sums.
      event_cost_cents: events.reduce((sum, e) => sum + (eventCostCents(e) ?? 0), 0),
      parts_cost_cents: parts.reduce((sum, p) => sum + (p.cost_cents ?? 0), 0),
      // What the car's own odometer last said (#192), from video imports only;
      // null when no recorded session carries a reading.
      odometer: vehicleOdometer(readings),
      parts,
    };
  });
  return c.json(garage);
});

// A mount's columns as every response carries them: its dates (migration 0029)
// and the swap point inside an event either end sits at, if any (0030).
const MOUNT_COLUMNS = `m.mounted_on, m.removed_on, m.mounted_event_id, m.mounted_after_session_id,
  m.removed_event_id, m.removed_after_session_id`;
const mountJson = (m: Mount) => ({
  mounted_on: m.mounted_on,
  removed_on: m.removed_on,
  mounted_event_id: m.mounted_event_id ?? null,
  mounted_after_session_id: m.mounted_after_session_id ?? null,
  removed_event_id: m.removed_event_id ?? null,
  removed_after_session_id: m.removed_after_session_id ?? null,
});

// Every mount of every one of the user's parts, oldest first (migration 0029),
// with the swap points its ends sit at, if any (0030).
type MountRow = Mount & { part_id: number };
const partMountsStmt = (db: D1Database, userId: number) =>
  db
    .prepare(
      `SELECT m.part_id, ${MOUNT_COLUMNS}
       FROM part_mounts m JOIN parts p ON p.id = m.part_id JOIN vehicles v ON v.id = p.vehicle_id
       WHERE v.user_id = ? ORDER BY m.mounted_on ASC, m.id ASC`
    )
    .bind(userId);
function groupMounts(rows: MountRow[]): Map<number, Mount[]> {
  const out = new Map<number, Mount[]>();
  for (const row of rows) {
    const list = out.get(row.part_id) ?? [];
    list.push(mountJson(row));
    out.set(row.part_id, list);
  }
  return out;
}

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
  const [priorRes, hoursRes, sessionRes, mountRes] = await db.batch([
    db
      .prepare(
        "SELECT id, installed_on, retired_on, expected_hours, wear_limit FROM parts WHERE vehicle_id = ? AND kind = ? AND retired_on IS NOT NULL"
      )
      .bind(vehicleId, kind),
    vehicleHoursEventsStmt(db, userId),
    vehicleHoursSessionsStmt(db, userId),
    partMountsStmt(db, userId),
  ]);
  const prior = {
    results: priorRes.results as {
      id: number;
      installed_on: string;
      retired_on: string;
      expected_hours: number | null;
      wear_limit: number | null;
    }[],
  };
  if (!prior.results.length) return null;
  const events = withHoursSessions(
    hoursRes.results as VehicleHoursEvent[],
    sessionRes.results as VehicleHoursSession[]
  ).filter((e) => e.vehicle_id === vehicleId);
  const mountsByPart = groupMounts(mountRes.results as MountRow[]);
  const lives = prior.results
    .map((p) => wearEstimate({ ...p, mounts: mountsByPart.get(p.id) ?? [] }, events, [], todayISO()).hours)
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
  if ("size" in body) {
    if (body.size != null && typeof body.size !== "string") return { error: "invalid size" };
    const size = typeof body.size === "string" ? body.size.trim() : "";
    if (size.length > 40) return { error: "invalid size" };
    values.size = size || null;
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
  // `equipped: false` adds a spare straight to the shelf; anything else puts
  // it on the car from installed_on, as every part was before 0029. `swap`
  // additionally takes off what it replaces, as equipping does.
  if ("equipped" in body && typeof body.equipped !== "boolean") return c.json({ error: "invalid equipped" }, 400);
  const equipped = body.equipped !== false && v.retired_on == null;
  // A part going on the car went on at a point in its install day (0030).
  const swap = equipped ? await swapPoint(c.env.DB, userId, owned.id, v.installed_on as string, body) : { point: null };
  if ("error" in swap) return c.json({ error: swap.error }, 400);
  const { point } = swap;

  // No expected life given? Default it from history.
  if (v.expected_hours == null)
    v.expected_hours = await retiredLifecycleAvg(c.env.DB, userId, owned.id, v.kind as string);

  const db = c.env.DB;
  if (equipped && body.swap === true)
    await swapOffStmt(db, owned.id, v.kind as string, null, v.installed_on as string, point).run();
  // The insert trigger mounts the part from installed_on (migration 0029).
  const row = await db.prepare(
    `INSERT INTO parts (vehicle_id, kind, name, size, installed_on, retired_on, cost_cents, expected_hours, wear_limit, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(
      vehicleId,
      v.kind,
      v.name,
      v.size ?? null,
      v.installed_on,
      v.retired_on ?? null,
      v.cost_cents ?? null,
      v.expected_hours ?? null,
      v.wear_limit ?? null,
      v.notes ?? null
    )
    .first<{ id: number }>();
  if (!equipped && v.retired_on == null)
    await db.prepare("DELETE FROM part_mounts WHERE part_id = ?").bind(row!.id).run();
  else if (point)
    await db
      .prepare("UPDATE part_mounts SET mounted_event_id = ?, mounted_after_session_id = ? WHERE part_id = ?")
      .bind(point.event, point.after, row!.id)
      .run();
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
//
// A *retired* part refreshes too — "buy another set of those": nothing is
// retired, the successor is a copy of its spec installed on the swap date,
// and it goes on the car unless the body says `equipped: false`. `swap: true`
// takes off whatever shares its place, as creating an equipped part does.
vehicles.post("/parts/:id/refresh", requireEntitlement, async (c) => {
  const userId = c.get("userId");
  const old = await c.env.DB.prepare(
    `SELECT p.id, p.vehicle_id, p.kind, p.name, p.size, p.installed_on, p.retired_on,
            p.cost_cents, p.expected_hours, p.wear_limit, p.notes,
            EXISTS (SELECT 1 FROM part_mounts m WHERE m.part_id = p.id AND m.removed_on IS NULL) AS equipped
     FROM parts p JOIN vehicles v ON v.id = p.vehicle_id
     WHERE p.id = ? AND v.user_id = ?`
  )
    .bind(c.req.param("id"), userId)
    .first<{
      id: number;
      vehicle_id: number;
      kind: string;
      name: string;
      size: string | null;
      equipped: number;
      installed_on: string;
      retired_on: string | null;
      cost_cents: number | null;
      expected_hours: number | null;
      wear_limit: number | null;
      notes: string | null;
    }>();
  if (!old) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<any>().catch(() => ({}));
  if ("equipped" in body && typeof body.equipped !== "boolean") return c.json({ error: "invalid equipped" }, 400);
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

  let size = old.size;
  if ("size" in body) {
    if (body.size != null && typeof body.size !== "string") return c.json({ error: "invalid size" }, 400);
    size = typeof body.size === "string" ? body.size.trim() || null : null;
    if (size && size.length > 40) return c.json({ error: "invalid size" }, 400);
  }

  // Retiring closes the old part's mount and the insert mounts the successor
  // (both by trigger, migration 0029). A fresh set of a spare that was on the
  // shelf is itself a spare, so its mount goes again. A retired part has
  // nothing left to retire or inherit: the successor's place is the body's.
  const onCar = old.retired_on ? body.equipped !== false : Boolean(old.equipped);
  // Only a set going on the car went on at a point in the day; a spare's
  // fresh set goes to the shelf.
  const swap = onCar ? await swapPoint(c.env.DB, userId, old.vehicle_id, swapDate, body) : { point: null };
  if ("error" in swap) return c.json({ error: swap.error }, 400);
  const { point } = swap;
  if (!old.retired_on) {
    await c.env.DB.prepare("UPDATE parts SET retired_on = ? WHERE id = ?").bind(swapDate, old.id).run();
    // The retire trigger closed the mount on the swap date; the point says
    // where in that day it came off.
    if (point && old.equipped)
      await c.env.DB.prepare(
        `UPDATE part_mounts SET removed_event_id = ?1, removed_after_session_id = ?2 WHERE id = (
           SELECT id FROM part_mounts WHERE part_id = ?3 AND removed_on = ?4 ORDER BY mounted_on DESC, id DESC LIMIT 1)`
      )
        .bind(point.event, point.after, old.id, swapDate)
        .run();
  } else if (onCar && body.swap === true)
    await swapOffStmt(c.env.DB, old.vehicle_id, old.kind, null, swapDate, point).run();
  const expected =
    (await retiredLifecycleAvg(c.env.DB, userId, old.vehicle_id, old.kind)) ?? old.expected_hours;
  const row = await c.env.DB.prepare(
    `INSERT INTO parts (vehicle_id, kind, name, size, installed_on, cost_cents, expected_hours, wear_limit, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(old.vehicle_id, old.kind, name, size, swapDate, cost, expected, old.wear_limit, old.notes)
    .first<{ id: number }>();
  if (!onCar) await c.env.DB.prepare("DELETE FROM part_mounts WHERE part_id = ?").bind(row!.id).run();
  else if (point)
    await c.env.DB.prepare("UPDATE part_mounts SET mounted_event_id = ?, mounted_after_session_id = ? WHERE part_id = ?")
      .bind(point.event, point.after, row!.id)
      .run();
  return c.json({ id: row!.id, retired_id: old.id }, 201);
});

// Where inside a day a swap sits (migration 0030). A swap on a date one of
// this car's events covers happens at a point in that event: after the last of
// its sessions logged so far — the swap is being recorded now, so what's been
// driven ran on the old part — or at its start when none is. A body can name
// the point instead: `after_session_id` a session of that event, or null for its
// start. A date no event covers has no point and keeps the date rule. Two
// events covering one date go to the later start, then the higher id — the
// rule swapSessionEvent in public/js/garage.js shares.
type SwapPoint = { event: number; after: number | null } | null;
async function swapPoint(
  db: D1Database,
  userId: number,
  vehicleId: number,
  on: string,
  body: any
): Promise<{ error: string } | { point: SwapPoint }> {
  const explicit = body != null && "after_session_id" in body;
  if (explicit && body.after_session_id !== null && !Number.isInteger(body.after_session_id))
    return { error: "invalid after_session_id" };
  const event = await db
    .prepare(
      `SELECT e.id,
         (SELECT s.id FROM sessions s WHERE s.event_id = e.id ORDER BY s.sort DESC, s.id DESC LIMIT 1) AS last_session,
         (SELECT s.id FROM sessions s WHERE s.event_id = e.id AND s.id = ?4) AS named_session
       FROM events e
       WHERE e.user_id = ?1 AND e.vehicle_id = ?2 AND e.start_date <= ?3
         AND date(e.start_date, '+' || (MAX(1, CAST(e.days AS INTEGER) + (e.days > CAST(e.days AS INTEGER))) - 1) || ' days') >= ?3
       ORDER BY e.start_date DESC, e.id DESC LIMIT 1`
    )
    .bind(userId, vehicleId, on, explicit ? body.after_session_id : null)
    .first<{ id: number; last_session: number | null; named_session: number | null }>();
  if (!event) return explicit && body.after_session_id !== null ? { error: "after_session_id is not on that date" } : { point: null };
  if (!explicit) return { point: { event: event.id, after: event.last_session } };
  if (body.after_session_id === null) return { point: { event: event.id, after: null } };
  if (event.named_session == null) return { error: "after_session_id is not on that date" };
  return { point: { event: event.id, after: event.named_session } };
}

// Close the open mount of every equipped, unretired part on the vehicle that
// shares a place with `kind` (equipSwapKinds) — what equipping a part takes
// off. Never before a mount began, so a back-dated equip can't invert one. A
// swap point given is where in the day they came off (migration 0030).
const swapOffStmt = (
  db: D1Database,
  vehicleId: number,
  kind: string,
  exceptId: number | null,
  on: string,
  point: SwapPoint = null
) => {
  const kinds = equipSwapKinds(kind);
  if (!kinds.length) return db.prepare("SELECT 1 WHERE 0");
  return db
    .prepare(
      `UPDATE part_mounts SET removed_on = MAX(mounted_on, ?1), removed_event_id = ?4, removed_after_session_id = ?5
       WHERE removed_on IS NULL AND part_id IN (
         SELECT id FROM parts WHERE vehicle_id = ?2 AND retired_on IS NULL AND id IS NOT ?3
           AND kind IN (${kinds.map((_, i) => `?${i + 6}`).join(", ")}))
       RETURNING part_id`
    )
    .bind(on, vehicleId, exceptId, point?.event ?? null, point?.after ?? null, ...kinds);
};

// A part with its mounts, for the equip routes' checks.
async function ownedPartMounts(db: D1Database, userId: number, id: string) {
  const [partRes, mountRes] = await db.batch([
    db
      .prepare(
        `SELECT p.id, p.vehicle_id, p.kind, p.installed_on, p.retired_on
         FROM parts p JOIN vehicles v ON v.id = p.vehicle_id WHERE p.id = ? AND v.user_id = ?`
      )
      .bind(id, userId),
    db
      .prepare(
        `SELECT m.id, ${MOUNT_COLUMNS} FROM part_mounts m
         JOIN parts p ON p.id = m.part_id JOIN vehicles v ON v.id = p.vehicle_id
         WHERE m.part_id = ? AND v.user_id = ? ORDER BY m.mounted_on ASC, m.id ASC`
      )
      .bind(id, userId),
  ]);
  const part = partRes.results[0] as
    | { id: number; vehicle_id: number; kind: string; installed_on: string; retired_on: string | null }
    | undefined;
  return part ? { part, mounts: mountRes.results as (Mount & { id: number })[] } : null;
}

// The equip switch (migration 0029): put a part that's on the shelf back on
// the car as of `on` (default today), taking off whatever shares its place —
// the other set of tires, the other pads — as of the same day. Swapped parts
// go to the shelf, not to retirement: their wear stops and resumes when they
// go back on. Answers the ids it took off so a client can say so.
vehicles.post("/parts/:id/equip", requireEntitlement, async (c) => {
  const db = c.env.DB;
  const found = await ownedPartMounts(db, c.get("userId"), c.req.param("id"));
  if (!found) return c.json({ error: "not found" }, 404);
  const { part, mounts } = found;
  if (part.retired_on) return c.json({ error: "part is retired" }, 400);
  if (mounts.some((m) => m.removed_on == null)) return c.json({ error: "part is already equipped" }, 400);
  const body = await c.req.json<any>().catch(() => ({}));
  const on = body.on ?? todayISO();
  // Not before it was installed, and not back inside a stretch it was already on.
  const lastOff = mounts.reduce((max, m) => (m.removed_on! > max ? m.removed_on! : max), part.installed_on);
  if (!isValidDate(on) || on < lastOff) return c.json({ error: "invalid on" }, 400);
  const swap = await swapPoint(db, c.get("userId"), part.vehicle_id, on, body);
  if ("error" in swap) return c.json({ error: swap.error }, 400);
  const { point } = swap;
  const [swapped] = await db.batch([
    swapOffStmt(db, part.vehicle_id, part.kind, part.id, on, point),
    db
      .prepare(
        "INSERT INTO part_mounts (part_id, mounted_on, mounted_event_id, mounted_after_session_id) VALUES (?, ?, ?, ?)"
      )
      .bind(part.id, on, point?.event ?? null, point?.after ?? null),
  ]);
  const unequipped = (swapped.results as { part_id: number }[]).map((r) => r.part_id);
  return c.json({ ok: true, unequipped });
});

// Take a part off the car as of `on` (default today) without retiring it: it
// goes to the shelf and its wear stops until it's equipped again.
vehicles.post("/parts/:id/unequip", requireEntitlement, async (c) => {
  const db = c.env.DB;
  const found = await ownedPartMounts(db, c.get("userId"), c.req.param("id"));
  if (!found) return c.json({ error: "not found" }, 404);
  const open = found.mounts.find((m) => m.removed_on == null);
  if (found.part.retired_on || !open) return c.json({ error: "part is not equipped" }, 400);
  const body = await c.req.json<any>().catch(() => ({}));
  const on = body.on ?? todayISO();
  if (!isValidDate(on) || on < open.mounted_on) return c.json({ error: "invalid on" }, 400);
  const swap = await swapPoint(db, c.get("userId"), found.part.vehicle_id, on, body);
  if ("error" in swap) return c.json({ error: swap.error }, 400);
  await db
    .prepare(
      `UPDATE part_mounts SET removed_on = ?, removed_event_id = ?, removed_after_session_id = ?
       WHERE part_id = ? AND removed_on IS NULL`
    )
    .bind(on, swap.point?.event ?? null, swap.point?.after ?? null, found.part.id)
    .run();
  return c.json({ ok: true });
});

// When a part went on the car, edited after the fact (migration 0030): moves
// the start of its latest mount to `mounted_on` (default: where it is) at the
// point in that day `after_session_id` names — a session of the car's event
// that day, or null for its start; left out, after the last session logged,
// as a swap recorded now would be. Whatever came off the car when this part
// went on — a part sharing its place whose mount ended at exactly the old
// point — moves with it, so the two never overlap or leave a gap. A part that
// went on the car the day it was installed moves its install date with it; one
// bought as a spare and fitted later keeps its install date as a floor.
vehicles.put("/parts/:id/mount", requireEntitlement, async (c) => {
  const db = c.env.DB;
  const userId = c.get("userId");
  const found = await ownedPartMounts(db, userId, c.req.param("id"));
  if (!found) return c.json({ error: "not found" }, 404);
  const { part, mounts } = found;
  const latest = mounts[mounts.length - 1];
  if (!latest) return c.json({ error: "part has never been on the car" }, 400);
  const prev = mounts[mounts.length - 2];
  const body = await c.req.json<any>().catch(() => ({}));
  const on = body.mounted_on ?? latest.mounted_on;
  const fittedAtInstall = mounts.length === 1 && latest.mounted_on === part.installed_on;
  if (
    !isValidDate(on) ||
    on > todayISO() ||
    (prev && on < prev.removed_on!) ||
    (latest.removed_on != null && on > latest.removed_on) ||
    (!fittedAtInstall && on < part.installed_on) ||
    (part.retired_on != null && on > part.retired_on)
  )
    return c.json({ error: "invalid mounted_on" }, 400);
  const swap = await swapPoint(db, userId, part.vehicle_id, on, body);
  if ("error" in swap) return c.json({ error: swap.error }, 400);
  const { point } = swap;

  // What came off when this went on: the same place, ending at the old point.
  const kinds = equipSwapKinds(part.kind);
  const linked = kinds.length
    ? ((
        await db
          .prepare(
            `SELECT m.id, m.part_id FROM part_mounts m JOIN parts p ON p.id = m.part_id
             WHERE p.vehicle_id = ?1 AND p.id <> ?2 AND m.removed_on = ?3
               AND m.removed_event_id IS ?4 AND m.removed_after_session_id IS ?5
               AND p.kind IN (${kinds.map((_, i) => `?${i + 6}`).join(", ")})`
          )
          .bind(
            part.vehicle_id,
            part.id,
            latest.mounted_on,
            latest.mounted_event_id ?? null,
            latest.mounted_after_session_id ?? null,
            ...kinds
          )
          .all()
      ).results as { id: number; part_id: number }[])
    : [];

  // Dates first and points second: a date moving within one multi-day event
  // keeps the same event, and the 0030 triggers would clear a point written in
  // the same statement as its date.
  const writes: D1PreparedStatement[] = [];
  if (fittedAtInstall && on !== part.installed_on)
    writes.push(db.prepare("UPDATE parts SET installed_on = ? WHERE id = ?").bind(on, part.id));
  writes.push(
    db.prepare("UPDATE part_mounts SET mounted_on = ? WHERE id = ?").bind(on, latest.id),
    db
      .prepare("UPDATE part_mounts SET mounted_event_id = ?, mounted_after_session_id = ? WHERE id = ?")
      .bind(point?.event ?? null, point?.after ?? null, latest.id)
  );
  for (const m of linked)
    writes.push(
      db.prepare("UPDATE part_mounts SET removed_on = MAX(mounted_on, ?) WHERE id = ?").bind(on, m.id),
      db
        .prepare("UPDATE part_mounts SET removed_event_id = ?, removed_after_session_id = ? WHERE id = ?")
        .bind(point?.event ?? null, point?.after ?? null, m.id),
      // A part retired by the swap (Refresh) was retired on its date too.
      db
        .prepare("UPDATE parts SET retired_on = ? WHERE id = ? AND retired_on = ?")
        .bind(on, m.part_id, latest.mounted_on)
    );
  await db.batch(writes);
  return c.json({ ok: true, moved: linked.map((m) => m.part_id) });
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
