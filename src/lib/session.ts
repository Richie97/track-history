// Auth-session cookie plumbing shared by the auth routes and API middleware.

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_COOKIE = "session";

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createSession(db: D1Database, userId: number): Promise<string> {
  const token = randomToken();
  await db
    .prepare("INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, userId, Date.now() + SESSION_TTL_MS)
    .run();
  return token;
}

export async function sessionUserId(db: D1Database, token: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT user_id FROM auth_sessions WHERE token = ? AND expires_at > ?")
    .bind(token, Date.now())
    .first<{ user_id: number }>();
  return row ? row.user_id : null;
}

export function sessionCookieOptions(url: string) {
  return {
    httpOnly: true,
    secure: new URL(url).protocol === "https:",
    sameSite: "Lax" as const,
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  };
}
