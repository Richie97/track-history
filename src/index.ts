import { Hono } from "hono";
import type { AppContext } from "./types";
import { requireSession } from "./middleware";
import { auth } from "./routes/auth";
import { me } from "./routes/me";
import { tracks } from "./routes/tracks";
import { events } from "./routes/events";
import { sessions } from "./routes/sessions";
import { share, publicShare } from "./routes/share";

export type { Env, AppContext } from "./types";

// Everything under /api requires a session cookie.
const api = new Hono<AppContext>();
api.use("*", requireSession);
for (const routes of [me, tracks, events, sessions, share]) {
  api.route("/", routes);
}

const app = new Hono<AppContext>();

app.route("/auth", auth);
// Registered before the authed /api router so GET /api/share/:slug stays public;
// PUT/DELETE /api/share (no slug) fall through to the authed router below.
app.route("/api/share", publicShare);
app.route("/api", api);

export default app;
