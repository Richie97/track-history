import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { withinLimit } from "../../src/lib/ratelimit";
import { mcpClient, mcpTokenFor, signedInProUser } from "./helpers";

// The MCP rate limits (src/lib/ratelimit.ts), on the real bindings declared in
// wrangler.jsonc: a limit is per key, so each test uses its own connection,
// client or IP and can't be disturbed by another's traffic.

// The bindings count in fixed windows aligned to the period, so a run that
// straddles a window edge sees the count restart partway — on a slow CI runner
// the 61st call then lands in a fresh window and is allowed. So call until the
// first refusal: it must come after at least `limit` successes and within two
// windows' worth, which a limit that never fires, or fires early, still fails.
async function untilLimited<R extends { status: number }>(call: () => Promise<R>, okStatus: number, limit: number): Promise<R> {
  for (let allowed = 0; allowed <= 2 * limit; allowed++) {
    const res = await call();
    if (res.status === 429) {
      expect(allowed).toBeGreaterThanOrEqual(limit);
      return res;
    }
    expect(res.status).toBe(okStatus);
  }
  throw new Error(`still allowed after ${2 * limit + 1} calls`);
}

describe("rate limits", () => {
  it("limits tool calls per connection, not per user", async () => {
    const user = await signedInProUser();
    const busy = await mcpTokenFor(user.id);
    const other = await mcpTokenFor(user.id);
    const mcp = mcpClient(busy.token);
    const limited = await untilLimited(() => mcp("ping"), 200, 60);
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
    const limited = await untilLimited(post, 400, 10);
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
    await untilLimited(register, 201, 60);
  });

  it("never limits without a binding or a key", async () => {
    expect(await withinLimit(undefined, "k")).toBe(true);
    expect(await withinLimit(env.MCP_CALLS, null)).toBe(true);
  });
});
