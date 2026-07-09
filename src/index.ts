import { Hono } from "hono";
import { auth } from "./auth";
import { api } from "./api";

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
app.route("/api", api);

export default app;
