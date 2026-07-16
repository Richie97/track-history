import { Hono } from "hono";
import type { AppContext } from "./types";
import { requireSession } from "./middleware";
import { appCors } from "./lib/cors";
import { auth } from "./routes/auth";
import { me } from "./routes/me";
import { tracks } from "./routes/tracks";
import { events } from "./routes/events";
import { sessions } from "./routes/sessions";
import { share, publicShare } from "./routes/share";
import { wellKnown } from "./routes/wellKnown";

export type { Env, AppContext } from "./types";

// Everything under /api requires a session cookie.
const api = new Hono<AppContext>();
api.use("*", requireSession);
for (const routes of [me, tracks, events, sessions, share]) {
  api.route("/", routes);
}

const app = new Hono<AppContext>();

// CORS for the native apps' Capacitor WebView origins (see lib/cors.ts);
// same-origin web traffic is untouched.
app.use("/api/*", appCors);
app.use("/auth/*", appCors);

app.route("/auth", auth);
app.route("/.well-known", wellKnown);
// Registered before the authed /api router so GET /api/share/:slug stays public;
// PUT/DELETE /api/share (no slug) fall through to the authed router below.
app.route("/api/share", publicShare);
app.route("/api", api);

export default app;
