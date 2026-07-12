import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppContext } from "./types";
import { SESSION_COOKIE, sessionUserId } from "./lib/session";

// Resolves the session cookie to a userId or rejects with 401.
export const requireSession = createMiddleware<AppContext>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const userId = await sessionUserId(c.env.DB, token);
    if (userId != null) {
      c.set("userId", userId);
      return next();
    }
  }
  return c.json({ error: "unauthorized" }, 401);
});
