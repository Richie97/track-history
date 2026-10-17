// Google's half of NS-46: the OAuth token endpoint, revocation, and YouTube's
// resumable upload and videos.list — plus the connection's access token, kept
// encrypted on its row and refreshed when it is about to expire.
//
// Every call takes the `fetch` to use. The routes pass the global one (the API
// tests stub Google there with fetchMock, as the billing tests stub the
// stores); the queue step and the cron take it from their caller, which is how
// the tests script a resumable session byte by byte.

import type { Env } from "../types";
import { TOKEN_REFRESH_AHEAD_MS, decryptSecret, encryptSecret, googleErrorReason } from "../lib/youtube";

export type Fetch = typeof fetch;

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const YT_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
export const YT_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

export type YouTubeConfig = { clientId: string; clientSecret: string; tokenKey: string };

export function youtubeConfig(env: Env): YouTubeConfig | null {
  const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_TOKEN_KEY } = env;
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_TOKEN_KEY) return null;
  return { clientId: YOUTUBE_CLIENT_ID, clientSecret: YOUTUBE_CLIENT_SECRET, tokenKey: YOUTUBE_TOKEN_KEY };
}

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields),
});

export type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
};

export async function exchangeCode(
  cfg: YouTubeConfig,
  code: string,
  verifier: string,
  redirectUri: string,
  f: Fetch = fetch
): Promise<TokenResponse | null> {
  const res = await f(
    GOOGLE_TOKEN_URL,
    form({
      code,
      code_verifier: verifier,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    })
  );
  if (!res.ok) return null;
  return (await res.json()) as TokenResponse;
}

export type RefreshOutcome =
  | { kind: "ok"; accessToken: string; expiresAt: number }
  | { kind: "invalid_grant" }
  | { kind: "error" };

export async function refreshAccessToken(
  cfg: YouTubeConfig,
  refreshToken: string,
  now: number,
  f: Fetch = fetch
): Promise<RefreshOutcome> {
  let res: Response;
  try {
    res = await f(
      GOOGLE_TOKEN_URL,
      form({
        refresh_token: refreshToken,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: "refresh_token",
      })
    );
  } catch {
    return { kind: "error" };
  }
  const body = (await res.json().catch(() => null)) as (TokenResponse & { error?: string }) | null;
  // The grant is gone: revoked at Google's permissions page, the password
  // changed, or six months unused. Nothing but reconnecting brings it back.
  if (res.status === 400 && body?.error === "invalid_grant") return { kind: "invalid_grant" };
  if (!res.ok || !body?.access_token) return { kind: "error" };
  return { kind: "ok", accessToken: body.access_token, expiresAt: now + (Number(body.expires_in) || 3600) * 1000 };
}

// "revoked" and "invalid" (Google already forgot it — `invalid_token`) are both
// done; anything else is worth another try tomorrow.
export async function revokeToken(token: string, f: Fetch = fetch): Promise<"revoked" | "invalid" | "failed"> {
  try {
    const res = await f(GOOGLE_REVOKE_URL, form({ token }));
    if (res.ok) return "revoked";
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return res.status === 400 && body?.error === "invalid_token" ? "invalid" : "failed";
  } catch {
    return "failed";
  }
}

export type AccessToken =
  | { kind: "ok"; token: string }
  | { kind: "none" } // never connected, or disconnected
  | { kind: "revoked" } // the grant is gone; the row is marked
  | { kind: "error" }; // Google didn't answer; try again later

type ConnectionTokens = {
  status: "ok" | "revoked";
  refresh_token_enc: string;
  access_token_enc: string | null;
  access_expires_at: number | null;
};

// A usable access token for a user's connection: the stored one while it has
// more than TOKEN_REFRESH_AHEAD_MS left, else a fresh one (stored encrypted).
// `force` refreshes regardless — the cron's 30-day re-check, which is a
// question about the grant, not the token. An invalid_grant marks the
// connection revoked.
export async function accessTokenFor(
  env: Env,
  cfg: YouTubeConfig,
  userId: number,
  now: number,
  f: Fetch = fetch,
  { force = false }: { force?: boolean } = {}
): Promise<AccessToken> {
  const row = await env.DB.prepare(
    "SELECT status, refresh_token_enc, access_token_enc, access_expires_at FROM youtube_connections WHERE user_id = ?"
  )
    .bind(userId)
    .first<ConnectionTokens>();
  if (!row) return { kind: "none" };
  if (row.status !== "ok") return { kind: "revoked" };
  if (!force && row.access_token_enc && (row.access_expires_at ?? 0) > now + TOKEN_REFRESH_AHEAD_MS) {
    try {
      return { kind: "ok", token: await decryptSecret(cfg.tokenKey, row.access_token_enc) };
    } catch {
      // Under another key: fall through and mint a new one.
    }
  }
  let refreshToken: string;
  try {
    refreshToken = await decryptSecret(cfg.tokenKey, row.refresh_token_enc);
  } catch {
    // A refresh token we can no longer read (the key was rotated) is as good
    // as revoked: only reconnecting helps.
    await markRevoked(env.DB, userId, now);
    return { kind: "revoked" };
  }
  const out = await refreshAccessToken(cfg, refreshToken, now, f);
  if (out.kind === "invalid_grant") {
    await markRevoked(env.DB, userId, now);
    return { kind: "revoked" };
  }
  if (out.kind === "error") return { kind: "error" };
  await env.DB.prepare(
    "UPDATE youtube_connections SET access_token_enc = ?, access_expires_at = ?, verified_at = ?, updated_at = ? WHERE user_id = ? AND status = 'ok'"
  )
    .bind(await encryptSecret(cfg.tokenKey, out.accessToken), out.expiresAt, now, now, userId)
    .run();
  return { kind: "ok", token: out.accessToken };
}

// The access token is dropped with the grant: nothing should ever send it.
export function markRevoked(db: D1Database, userId: number, now: number) {
  return db
    .prepare(
      "UPDATE youtube_connections SET status = 'revoked', access_token_enc = NULL, access_expires_at = NULL, updated_at = ? WHERE user_id = ? AND status = 'ok'"
    )
    .bind(now, userId)
    .run();
}

// Drop the stored access token, so the next step mints a new one (a 401 from
// YouTube on a token we thought was good).
export function forgetAccessToken(db: D1Database, userId: number) {
  return db
    .prepare("UPDATE youtube_connections SET access_token_enc = NULL, access_expires_at = NULL WHERE user_id = ?")
    .bind(userId)
    .run();
}

// ---------- YouTube ----------------------------------------------------------------

export function initUpload(accessToken: string, resource: unknown, total: number, f: Fetch = fetch): Promise<Response> {
  return f(YT_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(total),
      "X-Upload-Content-Type": "video/mp4",
    },
    body: JSON.stringify(resource),
  });
}

// "present", "gone", or "unknown" when YouTube won't say (the upload-only
// scope may not reach a private video's details — see the spec's open
// questions) or didn't answer.
export async function videoState(
  accessToken: string,
  videoId: string,
  f: Fetch = fetch
): Promise<"present" | "gone" | "unknown"> {
  try {
    const res = await f(`${YT_VIDEOS_URL}?part=id&id=${encodeURIComponent(videoId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return "unknown";
    const body = (await res.json().catch(() => null)) as { items?: unknown[] } | null;
    if (!body || !Array.isArray(body.items)) return "unknown";
    return body.items.length ? "present" : "gone";
  } catch {
    return "unknown";
  }
}

export async function errorReason(res: Response): Promise<string | null> {
  return googleErrorReason(await res.json().catch(() => null));
}
