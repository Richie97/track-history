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
