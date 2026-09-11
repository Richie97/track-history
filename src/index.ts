import { Hono } from "hono";
import type { AppContext, Env } from "./types";
import { requireSession } from "./middleware";
import { auth } from "./routes/auth";
import { me } from "./routes/me";
import { tracks } from "./routes/tracks";
import { events } from "./routes/events";
import { sessions } from "./routes/sessions";
import { vehicles } from "./routes/vehicles";
import { share, publicShare, sharePage } from "./routes/share";
import { wellKnown } from "./routes/wellKnown";
import { billing } from "./routes/billing";
import { billingWebhooks } from "./routes/billingWebhooks";
import { reverifyExpiring } from "./cron";

export type { Env, AppContext } from "./types";

// Everything under /api requires a session cookie.
const api = new Hono<AppContext>();
api.use("*", requireSession);
for (const routes of [me, tracks, events, sessions, vehicles, share, billing]) {
  api.route("/", routes);
}

const app = new Hono<AppContext>();

app.route("/auth", auth);
// Store webhooks: public, sender-verified, outside /api (see run_worker_first).
app.route("/", billingWebhooks);
app.route("/.well-known", wellKnown);
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
  },
} satisfies ExportedHandler<Env>;
