import { Hono } from "hono";
import type { AppContext } from "../types";
import { isDevHost } from "../lib/dev";
import { mapsAvailable, signMapToken } from "../lib/maps";
import { RATE_LIMIT_RETRY_AFTER_S, withinLimit } from "../lib/ratelimit";

// GET /api/map-token (NS-53): the MapKit JS token the web's map viewer
// authorises with. Free — the racing line is, and so is where it lies. Not in
// COACH_ROUTES: a coach's browser asks for its own token here, as itself.
//
// 404 without the MapKit secrets, so a deployment that never set them reads as
// a route that isn't there and the viewer keeps to the drawn line.
export const maps = new Hono<AppContext>();

maps.get("/map-token", async (c) => {
  if (!mapsAvailable(c.env)) return c.json({ error: "not found" }, 404);
  if (!(await withinLimit(c.env.MAP_TOKEN, `user:${c.get("userId")}`))) {
    c.header("Retry-After", String(RATE_LIMIT_RETRY_AFTER_S));
    return c.json({ error: "Too many map requests in a row — try again in a minute." }, 429);
  }
  const signed = await signMapToken({
    teamId: c.env.APPLE_TEAM_ID!,
    keyId: c.env.MAPKIT_KEY_ID!,
    privateKeyPem: c.env.MAPKIT_PRIVATE_KEY!,
    // The token works from the page that asked for it and nowhere else.
    origin: isDevHost(c.env, c.req.url) ? null : new URL(c.req.url).origin,
    nowMs: Date.now(),
  });
  c.header("Cache-Control", "no-store");
  return c.json(signed);
});
