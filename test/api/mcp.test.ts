import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION, PRO_REQUIRED_MESSAGE } from "../../src/ai/mcp";
import { TOOLS } from "../../src/ai/tools";
import { apiClient, createEvent, mcpClient, mcpTokenFor, sessionFor, signedInProUser, signedInUser } from "./helpers";

// POST /mcp (#317): the transport, the auth boundary and the Pro check. The
// tools themselves are test/api/ai-tools.test.ts; the OAuth flow that mints
// these tokens is test/api/oauth.test.ts — here tokens are minted in D1.

async function proWithToken() {
  const user = await signedInProUser();
  const { token, grantId } = await mcpTokenFor(user.id);
  return { user, token, grantId, mcp: mcpClient(token) };
}

describe("authentication", () => {
  it("answers 401 with the discovery pointer when there is no token", async () => {
    const res = await mcpClient()("initialize", {});
    expect(res.status).toBe(401);
    const header = res.headers.get("WWW-Authenticate")!;
    expect(header).toMatch(/^Bearer /);
    expect(header).toContain('resource_metadata="https://example.com/.well-known/oauth-protected-resource/mcp"');
    expect(header).not.toContain("error=");
  });

  it("marks an unknown or expired token invalid_token", async () => {
    expect((await mcpClient("te_at_nope")("ping")).headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    const user = await signedInProUser();
    const { token } = await mcpTokenFor(user.id, Date.now() - 1000);
    expect((await mcpClient(token)("ping")).status).toBe(401);
  });

  it("does not accept an app session token — MCP tokens and sessions are different audiences", async () => {
    const user = await signedInProUser();
    expect((await mcpClient(user.token)("ping")).status).toBe(401);
  });

  it("does not accept an MCP token anywhere under /api", async () => {
    const { token } = await proWithToken();
    const res = await SELF.fetch("https://example.com/api/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
    const write = await SELF.fetch("https://example.com/api/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ track_name: "Nope", start_date: "2026-01-01" }),
    });
    expect(write.status).toBe(401);
  });

  it("records when a connection was last used, at most hourly", async () => {
    const { mcp, grantId } = await proWithToken();
    await mcp("ping");
    const first = await env.DB.prepare("SELECT last_used_at FROM oauth_grants WHERE id = ?").bind(grantId).first<{ last_used_at: number }>();
    expect(first!.last_used_at).toBeGreaterThan(Date.now() - 60_000);
    await env.DB.prepare("UPDATE oauth_grants SET last_used_at = 5 WHERE id = ?").bind(grantId).run();
    await mcp("ping");
    const second = await env.DB.prepare("SELECT last_used_at FROM oauth_grants WHERE id = ?").bind(grantId).first<{ last_used_at: number }>();
    expect(second!.last_used_at).toBeGreaterThan(5);
  });
});

describe("the protocol", () => {
  it("initializes, negotiating the version and describing the server", async () => {
    const { mcp } = await proWithToken();
    const res = await mcp("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Mcp-Session-Id")).toBeNull(); // stateless
    expect(res.body.result.protocolVersion).toBe("2025-06-18");
    expect(res.body.result.capabilities).toEqual({ tools: { listChanged: false }, prompts: { listChanged: false } });
    expect(res.body.result.serverInfo.name).toBe("track-evolution");
    expect(res.body.result.instructions).toMatch(/integer milliseconds/);
    const unknown = await mcp("initialize", { protocolVersion: "1999-01-01" });
    expect(unknown.body.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("answers notifications with 202 and no body", async () => {
    const { token } = await proWithToken();
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("lists every tool as read-only", async () => {
    const { mcp } = await proWithToken();
    const res = await mcp("tools/list");
    expect(res.body.result.tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const t of res.body.result.tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("calls a tool, with structuredContent from 2025-06-18 and text only before it", async () => {
    const { mcp, token } = await proWithToken();
    const res = await mcp("tools/call", { name: "get_profile", arguments: {} });
    expect(res.body.result.isError).toBe(false);
    expect(res.body.result.structuredContent.units).toBe("imperial");
    expect(JSON.parse(res.body.result.content[0].text)).toEqual(res.body.result.structuredContent);
    const old = await mcpClient(token, "2025-03-26")("tools/call", { name: "get_profile", arguments: {} });
    expect(old.body.result.structuredContent).toBeUndefined();
    expect(old.body.result.content[0].type).toBe("text");
  });

  it("returns a tool's own failure as an isError result the model can read", async () => {
    const { mcp } = await proWithToken();
    const bad = await mcp("tools/call", { name: "get_event", arguments: { event_id: 999999 } });
    expect(bad.body.result.isError).toBe(true);
    expect(bad.body.result.content[0].text).toMatch(/Not found/);
    const malformed = await mcp("tools/call", { name: "list_events", arguments: { limit: "lots" } });
    expect(malformed.body.result.isError).toBe(true);
    expect(malformed.body.result.content[0].text).toMatch(/"limit" must be a number/);
  });

  it("uses JSON-RPC errors for protocol mistakes", async () => {
    const { mcp, token } = await proWithToken();
    expect((await mcp("resources/list")).body.error.code).toBe(-32601);
    expect((await mcp("tools/call", { name: "drop_tables" })).body.error.code).toBe(-32602);
    const parse = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(parse.status).toBe(400);
    expect(((await parse.json()) as any).error.code).toBe(-32700);
  });

  it("refuses a protocol-version header it never offered", async () => {
    const { token } = await proWithToken();
    const res = await mcpClient(token, "2020-01-01")("ping");
    expect(res.status).toBe(400);
  });

  it("answers a batch", async () => {
    const { token } = await proWithToken();
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]),
    });
    const body = (await res.json()) as any[];
    expect(body.map((r) => r.id)).toEqual([1, 2]);
  });

  it("offers no GET stream and no session to DELETE", async () => {
    const { token } = await proWithToken();
    for (const method of ["GET", "DELETE"]) {
      const res = await SELF.fetch("https://example.com/mcp", { method, headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    }
  });

  it("serves the prompts with their arguments filled in", async () => {
    const { mcp } = await proWithToken();
    const list = await mcp("prompts/list");
    expect(list.body.result.prompts.map((p: any) => p.name)).toEqual(["debrief_session", "compare_to_best", "plan_next_track_day"]);
    expect(list.body.result.prompts[0]).not.toHaveProperty("text");
    const got = await mcp("prompts/get", { name: "debrief_session", arguments: { session_id: "42" } });
    expect(got.body.result.messages[0].content.text).toContain("session 42");
    expect((await mcp("prompts/get", { name: "debrief_session", arguments: {} })).body.error.code).toBe(-32602);
  });
});

describe("Pro", () => {
  it("tells a free account why, per tool call, instead of breaking the connection", async () => {
    const user = await signedInUser();
    const { token } = await mcpTokenFor(user.id);
    const mcp = mcpClient(token);
    expect((await mcp("initialize", { protocolVersion: "2025-06-18" })).status).toBe(200);
    expect((await mcp("tools/list")).body.result.tools.length).toBe(TOOLS.length);
    const call = await mcp("tools/call", { name: "get_profile", arguments: {} });
    expect(call.body.result).toEqual({ content: [{ type: "text", text: PRO_REQUIRED_MESSAGE }], isError: true });
  });

  it("reads the user's data end to end for a Pro account", async () => {
    const { user, mcp } = await proWithToken();
    await createEvent(user.api, { track_name: "Test Ring", start_date: "2026-04-10" });
    const res = await mcp("tools/call", { name: "list_tracks", arguments: {} });
    expect(res.body.result.structuredContent.tracks.map((t: any) => t.name)).toEqual(["Test Ring"]);
  });
});

describe("CORS", () => {
  it("answers a browser-based MCP client's preflight, without credentials", async () => {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "OPTIONS",
      headers: { Origin: "https://inspector.example", "Access-Control-Request-Method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    const unauthorized = await mcpClient()("ping");
    expect(unauthorized.headers.get("Access-Control-Expose-Headers")).toContain("WWW-Authenticate");
  });

  it("still answers no CORS under /api", async () => {
    const user = await signedInUser();
    const token = await sessionFor(user.id);
    const res = await SELF.fetch("https://example.com/api/me", {
      method: "OPTIONS",
      headers: { Origin: "https://inspector.example", "Access-Control-Request-Method": "GET", Cookie: `session=${token}` },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect((await apiClient(token)("GET", "/me")).status).toBe(200);
  });
});
