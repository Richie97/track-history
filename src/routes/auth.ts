import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppContext, Ctx } from "../types";
import { decodeIdTokenPayload, type IdTokenPayload } from "../lib/oidc";
import {
  SESSION_COOKIE,
  bearerToken,
  createSession,
  randomToken,
  sessionCookieOptions,
  sha256Base64Url,
} from "../lib/session";

export const auth = new Hono<AppContext>();

// Native-app OAuth: the app opens /auth/login?client=app&code_challenge=…
// in the system browser (Google forbids OAuth in embedded webviews); after
// the Google callback we mint a single-use code and bounce to the app's
// custom scheme, which the app exchanges for a bearer token at /auth/exchange.
const APP_REDIRECT_URI = "trackevolution://auth";
const AUTH_CODE_TTL_MS = 60 * 1000;
const APP_STATE_SUFFIX = ".app";
const CHALLENGE_COOKIE = "oauth_challenge";

async function createAuthCode(
  db: D1Database,
  userId: number,
  codeChallenge: string
): Promise<string> {
  const code = randomToken();
  await db
    .prepare("INSERT INTO auth_codes (code, user_id, code_challenge, expires_at) VALUES (?, ?, ?, ?)")
    .bind(code, userId, codeChallenge, Date.now() + AUTH_CODE_TTL_MS)
    .run();
  return code;
}

// Shared tail of the non-Google sign-ins (dev bypass, review demo): hand the
// native app a one-time PKCE code, or set the web session cookie.
async function completeLogin(
  c: Ctx,
  userId: number,
  isApp: boolean,
  appChallenge: string | undefined
) {
  if (isApp) {
    const code = await createAuthCode(c.env.DB, userId, appChallenge!);
    return c.redirect(`${APP_REDIRECT_URI}?code=${code}`);
  }
  const token = await createSession(c.env.DB, userId);
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c.req.url));
  return c.redirect("/");
}

async function findOrCreateUserByEmail(
  db: D1Database,
  email: string,
  name: string
): Promise<number> {
  const existing = await db
    .prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: number }>();
  if (existing) return existing.id;
  const created = await db
    .prepare("INSERT INTO users (email, name) VALUES (?, ?) RETURNING id")
    .bind(email, name)
    .first<{ id: number }>();
  return created!.id;
}

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
  const isApp = c.req.query("client") === "app";
  const appChallenge = c.req.query("code_challenge");
  if (isApp && !appChallenge) return c.text("Missing code_challenge.", 400);

  // App Store / Play review bypass: a secret demo code (set via
  // `wrangler secret put REVIEW_DEMO_SECRET`, handed to the reviewer in App
  // Review Information) signs into a shared demo account without Google.
  // Disabled entirely when the secret isn't set. The demo user is a plain
  // users row, so ownership scoping isolates it like any other account; its
  // email should be one the operator controls, since a Google sign-in with
  // that email would claim the row (upsertGoogleUser's pre-seeded path).
  const demoCode = c.req.query("demo_code");
  if (demoCode) {
    const secret = c.env.REVIEW_DEMO_SECRET;
    // Compare hashes, not strings — string equality would leak the secret
    // byte-by-byte through response timing.
    const ok =
      !!secret && (await sha256Base64Url(demoCode)) === (await sha256Base64Url(secret));
    if (!ok) return c.text("Invalid demo access code.", 401);
    const userId = await findOrCreateUserByEmail(
      c.env.DB,
      c.env.REVIEW_DEMO_EMAIL || "demo@trackevolution.app",
      c.env.REVIEW_DEMO_NAME || "Demo Driver"
    );
    return completeLogin(c, userId, isApp, appChallenge);
  }

  // Local development bypass: sign in as a fixed dev user without Google.
  // Set DEV_USER_EMAIL in .dev.vars to match your seeded account.
  if (c.env.DEV_MODE === "1") {
    const userId = await findOrCreateUserByEmail(
      c.env.DB,
      c.env.DEV_USER_EMAIL || "dev@example.com",
      c.env.DEV_USER_NAME || "Dev User"
    );
    return completeLogin(c, userId, isApp, appChallenge);
  }

  // The app's PKCE challenge rides in a short-lived cookie (the system
  // browser holds our cookies), and the client type in a state suffix so the
  // callback knows to hand back a code instead of a session cookie.
  const state = randomToken() + (isApp ? APP_STATE_SUFFIX : "");
  const shortLivedCookie = {
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: 600,
  };
  setCookie(c, "oauth_state", state, shortLivedCookie);
  if (isApp) setCookie(c, CHALLENGE_COOKIE, appChallenge!, shortLivedCookie);
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
  const appChallenge = getCookie(c, CHALLENGE_COOKIE);
  deleteCookie(c, "oauth_state", { path: "/" });
  deleteCookie(c, CHALLENGE_COOKIE, { path: "/" });
  if (!code || !state || state !== savedState) {
    return c.text("Invalid OAuth state. Please try signing in again.", 400);
  }
  const isApp = state.endsWith(APP_STATE_SUFFIX);
  if (isApp && !appChallenge) {
    return c.text("Missing PKCE challenge. Please try signing in again.", 400);
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
  return completeLogin(c, userId, isApp, appChallenge);
});

// Native app: trade a one-time code (from the custom-scheme redirect) plus
// the PKCE verifier for a bearer session token.
auth.post("/exchange", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    code?: string;
    code_verifier?: string;
  } | null;
  if (!body?.code || !body?.code_verifier) {
    return c.json({ error: "code and code_verifier are required" }, 400);
  }
  const row = await c.env.DB.prepare(
    "SELECT user_id, code_challenge, expires_at FROM auth_codes WHERE code = ?"
  )
    .bind(body.code)
    .first<{ user_id: number; code_challenge: string; expires_at: number }>();
  if (row) {
    // Single-use: burn the code before verifying so a failed attempt can't retry it.
    await c.env.DB.prepare("DELETE FROM auth_codes WHERE code = ?").bind(body.code).run();
  }
  if (!row || row.expires_at <= Date.now()) {
    return c.json({ error: "invalid or expired code" }, 401);
  }
  if ((await sha256Base64Url(body.code_verifier)) !== row.code_challenge) {
    return c.json({ error: "PKCE verification failed" }, 401);
  }
  const token = await createSession(c.env.DB, row.user_id);
  return c.json({ token });
});

auth.post("/logout", async (c) => {
  const token =
    bearerToken(c.req.header("Authorization")) || getCookie(c, SESSION_COOKIE);
  if (token) {
    await c.env.DB.prepare("DELETE FROM auth_sessions WHERE token = ?").bind(token).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
