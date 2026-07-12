import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppContext } from "../types";
import { decodeIdTokenPayload, type IdTokenPayload } from "../lib/oidc";
import {
  SESSION_COOKIE,
  createSession,
  randomToken,
  sessionCookieOptions,
} from "../lib/session";

export const auth = new Hono<AppContext>();

// Find the user for a Google identity: an existing google_sub match, a
// pre-seeded account claimed by email, or a freshly created account.
async function upsertGoogleUser(db: D1Database, payload: IdTokenPayload): Promise<number> {
  const existing = await db
    .prepare("SELECT id FROM users WHERE google_sub = ?")
    .bind(payload.sub)
    .first<{ id: number }>();
  if (existing) {
    await db
      .prepare("UPDATE users SET name = ?, picture = ?, email = ? WHERE id = ?")
      .bind(payload.name ?? null, payload.picture ?? null, payload.email, existing.id)
      .run();
    return existing.id;
  }
  const preseeded = await db
    .prepare("SELECT id FROM users WHERE email = ? AND google_sub IS NULL")
    .bind(payload.email)
    .first<{ id: number }>();
  if (preseeded) {
    await db
      .prepare("UPDATE users SET google_sub = ?, name = ?, picture = ? WHERE id = ?")
      .bind(payload.sub, payload.name ?? null, payload.picture ?? null, preseeded.id)
      .run();
    return preseeded.id;
  }
  const created = await db
    .prepare("INSERT INTO users (google_sub, email, name, picture) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(payload.sub, payload.email, payload.name ?? null, payload.picture ?? null)
    .first<{ id: number }>();
  return created!.id;
}

auth.get("/login", async (c) => {
  // Local development bypass: sign in as a fixed dev user without Google.
  // Set DEV_USER_EMAIL in .dev.vars to match your seeded account.
  if (c.env.DEV_MODE === "1") {
    const devEmail = c.env.DEV_USER_EMAIL || "dev@example.com";
    let user = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind(devEmail)
      .first<{ id: number }>();
    if (!user) {
      const res = await c.env.DB.prepare(
        "INSERT INTO users (email, name) VALUES (?, ?) RETURNING id"
      )
        .bind(devEmail, c.env.DEV_USER_NAME || "Dev User")
        .first<{ id: number }>();
      user = res!;
    }
    const token = await createSession(c.env.DB, user.id);
    setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c.req.url));
    return c.redirect("/");
  }

  const state = randomToken();
  setCookie(c, "oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  const redirectUri = new URL("/auth/callback", c.req.url).toString();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return c.redirect(url.toString());
});

auth.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const savedState = getCookie(c, "oauth_state");
  deleteCookie(c, "oauth_state", { path: "/" });
  if (!code || !state || state !== savedState) {
    return c.text("Invalid OAuth state. Please try signing in again.", 400);
  }

  const redirectUri = new URL("/auth/callback", c.req.url).toString();
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    return c.text("Failed to exchange authorization code.", 502);
  }
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) return c.text("No id_token in Google response.", 502);

  // The id_token comes directly from Google's token endpoint over TLS,
  // so decoding its payload without signature verification is safe here (per OIDC spec 3.1.3.7).
  const payload = decodeIdTokenPayload(tokens.id_token);
  const userId = await upsertGoogleUser(c.env.DB, payload);

  const token = await createSession(c.env.DB, userId);
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c.req.url));
  return c.redirect("/");
});

auth.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await c.env.DB.prepare("DELETE FROM auth_sessions WHERE token = ?").bind(token).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
