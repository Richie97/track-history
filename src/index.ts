import { Hono } from "hono";
import { auth } from "./auth";
import { api, publicShare } from "./api";

export type Env = {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  DEV_MODE?: string;
  DEV_USER_EMAIL?: string;
  DEV_USER_NAME?: string;
};

export type AppContext = { Bindings: Env; Variables: { userId: number } };

const app = new Hono<AppContext>();

app.route("/auth", auth);
// Registered before the authed /api router so GET /api/share/:slug stays public;
// PUT/DELETE /api/share (no slug) fall through to the authed router below.
app.route("/api/share", publicShare);
app.route("/api", api);

export default app;
