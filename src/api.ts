import { Hono, type MiddlewareHandler } from "hono";
import type { AppContext } from "./types";
import { me } from "./routes/me";
import { tracks } from "./routes/tracks";
import { events } from "./routes/events";
import { sessions } from "./routes/sessions";
import { vehicles } from "./routes/vehicles";
import { carCatalog } from "./routes/carCatalog";
import { share } from "./routes/share";
import { wrapped } from "./routes/wrapped";
import { billing } from "./routes/billing";

// The authed /api surface, built around whichever middleware says who the
// caller is. index.ts mounts it behind requireSession; the MCP tools
// (src/ai/tools.ts) build a second, private copy behind a middleware that
// takes the user from the request object itself, so a tool reads exactly
// what the API would answer — the same ownership scoping, the same Pro strip,
// the same leaderboard rules — rather than a second implementation of them.
export function apiApp(auth: MiddlewareHandler<AppContext>) {
  const api = new Hono<AppContext>();
  api.use("*", auth);
  for (const routes of [me, tracks, events, sessions, vehicles, carCatalog, share, wrapped, billing]) {
    api.route("/", routes);
  }
  return api;
}
