import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { apiApp } from "../api";
import type { AppContext, Ctx } from "../types";
import { isEntitled } from "../lib/entitlement";
import { signClipUrl } from "../lib/clips";
import {
  SHARE_TOKEN,
  type ShareKind,
  shareKindFor,
  shareKindOfRow,
  sharePath,
  sharedEvent,
  sharedLap,
  sharedSummary,
} from "../lib/itemShare";
import { escHtml, fmtMsShare, setMeta, setPageUrl } from "./share";

// Share one event or one session (NS-48), one lap or two laps compared
// (NS-56) — the public half: no session, the token in the path is the whole
// of the permission.
//
//   GET /api/share/(e|s|l|c)/:token                    the shared item
//   GET /api/share/(e|s|l|c)/:token/clips/:clipId/url  a URL to play a video on it
//   GET /share/(e|s|l|c)/:token                        the page, with per-item OG meta
//
// An event, a session and a lap answer { kind, name, pro, session_id, lap_id,
// event }; a comparison answers { kind, name, pro, a, b }, each side
// { session_id, lap_id, event } — a lap share's `event`, one per side, so the
// two laps may come from different days and nothing else of either does.
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
  lap_id: number | null;
  lap_b_id: number | null;
  name: string | null;
  entitled_until: number | null;
};

type Json = Record<string, any>;
type Side = { session_id: number; lap_id: number; event: Json };

// GET /events/:id as the item's owner reads it, or null.
async function ownerEvent(c: Ctx, row: ShareRow, eventId: number): Promise<unknown | null> {
  const req = new Request(`https://internal/events/${eventId}`);
  callers.set(req, { userId: row.user_id, entitledUntil: row.entitled_until });
  const res = await ownerApi.fetch(req, c.env);
  return res.ok ? await res.json() : null;
}

// One lap as a link shows it: where it sits (scoped to the share's owner),
// then its event read and cut down to it.
async function lapSide(c: Ctx, row: ShareRow, lapId: number, entitled: boolean): Promise<Side | null> {
  const at = await c.env.DB.prepare(
    `SELECT l.session_id, s.event_id FROM laps l
       JOIN sessions s ON s.id = l.session_id JOIN events e ON e.id = s.event_id
      WHERE l.id = ? AND e.user_id = ?`
  )
    .bind(lapId, row.user_id)
    .first<{ session_id: number; event_id: number }>();
  if (!at) return null;
  const detail = await ownerEvent(c, row, at.event_id);
  const event = detail ? sharedLap(detail, at.session_id, lapId, entitled) : null;
  return event ? { session_id: at.session_id, lap_id: lapId, event } : null;
}

type Item = { kind: ShareKind; row: ShareRow; entitled: boolean; event: Json; sides: Side[] | null };

// The shared item, as the link shows it — or null for a token that doesn't
// resolve (unknown, revoked, the wrong kind for its prefix, or deleted).
// `event` is the item's own, and for a comparison side A's (the link
// preview's); `sides` is set for a comparison only.
async function resolve(c: Ctx, prefix: string, token: string): Promise<Item | null> {
  const kind = shareKindFor(prefix);
  if (!kind || !SHARE_TOKEN.test(token)) return null;
  const row = await c.env.DB.prepare(
    `SELECT s.user_id, s.event_id, s.session_id, s.lap_id, s.lap_b_id, u.name, u.entitled_until
       FROM item_shares s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`
  )
    .bind(token)
    .first<ShareRow>();
  if (!row || shareKindOfRow(row) !== kind) return null;
  const entitled = isEntitled(row.entitled_until, Date.now());

  if (kind === "lap" || kind === "compare") {
    const a = await lapSide(c, row, row.lap_id!, entitled);
    if (!a) return null;
    if (kind === "lap") return { kind, row, entitled, event: a.event, sides: null };
    const b = await lapSide(c, row, row.lap_b_id!, entitled);
    if (!b) return null;
    return { kind, row, entitled, event: a.event, sides: [a, b] };
  }

  const detail = await ownerEvent(c, row, row.event_id);
  const event = detail ? sharedEvent(detail, row.session_id, entitled) : null;
  if (!event) return null;
  return { kind, row, entitled, event, sides: null };
}

const KIND = "/:prefix{[eslc]}/:token";

export const itemSharePublic = new Hono<AppContext>();

itemSharePublic.get(KIND, async (c) => {
  c.header("Cache-Control", "no-store");
  const item = await resolve(c, c.req.param("prefix"), c.req.param("token"));
  if (!item) return c.json({ error: "not found" }, 404);
  // `pro` is the owner's tier: what the telemetry panel opens to, as `ent()`
  // is the student's under a coach's view.
  const head = { kind: item.kind, name: item.row.name, pro: item.entitled };
  if (item.sides) return c.json({ ...head, a: item.sides[0], b: item.sides[1] });
  return c.json({ ...head, session_id: item.row.session_id, lap_id: item.row.lap_id, event: item.event });
});

// A best-lap video in the shared item: signed exactly as the owner's own
// GET /clips/:id/url signs it, for a clip that is on a lap the link shows.
// The view already nulls every clip while the owner isn't Pro, so a free
// owner's clip is simply not there to ask for.
itemSharePublic.get(`${KIND}/clips/:clipId/url`, async (c) => {
  c.header("Cache-Control", "no-store");
  const item = await resolve(c, c.req.param("prefix"), c.req.param("token"));
  const clipId = Number(c.req.param("clipId"));
  const shown = (item?.sides?.map((s) => s.event) ?? (item ? [item.event] : [])).some((e) =>
    e.sessions.some((s: any) => s.laps.some((l: any) => l.clip?.id === clipId))
  );
  if (!item || !shown) return c.json({ error: "not found" }, 404);
  const secret = c.env.CLIP_URL_SECRET;
  if (!secret || !c.env.CLIPS) return c.json({ error: "video storage isn't configured" }, 503);
  return c.json(await signClipUrl(secret, new URL(c.req.url).origin, clipId, Date.now()));
});

// The page: index.html with the item's own title and description, because
// link scrapers never run JS. Built only from what the API above publishes.
export const itemSharePage = new Hono<AppContext>();

const TITLE_NOUN: Record<ShareKind, string> = { event: "track day", session: "session", lap: "lap", compare: "lap comparison" };
const titleFor = (kind: ShareKind, name: string | null, track: string) =>
  `${name ?? "A driver"}'s ${TITLE_NOUN[kind]} at ${track}`;

// "Sat, Oct 4, 2026 · best 2:01.24 · 18 laps" for a day or a session; a lap
// is its own time, and a comparison both.
function descriptionFor(item: Item): string {
  const tail = "on Track Evolution.";
  if (item.sides) {
    const [a, b] = item.sides.map((s) => fmtMsShare(s.event.best_ms));
    return `${a} against ${b} — the time delta, sectors and telemetry side by side ${tail}`;
  }
  if (item.kind === "lap")
    return `${fmtMsShare(item.event.best_ms)} · ${sharedSummary({ ...item.event, best_ms: null, lap_count: 0 }, fmtMsShare)} — lap time, racing line and telemetry ${tail}`;
  return `${sharedSummary(item.event, fmtMsShare)} — lap times, racing line and telemetry ${tail}`;
}

itemSharePage.get(KIND, async (c) => {
  const shellRes = await c.env.ASSETS.fetch(new URL("/index.html", c.req.url));
  let html = await shellRes.text();
  const item = await resolve(c, c.req.param("prefix"), c.req.param("token"));
  if (item) {
    const title = titleFor(item.kind, item.row.name, item.event.track_name);
    const description = descriptionFor(item);
    const url = new URL(sharePath(item.kind, c.req.param("token")), c.req.url).toString();
    html = setPageUrl(html.replace(/<title>[^<]*<\/title>/, `<title>${escHtml(title)}</title>`), url);
    html = setMeta(html, "name", "description", description);
    html = setMeta(html, "property", "og:title", title);
    html = setMeta(html, "property", "og:description", description);
    html = setMeta(html, "property", "og:image:alt", title);
  }
  // An unlisted link: whoever holds it may read it, and a search engine that
  // comes across one must not list it.
  return c.html(html, 200, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
});
