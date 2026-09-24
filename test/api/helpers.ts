import { env, SELF } from "cloudflare:test";
import { sha256Hex } from "../../src/lib/session";

let userSeq = 0;

// Insert a user directly (bypassing OAuth) and return its id.
export async function createUser(name = "Test User") {
  const email = `user${++userSeq}-${Date.now()}@example.com`;
  const row = await env.DB.prepare("INSERT INTO users (email, name) VALUES (?, ?) RETURNING id")
    .bind(email, name)
    .first<{ id: number }>();
  return { id: row!.id, email };
}

// Insert an auth session for a user and return the cookie token (the DB
// stores its SHA-256 hash, exactly like createSession in src/lib/session.ts).
export async function sessionFor(userId: number, expiresAt = Date.now() + 86_400_000) {
  const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  await env.DB.prepare("INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), userId, expiresAt)
    .run();
  return token;
}

export type ApiResponse = { status: number; body: any; headers: Headers };

// JSON client for /api/* as a given session token (or anonymous).
//
// `origin` exists for the billing tests: the DEV_MODE shortcuts (the login
// bypass, and the extra Apple trust anchor whose private key is committed in
// test/fixtures) answer only on a local dev host, so a test that needs one has
// to arrive on localhost the way wrangler dev does.
export const DEV_ORIGIN = "http://localhost:8787";

export function apiClient(token?: string, origin = "https://example.com") {
  return async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<ApiResponse> => {
    const res = await SELF.fetch(`${origin}/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Cookie: `session=${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
}

// A fresh user with a live session, plus a bound client.
export async function signedInUser(origin?: string) {
  const user = await createUser();
  const token = await sessionFor(user.id);
  return { ...user, token, api: apiClient(token, origin) };
}

// The same, entitled. Pro is a `subscriptions` row like any other — a `legacy`
// one here, because it never expires and needs no store payload, so a test
// about the garage or a setup sheet doesn't have to sign a receipt to get past
// requireEntitlement. `users.entitled_until` follows from the triggers in
// migration 0017, exactly as it would in production.
export async function signedInProUser(origin?: string) {
  const user = await signedInUser(origin);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, provider, product_id, external_id, status, expires_at, auto_renew, environment, created_at, updated_at)
     VALUES (?, 'legacy', 'apple-paid-app', ?, 'legacy', NULL, NULL, 'production', ?, ?)`
  )
    .bind(user.id, `test-legacy-${user.id}-${now}`, now, now)
    .run();
  return user;
}

// Convenience: create an event (find-or-creating its track by name).
export async function createEvent(
  api: ReturnType<typeof apiClient>,
  overrides: Record<string, unknown> = {}
) {
  const res = await api("POST", "/events", {
    track_name: "Test Ring",
    start_date: "2026-05-01",
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`createEvent failed: ${JSON.stringify(res.body)}`);
  return res.body.id as number;
}

// An MCP access token for a user, minted directly in D1 the way sessionFor
// mints an app session: a client, a grant and a hashed access token
// (migration 0028), bypassing the consent page that test/api/oauth.test.ts
// exercises end to end.
export async function mcpTokenFor(userId: number, expiresAt = Date.now() + 3_600_000) {
  const clientId = `test-client-${userId}-${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
    .bind(clientId, "Test Assistant", JSON.stringify(["https://assistant.example/callback"]), Date.now())
    .run();
  const grant = await env.DB.prepare(
    "INSERT INTO oauth_grants (user_id, client_id, scope, created_at) VALUES (?, ?, 'read', ?) RETURNING id"
  )
    .bind(userId, clientId, Date.now())
    .first<{ id: number }>();
  const token = `te_at_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare("INSERT INTO oauth_tokens (token, grant_id, kind, expires_at) VALUES (?, ?, 'access', ?)")
    .bind(await sha256Hex(token), grant!.id, expiresAt)
    .run();
  return { token, grantId: grant!.id, clientId };
}

// JSON-RPC over POST /mcp.
export function mcpClient(token?: string, protocolVersion: string | null = "2025-06-18") {
  let seq = 0;
  return async (method: string, params?: unknown, extraHeaders: Record<string, string> = {}) => {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, ...(params === undefined ? {} : { params }) }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
  };
}
