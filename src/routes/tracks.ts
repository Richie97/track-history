import { Hono } from "hono";
import type { AppContext } from "../types";
import { catalogIdForName, tracksSummary } from "../db";
import { isValidGoal } from "../lib/validate";

export const tracks = new Hono<AppContext>();

tracks.get("/tracks", async (c) => {
  return c.json(await tracksSummary(c.env.DB, c.get("userId")));
});

// The seeded track catalog — backs the track-name suggestions in the event form.
tracks.get("/catalog", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, name FROM track_catalog ORDER BY name").all<{
    id: number;
    name: string;
  }>();
  return c.json(rows.results);
});

tracks.post("/tracks", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const name = body.name?.trim();
  if (!name) return c.json({ error: "name required" }, 400);
  try {
    const row = await c.env.DB.prepare(
      "INSERT INTO tracks (user_id, name, catalog_id) VALUES (?, ?, ?) RETURNING id, name, catalog_id"
    )
      .bind(c.get("userId"), name, await catalogIdForName(c.env.DB, name))
      .first();
    return c.json(row, 201);
  } catch {
    return c.json({ error: "track already exists" }, 409);
  }
});

tracks.put("/tracks/:id", async (c) => {
  const body = await c.req.json<{
    name?: string;
    notes?: string | null;
    goal_ms?: number | null;
  }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return c.json({ error: "name required" }, 400);
    sets.push("name = ?");
    binds.push(name);
    // Renaming can change which canonical track this is — re-match the catalog.
    sets.push("catalog_id = ?");
    binds.push(await catalogIdForName(c.env.DB, name));
  }
  if ("notes" in body) {
    sets.push("notes = ?");
    binds.push(typeof body.notes === "string" && body.notes.trim() ? body.notes : null);
  }
  if ("goal_ms" in body) {
    if (!isValidGoal(body.goal_ms)) return c.json({ error: "invalid goal" }, 400);
    sets.push("goal_ms = ?");
    binds.push(body.goal_ms ?? null);
  }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  binds.push(c.req.param("id"), c.get("userId"));
  try {
    const res = await c.env.DB.prepare(
      `UPDATE tracks SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`
    )
      .bind(...binds)
      .run();
    if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  } catch {
    // UNIQUE(user_id, name) — the new name collides with another track.
    return c.json({ error: "a track with that name already exists" }, 409);
  }
  return c.json({ ok: true });
});

tracks.delete("/tracks/:id", async (c) => {
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
