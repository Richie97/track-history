import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppContext, Ctx, Env } from "../types";
import { requireEntitlement } from "../middleware";
import { SESSION_COOKIE, randomToken, sessionUser, sha256Base64Url, sha256Hex } from "../lib/session";
import { decodeIdTokenPayload } from "../lib/oidc";
import {
  MAX_DAILY_UPLOADS_PER_USER,
  TEXT,
  TICKET_TTL_MS,
  YT_SCOPES,
  YT_SCOPE_UPLOAD,
  decryptSecret,
  defaultVideoMetadata,
  encryptSecret,
  sanitizeVideoMetadata,
  uploadView,
  youtubeAvailable,
} from "../lib/youtube";
import { GOOGLE_AUTH_URL, exchangeCode, revokeToken, youtubeConfig } from "../youtube/google";

// Publish a best-lap video to YouTube (NS-46,
// docs/specs/native/NS-46-youtube-upload.md).
//
// Two routers. `youtube` is ordinary /api: the native connect ticket,
// disconnecting, and a clip's draft, upload and status. `youtubeConnect` is
// outside /api, mounted at /youtube (in run_worker_first): the consent round
// trip with Google, which a phone opens in the system browser.
//
// Tier: drafting and uploading are Pro — the FOURTH stated exception to "no
// write route checks entitlement", after the setup writes, the coach invite
// and the clip create, and safe for the same reason: it writes nothing to the
// logbook, and the clip it reads is Pro to play already. Connecting is ungated
// (a ticket costs nothing), disconnecting is never gated, and reading an
// upload's status is free — the link to a video already on YouTube is the
// driver's. A lapse doesn't stop an upload already in the queue.
//
// None of it is in COACH_ROUTES, so under the coach mount every route here is
// a 404; and every refusal on another user's clip is a 404 too.
export const youtube = new Hono<AppContext>();

const NOT_FOUND = { error: "not found" };
const DAY_MS = 24 * 60 * 60 * 1000;

async function userEmail(db: D1Database, userId: number): Promise<string | null> {
  const row = await db.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string | null }>();
  return row?.email ?? null;
}

async function availableTo(c: Ctx, userId: number): Promise<boolean> {
  return youtubeAvailable(c.env, await userEmail(c.env.DB, userId));
}

// The phone can't hand its bearer token to a browser, so it trades it here for
// a single-use, 5-minute ticket the browser carries instead.
youtube.post("/youtube/connect", async (c) => {
  const userId = c.get("userId");
  if (!(await availableTo(c, userId))) return c.json(NOT_FOUND, 404);
  const ticket = randomToken();
  await c.env.DB.prepare("INSERT INTO youtube_connect_tickets (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(ticket), userId, Date.now() + TICKET_TTL_MS)
    .run();
  return c.json({ url: `${new URL(c.req.url).origin}/youtube/connect?ticket=${ticket}` });
});

// Revoke at Google first (best effort), then delete — the trigger leaves a
// revocation row either way, which the cron drains; when this call already
// revoked, that row is dropped in the same batch. Anything still on its way to
// YouTube fails in words. Videos already uploaded stay where they are: the
// app never deletes one, and youtube.upload couldn't.
youtube.delete("/youtube", async (c) => {
  const userId = c.get("userId");
  const db = c.env.DB;
  const row = await db
    .prepare("SELECT refresh_token_enc FROM youtube_connections WHERE user_id = ?")
    .bind(userId)
    .first<{ refresh_token_enc: string }>();
  if (!row) return c.json({ ok: true });
  let revoked = false;
  const cfg = youtubeConfig(c.env);
  if (cfg) {
    try {
      const outcome = await revokeToken(await decryptSecret(cfg.tokenKey, row.refresh_token_enc));
      revoked = outcome !== "failed";
    } catch {
      // Undecryptable or unreachable: the cron tries again.
    }
  }
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM youtube_connections WHERE user_id = ?").bind(userId),
    ...(revoked ? [db.prepare("DELETE FROM youtube_revocations WHERE refresh_token_enc = ?").bind(row.refresh_token_enc)] : []),
    db
      .prepare(
        `UPDATE youtube_uploads SET status = 'failed', error = ?, session_url_enc = NULL, lease_until = NULL, updated_at = ?
          WHERE user_id = ? AND status IN ('queued', 'uploading')`
      )
      .bind(TEXT.disconnected, now, userId),
  ]);
  return c.json({ ok: true });
});

type DraftRow = {
  id: number;
  status: string;
  size_bytes: number;
  lap_offset_ms: number;
  time_ms: number;
  label: string | null;
  start_date: string;
  car: string | null;
  track: string;
  session_number: number;
};

function ownedClipForDraft(db: D1Database, userId: number, clipId: string) {
  return db
    .prepare(
      `SELECT k.id, k.status, k.size_bytes, k.lap_offset_ms, l.time_ms, s.label, e.start_date, t.name AS track,
              COALESCE(NULLIF(TRIM(e.car), ''), v.name) AS car,
              (SELECT COUNT(*) FROM sessions s2 WHERE s2.event_id = s.event_id
                 AND (s2.sort < s.sort OR (s2.sort = s.sort AND s2.id <= s.id))) AS session_number
         FROM lap_clips k JOIN laps l ON l.id = k.lap_id JOIN sessions s ON s.id = l.session_id
         JOIN events e ON e.id = s.event_id JOIN tracks t ON t.id = e.track_id
         LEFT JOIN vehicles v ON v.id = e.vehicle_id
        WHERE k.id = ? AND k.user_id = ?`
    )
    .bind(clipId, userId)
    .first<DraftRow>();
}

// The words every client pre-fills, built once, here, so no client ports them.
youtube.get("/clips/:id/youtube/draft", requireEntitlement, async (c) => {
  const userId = c.get("userId");
  if (!(await availableTo(c, userId))) return c.json(NOT_FOUND, 404);
  const [clip, conn] = await Promise.all([
    ownedClipForDraft(c.env.DB, userId, c.req.param("id")),
    c.env.DB.prepare("SELECT email FROM youtube_connections WHERE user_id = ? AND status = 'ok'")
      .bind(userId)
      .first<{ email: string | null }>(),
  ]);
  if (!clip) return c.json(NOT_FOUND, 404);
  if (clip.status !== "ready") return c.json({ error: "clip not ready" }, 409);
  const meta = defaultVideoMetadata({
    track: clip.track,
    lapTimeMs: clip.time_ms,
    sessionLabel: clip.label,
    sessionNumber: clip.session_number,
    date: clip.start_date,
    car: clip.car,
    lapOffsetMs: clip.lap_offset_ms,
  });
  return c.json({ ...meta, account: conn?.email ?? null });
});

type UploadJoin = {
  status: "queued" | "uploading" | "done" | "failed";
  privacy: "private" | "unlisted" | "public";
  video_id: string | null;
  bytes_sent: number;
  error: string | null;
  size_bytes: number;
};

function uploadFor(db: D1Database, userId: number, clipId: string | number) {
  return db
    .prepare(
      `SELECT y.status, y.privacy, y.video_id, y.bytes_sent, y.error, k.size_bytes
         FROM youtube_uploads y JOIN lap_clips k ON k.id = y.clip_id
        WHERE y.clip_id = ? AND k.user_id = ?`
    )
    .bind(clipId, userId)
    .first<UploadJoin>();
}

// Queue an upload: a new row, or a failed one reset — never a second copy of
// one that is done or on its way. The per-user limit is folded into the insert
// so two at once can't both slip under it.
youtube.post("/clips/:id/youtube", requireEntitlement, async (c) => {
  const userId = c.get("userId");
  const db = c.env.DB;
  if (!(await availableTo(c, userId))) return c.json(NOT_FOUND, 404);
  const clipId = c.req.param("id");
  const [clip, conn] = await Promise.all([
    db
      .prepare("SELECT id, status FROM lap_clips WHERE id = ? AND user_id = ?")
      .bind(clipId, userId)
      .first<{ id: number; status: string }>(),
    db
      .prepare("SELECT status FROM youtube_connections WHERE user_id = ?")
      .bind(userId)
      .first<{ status: string }>(),
  ]);
  if (!clip) return c.json(NOT_FOUND, 404);
  if (clip.status !== "ready") return c.json({ error: "clip not ready" }, 409);
  if (conn?.status !== "ok") return c.json({ error: "youtube not connected" }, 409);
  const sane = sanitizeVideoMetadata(await c.req.json().catch(() => null));
  if ("error" in sane) return c.json({ error: sane.error }, 400);
  const { title, description, privacy } = sane.meta;

  const now = Date.now();
  const inserted = await db
    .prepare(
      `INSERT INTO youtube_uploads (user_id, clip_id, status, title, description, privacy, created_at, updated_at)
       SELECT ?1, ?2, 'queued', ?3, ?4, ?5, ?6, ?6
        WHERE (SELECT COUNT(*) FROM youtube_uploads WHERE user_id = ?1 AND created_at > ?7) < ?8
       ON CONFLICT(clip_id) DO UPDATE SET status = 'queued', title = excluded.title, description = excluded.description,
         privacy = excluded.privacy, session_url_enc = NULL, bytes_sent = 0, restarts = 0, lease_until = NULL,
         video_id = NULL, error = NULL, created_at = excluded.created_at, verified_at = NULL, updated_at = excluded.updated_at
        WHERE youtube_uploads.status = 'failed'
       RETURNING id`
    )
    .bind(userId, clip.id, title, description, privacy, now, now - DAY_MS, MAX_DAILY_UPLOADS_PER_USER)
    .first<{ id: number }>();

  if (!inserted) {
    const existing = await uploadFor(db, userId, clip.id);
    if (existing?.status === "done") return c.json({ error: "already on youtube" }, 409);
    if (existing?.status === "queued" || existing?.status === "uploading")
      return c.json({ error: "youtube upload in progress" }, 409);
    return c.json({ error: "youtube upload limit" }, 429);
  }

  try {
    await c.env.YOUTUBE_QUEUE!.send({ upload_id: inserted.id });
  } catch (err) {
    console.error("youtube enqueue failed:", inserted.id, err instanceof Error ? err.message : err);
    await db
      .prepare("UPDATE youtube_uploads SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .bind(TEXT.generic, now, inserted.id)
      .run();
    return c.json({ error: "couldn't start the upload — try again" }, 502);
  }
  const row = (await uploadFor(db, userId, clip.id))!;
  return c.json(uploadView(row, row.size_bytes), 202);
});

// The lap page's status line, polled every 5 s while an upload is on its way —
// so it isn't refetching the whole event detail. Free: it is the driver's own
// link.
youtube.get("/clips/:id/youtube", async (c) => {
  const row = await uploadFor(c.env.DB, c.get("userId"), c.req.param("id"));
  if (!row) return c.json(NOT_FOUND, 404);
  c.header("Cache-Control", "no-store");
  return c.json(uploadView(row, row.size_bytes));
});

// ---------- /youtube/* — the consent round trip -------------------------------

export const youtubeConnect = new Hono<AppContext>();

const APP_RESULT_URI = "trackevolution://youtube";
const FLOW_COOKIE = "yt_connect";
const FLOW_TTL_MS = 10 * 60 * 1000;
// Where a web connect comes back to: a hash route, nothing else, so `next` is
// never an open redirect.
const WEB_DEFAULT_RETURN = "#/settings";
const isWebReturn = (v: unknown): v is string => typeof v === "string" && /^#\/[A-Za-z0-9/_-]{0,200}$/.test(v);

type Flow = { u: number; s: string; v: string; r: string; e: number };
type Result = "connected" | "denied" | "error";

// Back to whoever started it: the app's scheme for a ticket flow, else the web
// page with the result in its hash query.
function finish(c: Ctx, ret: string, result: Result) {
  if (ret === "app") return c.redirect(`${APP_RESULT_URI}?result=${result}`);
  const target = isWebReturn(ret) ? ret : WEB_DEFAULT_RETURN;
  return c.redirect(`/${target}?youtube=${result}`);
}

const callbackUrl = (c: Ctx) => new URL("/youtube/callback", c.req.url).toString();

// Start: from a ticket (the phones, which it burns) or the session cookie (the
// web), set the flow cookie and go to Google. The flow cookie is one AES-GCM
// sealed value — the user, the state, the PKCE verifier and where to come
// back — so nothing about it can be forged or read client-side and no D1 row
// is needed to carry it across. SameSite=Lax: Google's redirect back is a
// top-level GET.
youtubeConnect.get("/connect", async (c) => {
  const cfg = youtubeConfig(c.env);
  const ticket = c.req.query("ticket");
  const isApp = ticket != null;
  const ret = isApp ? "app" : isWebReturn(c.req.query("next")) ? c.req.query("next")! : WEB_DEFAULT_RETURN;
  if (!cfg) return finish(c, ret, "error");

  let userId: number | null = null;
  if (isApp) {
    const row = await c.env.DB.prepare(
      "DELETE FROM youtube_connect_tickets WHERE token_hash = ? RETURNING user_id, expires_at"
    )
      .bind(await sha256Hex(ticket))
      .first<{ user_id: number; expires_at: number }>();
    if (!row || row.expires_at < Date.now()) return finish(c, ret, "error");
    userId = row.user_id;
  } else {
    const token = getCookie(c, SESSION_COOKIE);
    const user = token ? await sessionUser(c.env.DB, token) : null;
    if (!user) {
      const back = `/youtube/connect?next=${encodeURIComponent(ret)}`;
      return c.redirect(`/auth/login?next=${encodeURIComponent(back)}`);
    }
    userId = user.userId;
  }
  if (!youtubeAvailable(c.env, await userEmail(c.env.DB, userId))) return finish(c, ret, "error");

  const state = randomToken();
  const verifier = randomToken();
  const flow: Flow = { u: userId, s: state, v: verifier, r: ret, e: Date.now() + FLOW_TTL_MS };
  setCookie(c, FLOW_COOKIE, await encryptSecret(cfg.tokenKey, JSON.stringify(flow)), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/youtube",
    maxAge: FLOW_TTL_MS / 1000,
  });
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", callbackUrl(c));
  url.searchParams.set("response_type", "code");
  // Upload, and who you are so Settings can say it. Nothing more: no list,
  // change or delete on the channel.
  url.searchParams.set("scope", YT_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await sha256Base64Url(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return c.redirect(url.toString());
});

async function readFlow(env: Env, sealed: string | undefined): Promise<Flow | null> {
  const cfg = youtubeConfig(env);
  if (!cfg || !sealed) return null;
  try {
    const flow = JSON.parse(await decryptSecret(cfg.tokenKey, sealed)) as Flow;
    if (typeof flow.u !== "number" || typeof flow.s !== "string" || typeof flow.v !== "string") return null;
    return flow.e > Date.now() ? flow : null;
  } catch {
    return null;
  }
}

youtubeConnect.get("/callback", async (c) => {
  const flow = await readFlow(c.env, getCookie(c, FLOW_COOKIE));
  deleteCookie(c, FLOW_COOKIE, { path: "/youtube" });
  if (!flow) return finish(c, WEB_DEFAULT_RETURN, "error");
  if (c.req.query("state") !== flow.s) return finish(c, flow.r, "error");
  // Declining Google's consent is a choice, not a failure.
  const error = c.req.query("error");
  if (error) return finish(c, flow.r, error === "access_denied" ? "denied" : "error");
  const code = c.req.query("code");
  const cfg = youtubeConfig(c.env)!;
  if (!code) return finish(c, flow.r, "error");

  let tokens;
  try {
    tokens = await exchangeCode(cfg, code, flow.v, callbackUrl(c));
  } catch {
    tokens = null;
  }
  if (!tokens?.access_token) return finish(c, flow.r, "error");
  // Google's granular consent lets a user untick the upload scope and still
  // approve. A grant that can't upload is no connection: hand it back.
  const granted = (tokens.scope ?? "").split(/\s+/);
  if (!granted.includes(YT_SCOPE_UPLOAD)) {
    await revokeToken(tokens.refresh_token ?? tokens.access_token).catch(() => {});
    return finish(c, flow.r, "denied");
  }
  if (!tokens.refresh_token || !tokens.id_token) return finish(c, flow.r, "error");
  // Straight from Google's token endpoint over TLS (OIDC 3.1.3.7), as at sign-in.
  let sub: string, email: string | null;
  try {
    const payload = decodeIdTokenPayload(tokens.id_token);
    sub = payload.sub;
    email = typeof payload.email === "string" ? payload.email : null;
  } catch {
    return finish(c, flow.r, "error");
  }
  if (typeof sub !== "string" || !sub) return finish(c, flow.r, "error");

  const now = Date.now();
  const [refreshEnc, accessEnc] = await Promise.all([
    encryptSecret(cfg.tokenKey, tokens.refresh_token),
    encryptSecret(cfg.tokenKey, tokens.access_token),
  ]);
  const expiresAt = now + (Number(tokens.expires_in) || 3600) * 1000;
  const db = c.env.DB;
  const existing = await db
    .prepare("SELECT google_sub FROM youtube_connections WHERE user_id = ?")
    .bind(flow.u)
    .first<{ google_sub: string }>();
  const insert = db
    .prepare(
      `INSERT INTO youtube_connections (user_id, google_sub, email, channel_title, refresh_token_enc, access_token_enc,
         access_expires_at, status, connected_at, verified_at, updated_at)
       VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, 'ok', ?7, ?7, ?7)
       ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, refresh_token_enc = excluded.refresh_token_enc,
         access_token_enc = excluded.access_token_enc, access_expires_at = excluded.access_expires_at, status = 'ok',
         connected_at = excluded.connected_at, verified_at = excluded.verified_at, updated_at = excluded.updated_at`
    )
    .bind(flow.u, sub, email, refreshEnc, accessEnc, expiresAt, now);
  // The same Google account reconnecting is the same grant, so its old refresh
  // token is simply replaced — revoking it would revoke the grant just made. A
  // different account replaces the row outright, and the delete's trigger
  // queues the old account's grant for revocation.
  await db.batch(
    existing && existing.google_sub !== sub
      ? [db.prepare("DELETE FROM youtube_connections WHERE user_id = ?").bind(flow.u), insert]
      : [insert]
  );
  return finish(c, flow.r, "connected");
});
