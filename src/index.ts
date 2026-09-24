import { Hono } from "hono";
import type { AppContext, Env } from "./types";
import { requireSession } from "./middleware";
import { auth } from "./routes/auth";
import { apiApp } from "./api";
import { publicShare, sharePage } from "./routes/share";
import { wellKnown } from "./routes/wellKnown";
import { billingWebhooks } from "./routes/billingWebhooks";
import { oauth, oauthWellKnown, sweepOAuth } from "./routes/oauth";
import { mcp } from "./routes/mcp";
import { reverifyExpiring } from "./cron";

export type { Env, AppContext } from "./types";

// Everything under /api requires a session cookie (or the native apps'
// bearer token — see requireSession).
const api = apiApp(requireSession);

const app = new Hono<AppContext>();

app.route("/auth", auth);
// Store webhooks: public, sender-verified, outside /api (see run_worker_first).
app.route("/", billingWebhooks);
app.route("/.well-known", wellKnown);
// The MCP server (routes/mcp.ts) and the OAuth authorization server its
// clients sign in through (routes/oauth.ts, plus its discovery documents under
// /.well-known). Outside /api on purpose: their tokens are not app sessions
// and must not open /api (migration 0028).
app.route("/.well-known", oauthWellKnown);
app.route("/oauth", oauth);
app.route("/mcp", mcp);
// The share *page* (HTML with per-slug OG meta for link scrapers) — /share/*
// is in run_worker_first (wrangler.jsonc) so these requests reach the Worker.
app.route("/share", sharePage);
// Registered before the authed /api router so GET /api/share/:slug stays public;
// PUT/DELETE /api/share (no slug) fall through to the authed router below.
app.route("/api/share", publicShare);
app.route("/api", api);

export default {
  fetch: app.fetch,
  // Daily subscription re-verification (wrangler.jsonc triggers.crons).
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(reverifyExpiring(env, Date.now()));
    // Expired MCP codes and tokens, and clients nobody connected (routes/oauth.ts).
    ctx.waitUntil(sweepOAuth(env.DB, Date.now()));
  },
} satisfies ExportedHandler<Env>;
