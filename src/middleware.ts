import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppContext } from "./types";
import { SESSION_COOKIE, bearerToken, sessionUser } from "./lib/session";
import { isEntitled } from "./lib/entitlement";

// Resolves the session to a userId or rejects with 401. The session token
// arrives either as the same-origin cookie (web) or as an Authorization:
// Bearer header (the native apps, which call cross-origin) — both point at
// the same auth_sessions rows. The user's entitlement rides along in the
// same statement (see sessionUser).
export const requireSession = createMiddleware<AppContext>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization")) || getCookie(c, SESSION_COOKIE);
  if (token) {
    const user = await sessionUser(c.env.DB, token);
    if (user) {
      c.set("userId", user.userId);
      c.set("entitledUntil", user.entitledUntil);
      return next();
    }
  }
  return c.json({ error: "unauthorized" }, 401);
});

// The Pro gate: a pure comparison against what requireSession already loaded,
// so it issues no D1 statement. 402 with the one error string every client
// maps to its paywall (NS-32 rule 5).
//
// Wired to NO route yet — phase D turns it on for GET /garage, the
// parts/measurements routes and the setups routes, and nothing else. It must
// never sit in front of a POST/PUT/DELETE on events, sessions, laps or tracks:
// the offline layer drops rejected writes, and a recording made under Pro and
// replayed after a lapse would be deleted.
export const requireEntitlement = createMiddleware<AppContext>(async (c, next) => {
  if (!isEntitled(c.get("entitledUntil"), Date.now())) return c.json({ error: "pro required" }, 402);
  return next();
});
