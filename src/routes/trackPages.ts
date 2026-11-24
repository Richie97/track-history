import { Hono } from "hono";
import type { AppContext } from "../types";
import {
  PUBLIC_TOP_LAPS,
  findBySlug,
  trackNotFoundHtml,
  trackPageHtml,
  tracksIndexHtml,
  tracksSitemap,
  type CatalogTrackRow,
} from "../lib/trackPages";

// The public track pages (#457), mounted at /tracks outside /api — /tracks and
// /tracks/* are in run_worker_first. No session is read: the pages are the
// same for everyone, render without JavaScript, and are what a search for
// "<track> lap times" should find.
//
// What they may say about drivers is lib/trackPages.ts's TrackStats and
// nothing else: a count of opted-in drivers and their best device-timed laps
// as bare times. No name, date, car or lap id is selected here, so none can
// reach a page — keep it that way rather than selecting and dropping.
export const trackPages = new Hono<AppContext>();

const CACHE = "public, max-age=300";

function catalogStmt(db: D1Database) {
  return db.prepare("SELECT id, name, length_m, lat, lon FROM track_catalog ORDER BY name COLLATE NOCASE");
}

// The leaderboard's own rule (routes/tracks.ts): opted-in users, device-timed
// laps only, one best per driver.
const BESTS = `
  FROM tracks t
  JOIN users u ON u.id = t.user_id AND u.leaderboard_opt_in = 1
  JOIN events e ON e.track_id = t.id
  JOIN sessions s ON s.event_id = e.id
  JOIN laps l ON l.session_id = s.id
 WHERE t.catalog_id = ?1 AND l.device_timed = 1`;

trackPages.get("/", async (c) => {
  const rows = await catalogStmt(c.env.DB).all<CatalogTrackRow>();
  return c.html(tracksIndexHtml(rows.results), 200, { "Cache-Control": CACHE });
});

trackPages.get("/sitemap.xml", async (c) => {
  const rows = await catalogStmt(c.env.DB).all<CatalogTrackRow>();
  return c.body(tracksSitemap(rows.results), 200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": CACHE,
  });
});

trackPages.get("/:slug", async (c) => {
  const all = (await catalogStmt(c.env.DB).all<CatalogTrackRow>()).results;
  const track = findBySlug(all, c.req.param("slug"));
  if (!track) return c.html(trackNotFoundHtml(), 404, { "X-Robots-Tag": "noindex" });

  const [bests, count] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT MIN(l.time_ms) AS best_ms ${BESTS} GROUP BY t.user_id ORDER BY best_ms ASC LIMIT ${PUBLIC_TOP_LAPS}`
    ).bind(track.id),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT t.user_id) AS n ${BESTS}`).bind(track.id),
  ]);
  const stats = {
    drivers: (count.results[0] as { n: number } | undefined)?.n ?? 0,
    best_ms: (bests.results as Array<{ best_ms: number }>).map((r) => r.best_ms),
  };
  return c.html(trackPageHtml(track, stats, all), 200, { "Cache-Control": CACHE });
});
