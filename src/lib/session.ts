// Auth-session cookie plumbing shared by the auth routes and API middleware.

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_COOKIE = "session";

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Hex SHA-256. Session tokens and one-time auth codes are stored hashed
// (migration 0014) so a leaked database copy doesn't contain usable
// credentials — only the client ever holds the plaintext token.
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createSession(db: D1Database, userId: number): Promise<string> {
  const token = randomToken();
  await db
    .prepare("INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), userId, Date.now() + SESSION_TTL_MS)
    .run();
  return token;
}

export type SessionUser = { userId: number; entitledUntil: number | null };

// Resolves a session token to its user — and the user's entitlement, in the
// same single statement. requireEntitlement (middleware.ts) is then a pure
// comparison, so a Pro gate costs no D1 round trip on top of the session.
export async function sessionUser(db: D1Database, token: string): Promise<SessionUser | null> {
  const row = await db
    .prepare(
      "SELECT s.user_id, u.entitled_until FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?"
    )
    .bind(await sha256Hex(token), Date.now())
    .first<{ user_id: number; entitled_until: number | null }>();
  return row ? { userId: row.user_id, entitledUntil: row.entitled_until ?? null } : null;
}

// Extracts the token from an "Authorization: Bearer <token>" header value.
export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

// PKCE S256: base64url(SHA-256(input)) with no padding.
export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = String.fromCharCode(...new Uint8Array(digest));
  return btoa(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
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
