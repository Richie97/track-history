import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { withinLimit } from "../../src/lib/ratelimit";
import { mcpClient, mcpTokenFor, signedInProUser } from "./helpers";

// The MCP rate limits (src/lib/ratelimit.ts), on the real bindings declared in
// wrangler.jsonc: a limit is per key, so each test uses its own connection,
// client or IP and can't be disturbed by another's traffic.

describe("rate limits", () => {
  it("limits tool calls per connection, not per user", async () => {
    const user = await signedInProUser();
    const busy = await mcpTokenFor(user.id);
    const other = await mcpTokenFor(user.id);
    const mcp = mcpClient(busy.token);
    for (let i = 0; i < 60; i++) expect((await mcp("ping")).status).toBe(200);
    const limited = await mcp("ping");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect((await mcpClient(other.token)("ping")).status).toBe(200);
  });

  it("limits token requests per client", async () => {
    const clientId = `rl-client-${crypto.randomUUID()}`;
    const post = () =>
      SELF.fetch("https://example.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "nope", client_id: clientId }),
      });
    for (let i = 0; i < 10; i++) expect((await post()).status).toBe(400);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as any).error).toBe("rate_limited");
  });

  it("limits registrations per IP", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
    const register = () =>
      SELF.fetch("https://example.com/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify({ redirect_uris: ["https://assistant.example/callback"] }),
      });
    for (let i = 0; i < 60; i++) expect((await register()).status).toBe(201);
    expect((await register()).status).toBe(429);
  });

  it("never limits without a binding or a key", async () => {
    expect(await withinLimit(undefined, "k")).toBe(true);
    expect(await withinLimit(env.MCP_CALLS, null)).toBe(true);
  });
});
