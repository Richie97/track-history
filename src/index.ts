import { Hono } from "hono";
import type { AppContext, Env } from "./types";
import { requireSession } from "./middleware";
import { auth } from "./routes/auth";
import { apiApp } from "./api";
import { publicShare, sharePage } from "./routes/share";
import { wellKnown } from "./routes/wellKnown";
import { download } from "./routes/download";
import { billingWebhooks } from "./routes/billingWebhooks";
import { oauth, oauthWellKnown, sweepOAuth } from "./routes/oauth";
import { mcp } from "./routes/mcp";
import { requireCoachGrant, sweepCoachInvites } from "./routes/coaching";
import { reverifyExpiring } from "./cron";
import { clipFiles, sweepClips } from "./routes/clips";
import { itemSharePage, itemSharePublic } from "./routes/itemSharePublic";
import { youtubeConnect } from "./routes/youtube";
import { sweepYouTube, youtubeQueue } from "./youtube/step";

export type { Env, AppContext } from "./types";

// Everything under /api requires a session cookie (or the native apps'
// bearer token — see requireSession).
const api = apiApp(requireSession);
// A coach's read-only view of a student's logbook (NS-38): the same router
// again, run as the student behind requireCoachGrant — GET only, on the
// allow-list in lib/coaching.ts.
const studentApi = apiApp(requireCoachGrant);

const app = new Hono<AppContext>();

app.route("/auth", auth);
// Store webhooks: public, sender-verified, outside /api (see run_worker_first).
app.route("/", billingWebhooks);
app.route("/.well-known", wellKnown);
// "Download the app": a phone goes to its store, anything else gets both links.
app.route("/get", download);
// The MCP server (routes/mcp.ts) and the OAuth authorization server its
// clients sign in through (routes/oauth.ts, plus its discovery documents under
// /.well-known). Outside /api on purpose: their tokens are not app sessions
// and must not open /api (migration 0028).
app.route("/.well-known", oauthWellKnown);
app.route("/oauth", oauth);
app.route("/mcp", mcp);
// The share *page* (HTML with per-slug OG meta for link scrapers) — /share/*
// is in run_worker_first (wrangler.jsonc) so these requests reach the Worker.
// One shared event or session (NS-48), /share/e|s/<token>: ahead of the
// logbook pages, whose catch-all would otherwise answer it.
app.route("/share", itemSharePage);
app.route("/share", sharePage);
// Signed best-lap video URLs (NS-45): the signature is the authorization, so
// no session is consulted — /clips/* is in run_worker_first.
app.route("/clips", clipFiles);
// Connecting YouTube (NS-46): the consent round trip with Google, opened in
// the system browser by the phones — /youtube/* is in run_worker_first.
app.route("/youtube", youtubeConnect);
// Registered before the authed /api router so GET /api/share/:slug stays public;
// PUT/DELETE /api/share (no slug) fall through to the authed router below.
app.route("/api/share", itemSharePublic);
app.route("/api/share", publicShare);
// Registered before /api for the same reason: a request under
// /api/students/:id must meet requireCoachGrant, not requireSession.
app.route("/api/students/:studentId", studentApi);
app.route("/api", api);

export default {
  fetch: app.fetch,
  // Daily subscription re-verification (wrangler.jsonc triggers.crons).
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(reverifyExpiring(env, Date.now()));
    // Expired MCP codes and tokens, and clients nobody connected (routes/oauth.ts).
    ctx.waitUntil(sweepOAuth(env.DB, Date.now()));
    // Expired coach invite links (routes/coaching.ts).
    ctx.waitUntil(sweepCoachInvites(env.DB, Date.now()));
    // Deleted clips' R2 objects and abandoned uploads (routes/clips.ts).
    ctx.waitUntil(sweepClips(env, Date.now()));
    // YouTube (NS-46): revocations, the 30-day re-check, lost queue messages.
    ctx.waitUntil(sweepYouTube(env, Date.now()));
  },
  // The YouTube upload queue and its dead-letter queue (wrangler.jsonc
  // queues.consumers; youtube/step.ts).
  queue(batch: MessageBatch<{ upload_id: number }>, env: Env) {
    return youtubeQueue(batch, env);
  },
} satisfies ExportedHandler<Env, { upload_id: number }>;
