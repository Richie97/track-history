import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppContext } from "../types";
import { SESSION_COOKIE } from "../lib/session";
import { LANDING_HTML } from "../landing.generated";

// GET / — the brand's own front door.
//
// A visitor with no session cookie gets the landing page (the docs site's
// site/index.html, re-pointed for this host by tools/landing.mjs): a search
// engine, an AI assistant or someone who has never heard of the app reads what
// it is, where the bare app shell would show them a sign-in button. Anyone
// carrying a session cookie gets the app shell exactly as before.
//
// The cookie's *presence* decides, not its validity: no D1 read on the most
// requested path, and a stale cookie just lands on the shell, whose own
// sign-in screen takes over. The app shell stays reachable without a cookie at
// any path the Worker doesn't claim — the landing page links /login.
export async function home(c: Context<AppContext>) {
  // Shared caches must never hand one visitor's answer to the other kind.
  const headers = { "Cache-Control": "private, no-cache", Vary: "Cookie" };
  if (!getCookie(c, SESSION_COOKIE)) {
    // X-TE-Page tells the service worker this is not the shell (public/sw.js).
    return c.html(LANDING_HTML, 200, { ...headers, "X-TE-Page": "landing" });
  }
  const shell = await c.env.ASSETS.fetch(new URL("/index.html", c.req.url));
  return c.html(await shell.text(), 200, headers);
}
