import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppContext, Env } from "../types";
import { decodeIdTokenPayload, isEmailVerified } from "../lib/oidc";
import { APPLE_ISSUER, appleClientSecret, appleUserName } from "../lib/apple";
import {
  SESSION_COOKIE,
  bearerToken,
  createSession,
  randomToken,
  sessionCookieOptions,
  sha256Base64Url,
  sha256Hex,
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
    .bind(await sha256Hex(code), userId, codeChallenge, Date.now() + AUTH_CODE_TTL_MS)
    .run();
  return code;
}

// The DEV_MODE bypass only answers on hosts local development actually uses:
// wrangler dev's loopback addresses plus 10.0.2.2, the Android emulator's
// alias for the host machine. A DEV_MODE=1 that leaks into a deployed
// environment then fails closed — login falls through to real OAuth.
const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "10.0.2.2"]);
const isDevLogin = (env: Env, url: string) =>
  env.DEV_MODE === "1" && DEV_HOSTS.has(new URL(url).hostname);

// Find the user for an OIDC identity: an existing sub match on the provider's
// column, an account claimed by email (pre-seeded rows, and accounts created
// via the *other* provider — same email means same person), or a fresh row.
// Name/picture only ever overwrite when the provider sent one: Apple sends
// the name on the first authorization only, and never a picture.
type OidcIdentity = { sub: string; email: string; name?: string | null; picture?: string | null };

async function upsertOidcUser(
  db: D1Database,
  column: "google_sub" | "apple_sub",
  identity: OidcIdentity
): Promise<number> {
  const existing = await db
    .prepare(`SELECT id FROM users WHERE ${column} = ?`)
    .bind(identity.sub)
    .first<{ id: number }>();
  if (existing) {
    await db
      .prepare(
        "UPDATE users SET email = ?, name = COALESCE(?, name), picture = COALESCE(?, picture) WHERE id = ?"
      )
      .bind(identity.email, identity.name ?? null, identity.picture ?? null, existing.id)
      .run();
    return existing.id;
  }
  const claimable = await db
    .prepare(`SELECT id FROM users WHERE email = ? AND ${column} IS NULL`)
    .bind(identity.email)
    .first<{ id: number }>();
  if (claimable) {
    await db
      .prepare(
        `UPDATE users SET ${column} = ?, name = COALESCE(?, name), picture = COALESCE(?, picture) WHERE id = ?`
      )
      .bind(identity.sub, identity.name ?? null, identity.picture ?? null, claimable.id)
      .run();
    return claimable.id;
  }
  const created = await db
    .prepare(`INSERT INTO users (${column}, email, name, picture) VALUES (?, ?, ?, ?) RETURNING id`)
    .bind(identity.sub, identity.email, identity.name ?? null, identity.picture ?? null)
    .first<{ id: number }>();
  return created!.id;
}

auth.get("/login", async (c) => {
  const isApp = c.req.query("client") === "app";
  const appChallenge = c.req.query("code_challenge");
  if (isApp && !appChallenge) return c.text("Missing code_challenge.", 400);

  // Local development bypass: sign in as a fixed dev user without Google.
  // Set DEV_USER_EMAIL in .dev.vars to match your seeded account.
  if (isDevLogin(c.env, c.req.url)) {
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
    if (isApp) {
      const code = await createAuthCode(c.env.DB, user.id, appChallenge!);
      return c.redirect(`${APP_REDIRECT_URI}?code=${code}`);
    }
    const token = await createSession(c.env.DB, user.id);
    setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c.req.url));
    return c.redirect("/");
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
  // Accounts are claimed/linked by email, so an unverified one can't sign in
  // (see isEmailVerified in lib/oidc.ts for the account-takeover argument).
  if (!isEmailVerified(payload)) {
    return c.text(
      "Your Google account's email address is unverified, so it can't be used to sign in.",
      403
    );
  }
  const userId = await upsertOidcUser(c.env.DB, "google_sub", payload);

  if (isApp) {
    const appCode = await createAuthCode(c.env.DB, userId, appChallenge!);
    return c.redirect(`${APP_REDIRECT_URI}?code=${appCode}`);
  }

  const token = await createSession(c.env.DB, userId);
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c.req.url));
  return c.redirect("/");
});

// ---------- Sign in with Apple ------------------------------------------------
// Same shape as the Google flow with two Apple quirks: the client secret is a
// self-signed ES256 JWT (lib/apple.ts), and requesting the email scope forces
// response_mode=form_post — the callback is a *cross-site POST*, so the state
// and PKCE-challenge cookies must be SameSite=None to arrive with it.

const APPLE_STATE_COOKIE = "apple_oauth_state";
const APPLE_CHALLENGE_COOKIE = "apple_oauth_challenge";

// All four secrets present, or the feature is off (self-hosters may not
// have an Apple developer account — Google remains the baseline provider).
function appleConfig(env: Env) {
  const { APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY } = env;
  if (!APPLE_CLIENT_ID || !APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY) return null;
  return {
    clientId: APPLE_CLIENT_ID,
    teamId: APPLE_TEAM_ID,
    keyId: APPLE_KEY_ID,
    privateKeyPem: APPLE_PRIVATE_KEY,
  };
}

// Which sign-in buttons the (static, server-agnostic) login screen should
// draw. Google is always on; Apple only when this server carries the secrets.
auth.get("/providers", (c) => c.json({ google: true, apple: appleConfig(c.env) !== null }));

auth.get("/apple/login", async (c) => {
  const isApp = c.req.query("client") === "app";
  const appChallenge = c.req.query("code_challenge");
  if (isApp && !appChallenge) return c.text("Missing code_challenge.", 400);
  const config = appleConfig(c.env);
  if (!config) return c.text("Apple sign-in is not configured on this server.", 503);

  const state = randomToken() + (isApp ? APP_STATE_SUFFIX : "");
  const crossSitePostCookie = {
    httpOnly: true,
    secure: true, // required by SameSite=None
    sameSite: "None" as const,
    path: "/",
    maxAge: 600,
  };
  setCookie(c, APPLE_STATE_COOKIE, state, crossSitePostCookie);
  if (isApp) setCookie(c, APPLE_CHALLENGE_COOKIE, appChallenge!, crossSitePostCookie);

  const url = new URL(`${APPLE_ISSUER}/auth/authorize`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", new URL("/auth/apple/callback", c.req.url).toString());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "form_post");
  url.searchParams.set("scope", "name email");
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
});

auth.post("/apple/callback", async (c) => {
  const config = appleConfig(c.env);
  if (!config) return c.text("Apple sign-in is not configured on this server.", 503);
  const body = await c.req.parseBody();
  const savedState = getCookie(c, APPLE_STATE_COOKIE);
  const appChallenge = getCookie(c, APPLE_CHALLENGE_COOKIE);
  deleteCookie(c, APPLE_STATE_COOKIE, { path: "/" });
  deleteCookie(c, APPLE_CHALLENGE_COOKIE, { path: "/" });

  // The user backed out of Apple's consent screen — not an error state.
  if (body.error === "user_cancelled_authorize") return c.redirect("/");

  const code = body.code;
  const state = body.state;
  if (typeof code !== "string" || typeof state !== "string" || !code || state !== savedState) {
    return c.text("Invalid OAuth state. Please try signing in again.", 400);
  }
  const isApp = state.endsWith(APP_STATE_SUFFIX);
  if (isApp && !appChallenge) {
    return c.text("Missing PKCE challenge. Please try signing in again.", 400);
  }

  const tokenRes = await fetch(`${APPLE_ISSUER}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: await appleClientSecret({ ...config, nowMs: Date.now() }),
      redirect_uri: new URL("/auth/apple/callback", c.req.url).toString(),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    return c.text("Failed to exchange authorization code.", 502);
  }
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) return c.text("No id_token in Apple response.", 502);

  // Same trust argument as the Google callback: the id_token came straight
  // from Apple's token endpoint over TLS, so no signature check is needed.
  const payload = decodeIdTokenPayload(tokens.id_token);
  if (!payload.email) {
    return c.text("Apple did not provide an email address for this account.", 502);
  }
  // Same rule as the Google callback — email claiming needs a verified email.
  if (!isEmailVerified(payload)) {
    return c.text(
      "Your Apple ID's email address is unverified, so it can't be used to sign in.",
      403
    );
  }
  const userId = await upsertOidcUser(c.env.DB, "apple_sub", {
    sub: payload.sub,
    email: payload.email,
    name: appleUserName(body.user),
  });

  if (isApp) {
    const appCode = await createAuthCode(c.env.DB, userId, appChallenge!);
    return c.redirect(`${APP_REDIRECT_URI}?code=${appCode}`);
  }

  const token = await createSession(c.env.DB, userId);
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c.req.url));
  return c.redirect("/");
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
  const codeHash = await sha256Hex(body.code);
  const row = await c.env.DB.prepare(
    "SELECT user_id, code_challenge, expires_at FROM auth_codes WHERE code = ?"
  )
    .bind(codeHash)
    .first<{ user_id: number; code_challenge: string; expires_at: number }>();
  if (row) {
    // Single-use: burn the code before verifying so a failed attempt can't retry it.
    await c.env.DB.prepare("DELETE FROM auth_codes WHERE code = ?").bind(codeHash).run();
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
    await c.env.DB.prepare("DELETE FROM auth_sessions WHERE token = ?")
      .bind(await sha256Hex(token))
      .run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
