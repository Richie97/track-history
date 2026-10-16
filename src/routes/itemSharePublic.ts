import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { apiApp } from "../api";
import type { AppContext, Ctx } from "../types";
import { isEntitled } from "../lib/entitlement";
import { signClipUrl } from "../lib/clips";
import { SHARE_TOKEN, type ShareKind, shareKindFor, sharePath, sharedEvent, sharedSummary } from "../lib/itemShare";
import { escHtml, fmtMsShare, setMeta } from "./share";

// Share one event or one session (NS-48) — the public half: no session, the
// token in the path is the whole of the permission.
//
//   GET /api/share/(e|s)/:token                    the shared item
//   GET /api/share/(e|s)/:token/clips/:clipId/url  a URL to play its best-lap video
//   GET /share/(e|s)/:token                        the page, with per-item OG meta
//
// The item is read *as its owner* through a private copy of the /api router,
// the way the MCP tools read (src/ai/tools.ts): GET /events/:id answers with
// the owner's ownership scoping and the owner's Pro strip, and
// lib/itemShare.ts narrows that to what a link may carry. Every refusal is a
// 404 that says nothing about whether the item exists. `no-store` throughout,
// so "Stop sharing" takes effect on the next load rather than after a cache.

type Owner = { userId: number; entitledUntil: number | null };
const callers = new WeakMap<Request, Owner>();
const ownerApi = apiApp(
  createMiddleware<AppContext>(async (c, next) => {
    const owner = callers.get(c.req.raw);
    if (!owner) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", owner.userId);
    c.set("entitledUntil", owner.entitledUntil);
    return next();
  })
);

type ShareRow = {
  user_id: number;
  event_id: number;
  session_id: number | null;
  name: string | null;
  entitled_until: number | null;
};

// The shared item, as the link shows it — or null for a token that doesn't
// resolve (unknown, revoked, the wrong kind for its prefix, or deleted).
async function resolve(c: Ctx, prefix: string, token: string) {
  const kind = shareKindFor(prefix);
  if (!kind || !SHARE_TOKEN.test(token)) return null;
  const row = await c.env.DB.prepare(
    `SELECT s.user_id, s.event_id, s.session_id, u.name, u.entitled_until
       FROM item_shares s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`
  )
    .bind(token)
    .first<ShareRow>();
  if (!row || (kind === "session") !== (row.session_id != null)) return null;

  const req = new Request(`https://internal/events/${row.event_id}`);
  callers.set(req, { userId: row.user_id, entitledUntil: row.entitled_until });
  const res = await ownerApi.fetch(req, c.env);
  if (!res.ok) return null;
  const entitled = isEntitled(row.entitled_until, Date.now());
  const event = sharedEvent(await res.json(), row.session_id, entitled);
  if (!event) return null;
  return { kind, row, entitled, event };
}

export const itemSharePublic = new Hono<AppContext>();

itemSharePublic.get("/:prefix{[es]}/:token", async (c) => {
  c.header("Cache-Control", "no-store");
  const item = await resolve(c, c.req.param("prefix"), c.req.param("token"));
  if (!item) return c.json({ error: "not found" }, 404);
  return c.json({
    kind: item.kind,
    name: item.row.name,
    // The owner's tier: what the telemetry panel opens to, as `ent()` is the
    // student's under a coach's view.
    pro: item.entitled,
    session_id: item.row.session_id,
    event: item.event,
  });
});

// A best-lap video in the shared item: signed exactly as the owner's own
// GET /clips/:id/url signs it, for a clip that is on a lap the link shows.
// The view already nulls every clip while the owner isn't Pro, so a free
// owner's clip is simply not there to ask for.
itemSharePublic.get("/:prefix{[es]}/:token/clips/:clipId/url", async (c) => {
  c.header("Cache-Control", "no-store");
  const item = await resolve(c, c.req.param("prefix"), c.req.param("token"));
  const clipId = Number(c.req.param("clipId"));
  const shown = item?.event.sessions.some((s: any) => s.laps.some((l: any) => l.clip?.id === clipId));
  if (!item || !shown) return c.json({ error: "not found" }, 404);
  const secret = c.env.CLIP_URL_SECRET;
  if (!secret || !c.env.CLIPS) return c.json({ error: "video storage isn't configured" }, 503);
  return c.json(await signClipUrl(secret, new URL(c.req.url).origin, clipId, Date.now()));
});

// The page: index.html with the item's own title and description, because
// link scrapers never run JS. Built only from what the API above publishes.
export const itemSharePage = new Hono<AppContext>();

const titleFor = (kind: ShareKind, name: string | null, track: string) =>
  kind === "event" ? `${name ?? "A driver"}'s track day at ${track}` : `${name ?? "A driver"}'s session at ${track}`;

itemSharePage.get("/:prefix{[es]}/:token", async (c) => {
  const shellRes = await c.env.ASSETS.fetch(new URL("/index.html", c.req.url));
  let html = await shellRes.text();
  const item = await resolve(c, c.req.param("prefix"), c.req.param("token"));
  if (item) {
    const title = titleFor(item.kind, item.row.name, item.event.track_name);
    const description = `${sharedSummary(item.event, fmtMsShare)} — lap times, racing line and telemetry on Track Evolution.`;
    const url = new URL(sharePath(item.kind, c.req.param("token")), c.req.url).toString();
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${escHtml(title)}</title>`)
      .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${escHtml(url)}$2`);
    html = setMeta(html, "name", "description", description);
    html = setMeta(html, "property", "og:title", title);
    html = setMeta(html, "property", "og:description", description);
    html = setMeta(html, "property", "og:image:alt", title);
  }
  return c.html(html, 200, { "Cache-Control": "no-store" });
});
