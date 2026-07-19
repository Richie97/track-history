import { Hono } from "hono";
import type { AppContext } from "../types";
import { EVENT_SELECT, tracksSummary, userTotals } from "../db";
import { type EventRow, withComputed } from "../lib/stats";
import { isValidSlug } from "../lib/validate";

// Authed share-link management (mounted behind the session middleware).
export const share = new Hono<AppContext>();

share.put("/share", async (c) => {
  const body = await c.req.json<{ slug?: string }>();
  const slug = (body.slug ?? "").trim().toLowerCase();
  if (!isValidSlug(slug)) {
    return c.json(
      { error: "path must be 3-32 letters, numbers or hyphens (can't start or end with a hyphen)" },
      400
    );
  }
  try {
    await c.env.DB.prepare("UPDATE users SET share_slug = ? WHERE id = ?")
      .bind(slug, c.get("userId"))
      .run();
  } catch {
    return c.json({ error: "that path is already taken" }, 409);
  }
  return c.json({ slug });
});

share.delete("/share", async (c) => {
  await c.env.DB.prepare("UPDATE users SET share_slug = NULL WHERE id = ?")
    .bind(c.get("userId"))
    .run();
  return c.json({ ok: true });
});

// Public read-only share endpoint. Mounted at /api/share WITHOUT the auth
// middleware (see index.ts). Backs the /share/<slug> pages: stats, times and
// event metadata only — notes, email and per-lap data stay private.
export const publicShare = new Hono<AppContext>();

publicShare.get("/:slug", async (c) => {
  const slug = c.req.param("slug").toLowerCase();
  const owner = await c.env.DB.prepare("SELECT id, name FROM users WHERE share_slug = ?")
    .bind(slug)
    .first<{ id: number; name: string | null }>();
  if (!owner) return c.json({ error: "not found" }, 404);

  const [totals, tracks, eventRows] = await Promise.all([
    userTotals(c.env.DB, owner.id),
    tracksSummary(c.env.DB, owner.id),
    c.env.DB.prepare(`${EVENT_SELECT} WHERE e.user_id = ? ORDER BY e.start_date DESC`)
      .bind(owner.id)
      .all<EventRow>(),
  ]);
  // Strip private fields: event notes and prep checklists, per-track course
  // notes, and the garage linkage (setup sheets and parts are exactly the
  // data racers don't share — they live behind auth only).
  const events = eventRows.results
    .map(withComputed)
    .map(({ notes, checklist, vehicle_id, track_hours, ...pub }) => pub);
  const publicTracks = tracks.map(({ notes, ...pub }) => pub);
  return c.json({ name: owner.name, totals, tracks: publicTracks, events });
});
