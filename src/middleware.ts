import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppContext } from "./types";
import { SESSION_COOKIE, bearerToken, sessionUserId } from "./lib/session";

// Resolves the session to a userId or rejects with 401. The session token
// arrives either as the same-origin cookie (web) or as an Authorization:
// Bearer header (the native apps, which call cross-origin) — both point at
// the same auth_sessions rows.
export const requireSession = createMiddleware<AppContext>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization")) || getCookie(c, SESSION_COOKIE);
  if (token) {
    const userId = await sessionUserId(c.env.DB, token);
    if (userId != null) {
      c.set("userId", userId);
      return next();
    }
  }
  return c.json({ error: "unauthorized" }, 401);
});
