import { Hono } from "hono";
import type { AppContext } from "../types";

export const wellKnown = new Hono<AppContext>();

// iOS Universal Links: lets https://<host>/share/* links open the native app.
// Served by the Worker (not static assets) because the file is extensionless
// and Apple requires Content-Type: application/json. The app ID is
// <TeamID>.<bundle id>; set IOS_APP_ID in wrangler.jsonc vars once the Apple
// Developer Team ID exists — the placeholder default keeps the route harmless
// until then. (The Android equivalent, assetlinks.json, is a plain static
// file in public/.well-known/.)
wellKnown.get("/apple-app-site-association", (c) => {
  const appId = c.env.IOS_APP_ID || "TEAMID.app.trackevolution";
  return c.json({
    applinks: {
      details: [{ appIDs: [appId], components: [{ "/": "/share/*" }] }],
    },
  });
});
