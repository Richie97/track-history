// The OAuth 2.1 authorization server MCP clients sign in through (#316).
//
// Claude, ChatGPT, Cursor and the rest discover it from /mcp's 401
// (WWW-Authenticate → the protected-resource metadata → the authorization
// server metadata), register themselves (RFC 7591) or identify themselves by a
// client-ID metadata document URL, send the user to /oauth/authorize, and
// trade the code for tokens at /oauth/token with PKCE. The user signs in with
// the same Google / Apple flow as the web app (routes/auth.ts, via `next`) and
// approves on a consent page served here.
//
// Tokens are *not* auth_sessions rows — see migration 0028 for why — so they
// open /mcp and nothing else. Pure rules (redirect matching, metadata
// validation, discovery documents) live in lib/oauth.ts.

import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppContext, Ctx, Env } from "../types";
import { SESSION_COOKIE, randomToken, sessionUser, sha256Base64Url, sha256Hex } from "../lib/session";
import { isEntitled } from "../lib/entitlement";
import {
  ACCESS_TOKEN_TTL_MS,
  OAUTH_CODE_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  SCOPE,
  type ClientRegistration,
  authorizationServerMetadata,
  isMetadataDocumentClientId,
  parseMetadataDocument,
  parseRegistration,
  protectedResourceMetadata,
  redirectMatches,
  redirectWith,
  resourceMatches,
} from "../lib/oauth";
import { appleConfig } from "./auth";

export const oauth = new Hono<AppContext>();
export const oauthWellKnown = new Hono<AppContext>();

const originOf = (url: string) => new URL(url).origin;

// ---------- CORS, for the bearer-token endpoints only -------------------------
//
// The app deliberately answers no CORS (test/api/native-auth.test.ts): /api is
// cookie-authenticated, and a cross-origin read there would carry the user's
// session. These endpoints are different in kind — discovery documents, the
// token endpoint and /mcp authenticate with a bearer token the caller holds in
// its own memory, never an ambient cookie — and browser-based MCP clients (the
// MCP Inspector, web IDEs) cannot reach them without it. `*` without
// credentials is the safe form: a page gets nothing it didn't already hold.
export const bearerCors = createMiddleware<AppContext>(async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  await next();
  c.res.headers.set("Access-Control-Allow-Origin", "*");
  c.res.headers.set("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
});

// ---------- discovery ----------------------------------------------------------

// Per path rather than "*": this router shares /.well-known with the Apple
// app-site association (routes/wellKnown.ts), which gets no CORS.
//
// RFC 9728 lets a client look up the resource's metadata either at the root or
// suffixed with the resource's path; clients try both, so serve both.
for (const path of ["/oauth-protected-resource", "/oauth-protected-resource/mcp"]) {
  oauthWellKnown.use(path, bearerCors);
  oauthWellKnown.get(path, (c) => c.json(protectedResourceMetadata(originOf(c.req.url))));
}
oauthWellKnown.use("/oauth-authorization-server", bearerCors);
oauthWellKnown.get("/oauth-authorization-server", (c) => c.json(authorizationServerMetadata(originOf(c.req.url))));

// ---------- clients -------------------------------------------------------------

type Client = { id: string } & ClientRegistration;

const METADATA_FETCH_TIMEOUT_MS = 5000;
const METADATA_MAX_BYTES = 16 * 1024;

// A client-ID metadata document client: fetched on every authorization, so a
// client that rotates its redirect URIs is picked up, and upserted so grants
// can reference it. A Worker cannot reach a private network, so fetching a
// caller-supplied https URL is not an SSRF foothold here.
async function fetchMetadataClient(db: D1Database, clientId: string): Promise<Client | null> {
  let doc: unknown;
  try {
    const res = await fetch(clientId, {
      headers: { Accept: "application/json" },
      // Not followed: the document must live at the URL that is the id.
      redirect: "manual",
      signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > METADATA_MAX_BYTES) return null;
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = parseMetadataDocument(doc, clientId);
  if (!parsed) return null;
  await db
    .prepare(
      `INSERT INTO oauth_clients (id, name, redirect_uris, metadata_document, created_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris`
    )
    .bind(clientId, parsed.name, JSON.stringify(parsed.redirectUris), Date.now())
    .run();
  return { id: clientId, ...parsed };
}

async function loadClient(db: D1Database, clientId: string | undefined): Promise<Client | null> {
  if (!clientId || clientId.length > 2000) return null;
  if (isMetadataDocumentClientId(clientId)) return fetchMetadataClient(db, clientId);
  const row = await db
    .prepare("SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ? AND metadata_document = 0")
    .bind(clientId)
    .first<{ id: string; name: string | null; redirect_uris: string }>();
  return row ? { id: row.id, name: row.name, redirectUris: JSON.parse(row.redirect_uris) } : null;
}

oauth.use("/register", bearerCors);
oauth.post("/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = parseRegistration(body);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const clientId = `te_client_${randomToken().slice(0, 32)}`;
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
    .bind(clientId, parsed.name, JSON.stringify(parsed.redirectUris), now)
    .run();
  return c.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: parsed.name ?? undefined,
      redirect_uris: parsed.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    },
    201
  );
});

// ---------- the authorization request -----------------------------------------

type AuthorizeRequest = {
  client: Client;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  resource: string | undefined;
};

type Checked =
  | { ok: AuthorizeRequest }
  // Nowhere trustworthy to send the error: show it instead (RFC 6749 §4.1.2.1).
  | { page: string }
  // A valid client and redirect URI, so the error goes back to the client.
  | { redirect: string };

async function checkAuthorize(env: Env, origin: string, p: Record<string, string | undefined>): Promise<Checked> {
  const client = await loadClient(env.DB, p.client_id);
  if (!client) return { page: "This app isn't registered with Track Evolution, or its registration couldn't be read." };
  // A client with one registered URI may omit redirect_uri; otherwise it must
  // name one of them.
  const redirectUri = p.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri))
    return { page: "This app asked to be sent somewhere it didn't register, so the request was stopped." };
  const fail = (error: string, description: string) => ({
    redirect: redirectWith(redirectUri, { error, error_description: description, state: p.state, iss: origin }),
  });
  if (p.response_type !== "code") return fail("unsupported_response_type", "only the authorization code flow is supported");
  if (!p.code_challenge || p.code_challenge_method !== "S256")
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge)) return fail("invalid_request", "malformed code_challenge");
  if (!resourceMatches(p.resource, origin)) return fail("invalid_target", "unknown resource");
  return { ok: { client, redirectUri, state: p.state, codeChallenge: p.code_challenge, resource: p.resource } };
}

const AUTHORIZE_PARAMS = ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"];

function pick(source: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of AUTHORIZE_PARAMS) {
    const v = source[k];
    out[k] = typeof v === "string" && v !== "" ? v : undefined;
  }
  return out;
}

// ---------- the consent page ---------------------------------------------------

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const CSP = [
  "default-src 'none'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

function page(c: Ctx, title: string, body: string, status: 200 | 400 = 200) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${esc(title)} · Track Evolution</title>
<link rel="stylesheet" href="/style.css" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
</head>
<body>
<div class="login-wrap"><div class="login-card consent-card">
<div class="flag"><img src="/favicon.svg" alt="" width="56" height="56" /></div>
${body}
</div></div>
</body>
</html>`;
  c.header("Content-Security-Policy", CSP);
  c.header("X-Frame-Options", "DENY");
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  return c.html(html, status);
}

const errorPage = (c: Ctx, message: string) =>
  page(c, "Can't connect", `<h1>Can't connect</h1><p>${esc(message)}</p>`, 400);

const clientLabel = (client: Client) => client.name ?? "An app";
const hostOf = (uri: string) => {
  try {
    const u = new URL(uri);
    return u.host || u.protocol.replace(/:$/, "");
  } catch {
    return uri;
  }
};

const CSRF_COOKIE = "oauth_csrf";

function hiddenFields(p: Record<string, string | undefined>) {
  return AUTHORIZE_PARAMS.filter((k) => p[k] != null)
    .map((k) => `<input type="hidden" name="${k}" value="${esc(p[k]!)}" />`)
    .join("");
}

oauth.get("/authorize", async (c) => {
  const origin = originOf(c.req.url);
  const params = pick(c.req.query());
  const checked = await checkAuthorize(c.env, origin, params);
  if ("page" in checked) return errorPage(c, checked.page);
  if ("redirect" in checked) return c.redirect(checked.redirect);
  const { client, redirectUri } = checked.ok;
  const name = esc(clientLabel(client));
  const back = `/oauth/authorize?${new URL(c.req.url).searchParams.toString()}`;

  const token = getCookie(c, SESSION_COOKIE);
  const user = token ? await sessionUser(c.env.DB, token) : null;
  if (!user) {
    const next = encodeURIComponent(back);
    const apple = appleConfig(c.env)
      ? `<a class="btn apple" href="/auth/apple/login?next=${next}">Sign in with Apple</a>`
      : "";
    return page(
      c,
      "Sign in",
      `<h1>Sign in to connect</h1>
<p><strong>${name}</strong> wants to read your Track Evolution logbook. Sign in first.</p>
<div class="login-buttons">
<a class="btn primary" href="/auth/login?next=${next}">Sign in with Google</a>
${apple}
</div>`
    );
  }

  const profile = await c.env.DB.prepare("SELECT name, email FROM users WHERE id = ?")
    .bind(user.userId)
    .first<{ name: string | null; email: string }>();
  const who = esc(profile?.name || profile?.email || "you");

  const csrf = randomToken();
  setCookie(c, CSRF_COOKIE, csrf, {
    httpOnly: true,
    secure: origin.startsWith("https:"),
    sameSite: "Strict",
    path: "/oauth",
    maxAge: 600,
  });
  const form = (inner: string) =>
    `<form method="post" action="/oauth/authorize" class="consent-form">${hiddenFields(params)}<input type="hidden" name="csrf" value="${csrf}" />${inner}</form>`;

  if (!isEntitled(user.entitledUntil, Date.now())) {
    return page(
      c,
      "Pro required",
      `<h1>Track Evolution Pro required</h1>
<p>Connecting <strong>${name}</strong> to your logbook is part of Track Evolution Pro. Subscribe in the Track Evolution app on your iPhone or Android phone, then connect again.</p>
${form(`<button class="btn" type="submit" name="action" value="deny">Go back</button>`)}`
    );
  }

  return page(
    c,
    "Connect",
    `<h1>Connect ${name}?</h1>
<p><strong>${name}</strong> will be able to read your Track Evolution logbook:</p>
<ul class="consent-list">
<li>tracks, events, sessions and lap times</li>
<li>lap telemetry and the analysis built on it</li>
<li>your garage, setup sheets and notes</li>
<li>leaderboards you can already see</li>
</ul>
<p>It can't change or delete anything.</p>
${form(`<div class="login-buttons">
<button class="btn primary" type="submit" name="action" value="allow">Allow</button>
<button class="btn" type="submit" name="action" value="deny">Cancel</button>
</div>`)}
<p class="consent-fine">Signed in as ${who}. You'll be sent back to ${esc(hostOf(redirectUri))}. You can disconnect it any time in Settings.</p>`
  );
});

oauth.post("/authorize", async (c) => {
  const origin = originOf(c.req.url);
  const body = await c.req.parseBody();
  const params = pick(body);
  const checked = await checkAuthorize(c.env, origin, params);
  if ("page" in checked) return errorPage(c, checked.page);
  if ("redirect" in checked) return c.redirect(checked.redirect);
  const req = checked.ok;

  // SameSite=Lax on the session cookie already keeps a cross-site form post
  // from arriving signed in; the double-submit token is the second lock.
  const csrf = getCookie(c, CSRF_COOKIE);
  if (!csrf || body.csrf !== csrf) return errorPage(c, "This page expired. Go back to the app and connect again.");
  setCookie(c, CSRF_COOKIE, "", { path: "/oauth", maxAge: 0 });

  const denied = redirectWith(req.redirectUri, { error: "access_denied", state: req.state, iss: origin });
  if (body.action !== "allow") return c.redirect(denied);

  const token = getCookie(c, SESSION_COOKIE);
  const user = token ? await sessionUser(c.env.DB, token) : null;
  if (!user) return errorPage(c, "You were signed out. Go back to the app and connect again.");
  if (!isEntitled(user.entitledUntil, Date.now())) return c.redirect(denied);

  const now = Date.now();
  const grant = await c.env.DB.prepare(
    `INSERT INTO oauth_grants (user_id, client_id, scope, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, client_id) DO UPDATE SET scope = excluded.scope
     RETURNING id`
  )
    .bind(user.userId, req.client.id, SCOPE, now)
    .first<{ id: number }>();
  const code = randomToken();
  await c.env.DB.prepare(
    "INSERT INTO oauth_codes (code, grant_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(await sha256Hex(code), grant!.id, req.redirectUri, req.codeChallenge, now + OAUTH_CODE_TTL_MS)
    .run();
  return c.redirect(redirectWith(req.redirectUri, { code, state: req.state, iss: origin }));
});

// ---------- tokens -------------------------------------------------------------

const tokenError = (error: string, description: string, status: 400 | 401 = 400) =>
  new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

async function issueTokens(db: D1Database, grantId: number) {
  const access = `te_at_${randomToken()}`;
  const refresh = `te_rt_${randomToken()}`;
  const now = Date.now();
  const insert = "INSERT INTO oauth_tokens (token, grant_id, kind, expires_at) VALUES (?, ?, ?, ?)";
  await db.batch([
    db.prepare("DELETE FROM oauth_tokens WHERE grant_id = ? AND expires_at <= ?").bind(grantId, now),
    db.prepare(insert).bind(await sha256Hex(access), grantId, "access", now + ACCESS_TOKEN_TTL_MS),
    db.prepare(insert).bind(await sha256Hex(refresh), grantId, "refresh", now + REFRESH_TOKEN_TTL_MS),
  ]);
  return new Response(
    JSON.stringify({
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token: refresh,
      scope: SCOPE,
    }),
    { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache" } }
  );
}

// Form-encoded per RFC 6749, with a JSON fallback for lenient clients. A
// public client's id arrives in the body, or — from clients that default to
// client_secret_basic whatever the registration said — as the Basic username.
async function tokenParams(req: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const type = req.headers.get("Content-Type") ?? "";
  let raw: Record<string, unknown> = {};
  if (type.includes("application/json")) {
    raw = ((await req.json().catch(() => ({}))) as Record<string, unknown>) ?? {};
  } else if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    if (form) raw = Object.fromEntries(form);
  }
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  const basic = req.headers.get("Authorization");
  if (!out.client_id && basic?.startsWith("Basic ")) {
    try {
      out.client_id = decodeURIComponent(atob(basic.slice(6)).split(":")[0]);
    } catch {}
  }
  return out;
}

oauth.use("/token", bearerCors);
oauth.post("/token", async (c) => {
  const p = await tokenParams(c.req.raw);
  const db = c.env.DB;
  const origin = originOf(c.req.url);
  if (!resourceMatches(p.resource, origin)) return tokenError("invalid_target", "unknown resource");

  if (p.grant_type === "authorization_code") {
    if (!p.code || !p.code_verifier) return tokenError("invalid_request", "code and code_verifier are required");
    const hash = await sha256Hex(p.code);
    const row = await db
      .prepare(
        `SELECT c.grant_id, c.redirect_uri, c.code_challenge, c.expires_at, g.client_id
           FROM oauth_codes c JOIN oauth_grants g ON g.id = c.grant_id WHERE c.code = ?`
      )
      .bind(hash)
      .first<{ grant_id: number; redirect_uri: string; code_challenge: string; expires_at: number; client_id: string }>();
    // Single use: burn it before any check, so a failed attempt can't retry.
    if (row) await db.prepare("DELETE FROM oauth_codes WHERE code = ?").bind(hash).run();
    if (!row || row.expires_at <= Date.now()) return tokenError("invalid_grant", "invalid or expired code");
    if (p.client_id && p.client_id !== row.client_id) return tokenError("invalid_grant", "code was issued to another client");
    if (p.redirect_uri && p.redirect_uri !== row.redirect_uri) return tokenError("invalid_grant", "redirect_uri mismatch");
    if ((await sha256Base64Url(p.code_verifier)) !== row.code_challenge)
      return tokenError("invalid_grant", "PKCE verification failed");
    return issueTokens(db, row.grant_id);
  }

  if (p.grant_type === "refresh_token") {
    if (!p.refresh_token) return tokenError("invalid_request", "refresh_token is required");
    const hash = await sha256Hex(p.refresh_token);
    const row = await db
      .prepare(
        `SELECT t.grant_id, t.expires_at, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
          WHERE t.token = ? AND t.kind = 'refresh'`
      )
      .bind(hash)
      .first<{ grant_id: number; expires_at: number; client_id: string }>();
    if (!row || row.expires_at <= Date.now()) return tokenError("invalid_grant", "invalid or expired refresh token");
    if (p.client_id && p.client_id !== row.client_id) return tokenError("invalid_grant", "token was issued to another client");
    // Rotation (OAuth 2.1 §4.3.1 for public clients): the old refresh token
    // dies as the new pair is issued.
    await db.prepare("DELETE FROM oauth_tokens WHERE token = ?").bind(hash).run();
    return issueTokens(db, row.grant_id);
  }

  return tokenError("unsupported_grant_type", "use authorization_code or refresh_token");
});

// RFC 7009. Always 200, whether or not the token existed. Revoking a refresh
// token ends the grant's access tokens with it; the grant itself (the
// connected-app row) stays until the user disconnects it in Settings.
oauth.use("/revoke", bearerCors);
oauth.post("/revoke", async (c) => {
  const p = await tokenParams(c.req.raw);
  if (p.token) {
    const hash = await sha256Hex(p.token);
    const row = await c.env.DB.prepare("SELECT grant_id, kind FROM oauth_tokens WHERE token = ?")
      .bind(hash)
      .first<{ grant_id: number; kind: string }>();
    if (row?.kind === "refresh") await c.env.DB.prepare("DELETE FROM oauth_tokens WHERE grant_id = ?").bind(row.grant_id).run();
    else if (row) await c.env.DB.prepare("DELETE FROM oauth_tokens WHERE token = ?").bind(hash).run();
  }
  return c.body(null, 200);
});

// ---------- housekeeping -------------------------------------------------------------

// Registration is open by design (any MCP client may register), so the tables
// need sweeping: expired codes and tokens, and registered clients nobody ever
// connected — every reconnect registers a fresh client id, and a crawler can
// register as many as it likes. A day's grace keeps a client whose user is
// still on the consent page. Metadata-document clients are only written by an
// authorization, and grants reference them, so the same rule covers them.
// Run daily from the Worker's cron (src/index.ts).
export const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

export async function sweepOAuth(db: D1Database, nowMs: number) {
  const [codes, tokens, clients] = await db.batch([
    db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").bind(nowMs),
    db.prepare("DELETE FROM oauth_tokens WHERE expires_at <= ?").bind(nowMs),
    db
      .prepare(
        "DELETE FROM oauth_clients WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id)"
      )
      .bind(nowMs - UNUSED_CLIENT_TTL_MS),
  ]);
  return { codes: codes.meta.changes, tokens: tokens.meta.changes, clients: clients.meta.changes };
}

// ---------- the resource side ------------------------------------------------------

export type OAuthTokenUser = { userId: number; entitledUntil: number | null; grantId: number; lastUsedAt: number | null };

// An access token to its user and entitlement in one statement, the way
// sessionUser does it for the app's own sessions.
export async function oauthTokenUser(db: D1Database, token: string): Promise<OAuthTokenUser | null> {
  const row = await db
    .prepare(
      `SELECT g.id AS grant_id, g.user_id, g.last_used_at, u.entitled_until
         FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
        WHERE t.token = ? AND t.kind = 'access' AND t.expires_at > ?`
    )
    .bind(await sha256Hex(token), Date.now())
    .first<{ grant_id: number; user_id: number; last_used_at: number | null; entitled_until: number | null }>();
  return row
    ? { userId: row.user_id, entitledUntil: row.entitled_until ?? null, grantId: row.grant_id, lastUsedAt: row.last_used_at }
    : null;
}
