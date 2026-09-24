// POST /mcp — the MCP endpoint (#317), Streamable HTTP, stateless and JSON
// only (the transport lets a server answer a POST with application/json
// instead of opening an event stream, and nothing here streams). The protocol
// is src/ai/mcp.ts; this file is the HTTP around it: the bearer token from
// routes/oauth.ts, the 401 that starts a client's OAuth discovery, the
// protocol-version header and CORS.
//
// Pro is checked per tool call (ai/mcp.ts), not here, so a lapsed subscriber's
// assistant is told why in words rather than seeing the connection break.

import { Hono } from "hono";
import type { AppContext } from "../types";
import { bearerToken } from "../lib/session";
import { RATE_LIMIT_RETRY_AFTER_S, withinLimit } from "../lib/ratelimit";
import { protectedResourceMetadataUrl } from "../lib/oauth";
import { PARSE_ERROR, PROTOCOL_VERSIONS, handleMessage } from "../ai/mcp";
import { bearerCors, oauthTokenUser } from "./oauth";

export const mcp = new Hono<AppContext>();

// How often a connection's last_used_at is written: Settings shows it to the
// day, so one write an hour is plenty and most calls cost no extra statement.
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_BATCH = 20;

mcp.use("*", bearerCors);

mcp.post("/", async (c) => {
  const origin = new URL(c.req.url).origin;
  const unauthorized = (error?: string) => {
    const params = [`resource_metadata="${protectedResourceMetadataUrl(origin)}"`, `scope="read"`];
    if (error) params.unshift(`error="${error}"`);
    c.header("WWW-Authenticate", `Bearer ${params.join(", ")}`);
    return c.json({ error: "unauthorized" }, 401);
  };
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) return unauthorized();
  const user = await oauthTokenUser(c.env.DB, token);
  if (!user) return unauthorized("invalid_token");

  if (!(await withinLimit(c.env.MCP_CALLS, `grant:${user.grantId}`))) {
    c.header("Retry-After", String(RATE_LIMIT_RETRY_AFTER_S));
    return c.json({ error: "rate limited — too many requests from this connection; wait a minute" }, 429);
  }

  const now = Date.now();
  if (user.lastUsedAt == null || now - user.lastUsedAt > LAST_USED_RESOLUTION_MS) {
    const write = c.env.DB.prepare("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?").bind(now, user.grantId).run();
    try {
      c.executionCtx.waitUntil(write);
    } catch {
      await write; // no execution context (tests calling app.fetch directly)
    }
  }

  // The client repeats the negotiated version on every request after
  // initialize. One this server never offered is a client bug worth a 400.
  const headerVersion = c.req.header("MCP-Protocol-Version") ?? null;
  if (headerVersion && !PROTOCOL_VERSIONS.includes(headerVersion))
    return c.json({ error: `unsupported MCP-Protocol-Version ${headerVersion}` }, 400);

  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return c.json({ error: "request too large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "parse error" } }, 400);
  }

  const toolUser = { userId: user.userId, entitledUntil: user.entitledUntil };
  // Batches were in the 2025-03-26 transport and dropped after; accepting one
  // costs nothing and keeps older clients working.
  if (Array.isArray(body)) {
    if (!body.length || body.length > MAX_BATCH) return c.json({ error: "invalid batch" }, 400);
    const replies = (await Promise.all(body.map((m) => handleMessage(c.env, toolUser, m, headerVersion)))).filter(
      (r) => r !== null
    );
    return replies.length ? c.json(replies) : c.body(null, 202);
  }
  const reply = await handleMessage(c.env, toolUser, body, headerVersion);
  return reply ? c.json(reply) : c.body(null, 202);
});

// No server-initiated stream and no session to end: say so, as the transport
// asks a server that offers neither to.
mcp.on(["GET", "DELETE"], "/", (c) => {
  c.header("Allow", "POST");
  return c.json({ error: "method not allowed" }, 405);
});
