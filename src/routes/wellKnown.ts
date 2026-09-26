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

// OpenAI Apps domain verification for the MCP server (listing the connector
// in ChatGPT). The token comes from OpenAI's developer console and is set with
// `npx wrangler secret put OPENAI_APPS_CHALLENGE`; unset, the route is a 404,
// so a fork without a listing answers as if the file didn't exist.
wellKnown.get("/openai-apps-challenge", (c) => {
  const token = c.env.OPENAI_APPS_CHALLENGE?.trim();
  if (!token) return c.text("not found", 404);
  return c.text(token, 200, { "Cache-Control": "no-store" });
});
