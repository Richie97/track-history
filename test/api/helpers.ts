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
export function apiClient(token?: string) {
  return async (method: string, path: string, body?: unknown): Promise<ApiResponse> => {
    const res = await SELF.fetch(`https://example.com/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Cookie: `session=${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
}

// A fresh user with a live session, plus a bound client.
export async function signedInUser() {
  const user = await createUser();
  const token = await sessionFor(user.id);
  return { ...user, token, api: apiClient(token) };
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
