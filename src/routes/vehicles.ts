import { Hono } from "hono";
import type { AppContext } from "../types";

// The user's garage (Settings → Vehicles). Vehicles feed the event form's
// car field; the one marked is_default pre-fills new events.

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
