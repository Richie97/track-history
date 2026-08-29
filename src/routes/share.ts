import { Hono } from "hono";
import type { AppContext } from "../types";
import {
  type TrackRow,
  eventSelect,
  summarizeTracks,
  trackRowsStmt,
  tracksSummary,
  userTotalsStmt,
} from "../db";
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

// --- the share *page* -------------------------------------------------------
// GET /share/:slug is in wrangler.jsonc's run_worker_first so it reaches the
// Worker instead of the SPA asset fallback: link scrapers (iMessage, Slack,
// social cards) never run JS, so the OG meta has to be in the HTML itself.
// The route serves the real index.html (via the ASSETS binding) with the
// generic tags swapped for per-slug ones — same shell, so the app boots for
// human visitors exactly as before. Only already-public share data is used:
// the owner's name and the same aggregates GET /api/share/:slug returns.

const escHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

// Mirrors fmtMs in public/js/format.js — "2:01.24", trailing zeros trimmed.
function fmtMsShare(ms: number): string {
  const total = Math.round(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  let frac = String(total % 1000).padStart(3, "0").replace(/0+$/, "");
  if (!frac) frac = "0";
  return `${m}:${String(s).padStart(2, "0")}.${frac}`;
}

// Swap one meta tag's content attribute. The shell is our own file, so a
// miss means index.html changed shape — the tag is left as-is rather than
// breaking the page.
function setMeta(html: string, attr: "name" | "property", key: string, value: string): string {
  const re = new RegExp(`(<meta ${attr}="${key}" content=")[^"]*(")`);
  return html.replace(re, `$1${escHtml(value)}$2`);
}

export const sharePage = new Hono<AppContext>();

sharePage.get("/:slug", async (c) => {
  const shellRes = await c.env.ASSETS.fetch(new URL("/index.html", c.req.url));
  let html = await shellRes.text();

  const slug = c.req.param("slug").toLowerCase();
  const owner = await c.env.DB.prepare("SELECT id, name FROM users WHERE share_slug = ?")
    .bind(slug)
    .first<{ id: number; name: string | null }>();

  if (owner) {
    const [totalsRow, tracks] = await Promise.all([
      userTotalsStmt(c.env.DB, owner.id).first<{ events: number; track_days: number }>(),
      tracksSummary(c.env.DB, owner.id),
    ]);
    const totals = totalsRow ?? { events: 0, track_days: 0 };
    const title = `${owner.name ?? "A driver"}'s track logbook`;
    const bestBits = tracks
      .filter((t) => t.best_ms != null)
      .sort((a, b) => (b.event_count ?? 0) - (a.event_count ?? 0))
      .slice(0, 2)
      .map((t) => `${t.name} ${fmtMsShare(t.best_ms as number)}`);
    const description = [
      `${totals.events} event${totals.events === 1 ? "" : "s"}`,
      `${totals.track_days} track day${totals.track_days === 1 ? "" : "s"}`,
      ...bestBits,
    ].join(" · ") + " — lap times and progress on Track Evolution.";

    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${escHtml(title)}</title>`)
      .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${escHtml(new URL(`/share/${slug}`, c.req.url).toString())}$2`);
    html = setMeta(html, "name", "description", description);
    html = setMeta(html, "property", "og:title", title);
    html = setMeta(html, "property", "og:description", description);
    html = setMeta(html, "property", "og:image:alt", `${title} on Track Evolution`);
  }

  // Unknown slugs still get the stock shell: the SPA renders its own
  // not-found, and the response stays cacheable either way.
  return c.html(html, 200, { "Cache-Control": "public, max-age=300" });
});

// Deeper paths under /share/ aren't real routes; hand back the stock shell so
// the SPA can deal with them, same as the asset fallback would have.
sharePage.get("/*", async (c) => {
  const shellRes = await c.env.ASSETS.fetch(new URL("/index.html", c.req.url));
  return c.html(await shellRes.text(), 200);
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

  // One batched round trip, and the event aggregation runs once: the track
  // summaries are computed from the same event rows the page lists, instead
  // of a second aggregate query inside tracksSummary.
  const [totalsRes, tracksRes, eventsRes] = await c.env.DB.batch([
    userTotalsStmt(c.env.DB, owner.id),
    trackRowsStmt(c.env.DB, owner.id),
    c.env.DB.prepare(eventSelect("WHERE e.user_id = ?", "ORDER BY e.start_date DESC")).bind(owner.id),
  ]);
  const allEvents = (eventsRes.results as EventRow[]).map(withComputed);
  // summarizeTracks wants past events in ascending date order — same UTC-today
  // cutoff as the SQL date('now') the totals query uses.
  const today = new Date().toISOString().slice(0, 10);
  const pastAsc = allEvents
    .filter((e) => e.start_date <= today)
    .sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : a.id - b.id));
  const tracks = summarizeTracks(tracksRes.results as TrackRow[], pastAsc);
  // Strip private fields: event notes and prep checklists, per-track course
  // notes, and the garage linkage (setup sheets and parts are exactly the
  // data racers don't share — they live behind auth only).
  const events = allEvents.map(({ notes, checklist, vehicle_id, track_hours, ...pub }) => pub);
  const publicTracks = tracks.map(({ notes, ...pub }) => pub);
  return c.json({ name: owner.name, totals: totalsRes.results[0], tracks: publicTracks, events });
});
