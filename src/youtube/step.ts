// The YouTube upload itself (NS-46): R2 → YouTube's resumable upload endpoint,
// one step per queue message, plus the daily sweep.
//
// Why a queue: `waitUntil` ends 30 s after the response and a 150 MB copy can
// take minutes, and one long request would die with the client. Each message
// does ONE thing — mint the resumable session, or send one YT_CHUNK_BYTES
// chunk — then enqueues the next step. Nothing is held in memory between
// steps: the row is the state, and the offset after a chunk is the one YouTube
// reports in its 308's Range, never our own count.
//
// The lease (lease_until) is what makes a duplicate delivery harmless: a step
// takes it in one conditional UPDATE, and every write the step makes after
// that is conditional on still holding it — so a disconnect, a retry from the
// lap page or a second message landing mid-step changes nothing the step
// then overwrites.

import type { Env } from "../types";
import {
  LEASE_MS,
  MAX_QUEUE_DELAY_S,
  MAX_RESTARTS,
  QUOTA_REASONS,
  RECHECK_AFTER_MS,
  TEXT,
  YT_CHUNK_BYTES,
  chunkLength,
  contentRange,
  dailyBudget,
  decryptSecret,
  encryptSecret,
  pacificDay,
  parseResumeRange,
  retryDelaySeconds,
  secondsToPacificMidnight,
  statusRange,
  videoResource,
  youtubeErrorText,
} from "../lib/youtube";
import {
  type Fetch,
  accessTokenFor,
  errorReason,
  forgetAccessToken,
  initUpload,
  markRevoked,
  revokeToken,
  videoState,
  youtubeConfig,
  type YouTubeConfig,
} from "./google";

export const YOUTUBE_QUEUE_NAME = "track-evolution-youtube";
export const YOUTUBE_DLQ_NAME = "track-evolution-youtube-dlq";

export type StepDeps = {
  fetch: Fetch;
  now: number;
  // The chunk size. YT_CHUNK_BYTES in production; the tests step a small clip
  // in proportionally small chunks (still a multiple of 256 KiB).
  chunkBytes?: number;
  // The message's attempt count (1 on first delivery), for the backoff.
  attempt?: number;
};

// What the handler does with the message once the step is done:
//   ack   — nothing more for this message (finished, failed, gone, duplicate)
//   next  — send the next step now
//   later — send the next step after `delaySeconds` (a quota wait), and ack;
//           a new message rather than a retry, so waiting a day doesn't use up
//           the retries that stand between a broken upload and the DLQ
//   retry — retry this message after `delaySeconds` (YouTube or R2 didn't
//           answer); counts toward max_retries, after which the DLQ fails it
export type StepResult =
  | { action: "ack" }
  | { action: "next" }
  | { action: "later"; delaySeconds: number }
  | { action: "retry"; delaySeconds: number };

type UploadRow = {
  id: number;
  user_id: number;
  clip_id: number;
  status: "queued" | "uploading";
  title: string;
  description: string;
  privacy: "private" | "unlisted" | "public";
  session_url_enc: string | null;
  bytes_sent: number;
  restarts: number;
  lease_until: number;
};

const ACK: StepResult = { action: "ack" };
const NEXT: StepResult = { action: "next" };

export async function stepUpload(env: Env, uploadId: number, deps: StepDeps): Promise<StepResult> {
  const { now } = deps;
  const cfg = youtubeConfig(env);
  // Unconfigured is not a reason to fail a driver's upload: the secrets come
  // back and the cron re-enqueues.
  if (!cfg) return ACK;

  // 1. Lease. Zero rows: gone, finished, or another message is stepping it.
  const lease = now + LEASE_MS;
  const row = await env.DB.prepare(
    `UPDATE youtube_uploads SET lease_until = ?1
      WHERE id = ?2 AND status IN ('queued', 'uploading') AND (lease_until IS NULL OR lease_until < ?3)
      RETURNING id, user_id, clip_id, status, title, description, privacy, session_url_enc, bytes_sent, restarts, lease_until`
  )
    .bind(lease, uploadId, now)
    .first<UploadRow>();
  if (!row) return ACK;

  try {
    return await stepLeased(env, cfg, row, deps);
  } finally {
    // 5. Release on every exit — conditional, so a row someone else has since
    // touched (a disconnect cleared the lease) is left as they left it.
    await env.DB.prepare("UPDATE youtube_uploads SET lease_until = NULL WHERE id = ? AND lease_until = ?")
      .bind(row.id, row.lease_until)
      .run();
  }
}

// A write the step makes, only while it still holds the lease.
function held(env: Env, row: UploadRow, set: string, ...values: unknown[]) {
  return env.DB.prepare(`UPDATE youtube_uploads SET ${set} WHERE id = ? AND lease_until = ?`)
    .bind(...values, row.id, row.lease_until)
    .run();
}

function fail(env: Env, row: UploadRow, error: string, now: number) {
  return held(
    env,
    row,
    "status = 'failed', error = ?, session_url_enc = NULL, updated_at = ?",
    error,
    now
  );
}

async function waitForQuota(env: Env, row: UploadRow, now: number): Promise<StepResult> {
  await held(env, row, "error = ?, updated_at = ?", TEXT.waitingQuota, now);
  return { action: "later", delaySeconds: secondsToPacificMidnight(now) };
}

function transportRetry(deps: StepDeps): StepResult {
  return { action: "retry", delaySeconds: retryDelaySeconds(deps.attempt ?? 1) };
}

async function stepLeased(env: Env, cfg: YouTubeConfig, row: UploadRow, deps: StepDeps): Promise<StepResult> {
  const { now, fetch: f } = deps;
  const clip = await env.DB.prepare(
    `SELECT k.r2_key, k.size_bytes, k.status, t.name AS track, COALESCE(NULLIF(TRIM(e.car), ''), v.name) AS car
       FROM lap_clips k JOIN laps l ON l.id = k.lap_id JOIN sessions s ON s.id = l.session_id
       JOIN events e ON e.id = s.event_id JOIN tracks t ON t.id = e.track_id
       LEFT JOIN vehicles v ON v.id = e.vehicle_id
      WHERE k.id = ?`
  )
    .bind(row.clip_id)
    .first<{ r2_key: string; size_bytes: number; status: string; track: string; car: string | null }>();
  // The clip's delete cascades to the row, so this is a race already lost.
  if (!clip || clip.status !== "ready") return ACK;
  const bucket = env.CLIPS;
  if (!bucket) return transportRetry(deps);

  // 2. Token.
  const token = await accessTokenFor(env, cfg, row.user_id, now, f);
  if (token.kind === "none") {
    await fail(env, row, TEXT.disconnected, now);
    return ACK;
  }
  if (token.kind === "revoked") {
    await fail(env, row, TEXT.revoked, now);
    return ACK;
  }
  if (token.kind === "error") return transportRetry(deps);

  const total = clip.size_bytes;

  // 3. No session yet: budget, then mint one.
  if (!row.session_url_enc) {
    const budget = dailyBudget(env);
    if (budget != null) {
      const claimed = await env.DB.prepare(
        `INSERT INTO youtube_daily (day, uploads) SELECT ?1, 1 WHERE ?2 > 0
         ON CONFLICT(day) DO UPDATE SET uploads = uploads + 1 WHERE uploads < ?2
         RETURNING uploads`
      )
        .bind(pacificDay(now), budget)
        .first<{ uploads: number }>();
      if (!claimed) return waitForQuota(env, row, now);
    }
    let res: Response;
    try {
      res = await initUpload(token.token, videoResource(row, { track: clip.track, car: clip.car }), total, f);
    } catch {
      return transportRetry(deps);
    }
    if (res.ok) {
      const location = res.headers.get("Location");
      if (!location) return transportRetry(deps);
      await held(
        env,
        row,
        "status = 'uploading', session_url_enc = ?, bytes_sent = 0, error = NULL, updated_at = ?",
        await encryptSecret(cfg.tokenKey, location),
        now
      );
      return NEXT;
    }
    return handleError(env, row, res, deps);
  }

  // 4. Send a chunk.
  let sessionUrl: string;
  try {
    sessionUrl = await decryptSecret(cfg.tokenKey, row.session_url_enc);
  } catch {
    return restart(env, row, now);
  }
  const offset = row.bytes_sent;
  const length = chunkLength(offset, total, deps.chunkBytes ?? YT_CHUNK_BYTES);
  // Everything was acknowledged but the final answer never arrived: ask.
  if (length === 0) return probe(env, cfg, row, sessionUrl, total, deps);

  let res: Response;
  try {
    const object = await bucket.get(clip.r2_key, { range: { offset, length } });
    if (!object || !("body" in object)) {
      await fail(env, row, TEXT.sourceGone, now);
      return ACK;
    }
    // A FixedLengthStream gives the request its Content-Length, so the chunk
    // streams from R2 to YouTube and the Worker never holds it.
    const { readable, writable } = new FixedLengthStream(length);
    const pump = object.body.pipeTo(writable).catch(() => {});
    res = await f(sessionUrl, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4", "Content-Range": contentRange(offset, length, total) },
      body: readable,
    });
    await pump;
  } catch {
    // Before retrying, ask YouTube where it got to — the documented resume.
    const after = await probe(env, cfg, row, sessionUrl, total, deps);
    return after.action === "ack" || after.action === "next" ? after : transportRetry(deps);
  }
  const outcome = await sessionResponse(env, cfg, row, res, deps);
  if (outcome) return outcome;
  // A 5xx: probe, then retry with backoff.
  const after = await probe(env, cfg, row, sessionUrl, total, deps);
  return after.action === "ack" || after.action === "next" ? after : transportRetry(deps);
}

// What a session PUT's answer means for the row. null for a 5xx, which the
// caller probes and retries.
async function sessionResponse(
  env: Env,
  cfg: YouTubeConfig,
  row: UploadRow,
  res: Response,
  deps: StepDeps
): Promise<StepResult | null> {
  const { now } = deps;
  if (res.status === 308) {
    const sent = parseResumeRange(res.headers.get("Range")) + 1;
    await held(env, row, "status = 'uploading', bytes_sent = ?, error = NULL, updated_at = ?", sent, now);
    return NEXT;
  }
  if (res.status === 200 || res.status === 201) {
    const body = (await res.json().catch(() => null)) as { id?: unknown; snippet?: { channelTitle?: unknown } } | null;
    const videoId = typeof body?.id === "string" ? body.id : null;
    if (!videoId) {
      await fail(env, row, TEXT.generic, now);
      return ACK;
    }
    const channel = typeof body?.snippet?.channelTitle === "string" ? body.snippet.channelTitle : null;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE youtube_uploads SET status = 'done', video_id = ?, session_url_enc = NULL, bytes_sent = (
           SELECT size_bytes FROM lap_clips WHERE id = youtube_uploads.clip_id), error = NULL, verified_at = ?, updated_at = ?
          WHERE id = ? AND lease_until = ?`
      ).bind(videoId, now, now, row.id, row.lease_until),
      env.DB.prepare(
        "UPDATE youtube_connections SET channel_title = COALESCE(?, channel_title), updated_at = ? WHERE user_id = ?"
      ).bind(channel, now, row.user_id),
    ]);
    return ACK;
  }
  if (res.status === 404 || res.status === 410) return restart(env, row, now);
  if (res.status >= 500) return null;
  return handleError(env, row, res, deps);
}

// A 4xx from YouTube, at init or on a chunk.
async function handleError(env: Env, row: UploadRow, res: Response, deps: StepDeps): Promise<StepResult> {
  const { now } = deps;
  if (res.status >= 500 || res.status === 429) return transportRetry(deps);
  const reason = await errorReason(res);
  if (res.status === 401) {
    // A token we thought was good. Mint another next time.
    await forgetAccessToken(env.DB, row.user_id);
    return transportRetry(deps);
  }
  if (reason && QUOTA_REASONS.has(reason)) return waitForQuota(env, row, now);
  if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded" || reason === "backendError")
    return transportRetry(deps);
  if (reason === "insufficientPermissions" || reason === "authError") {
    await markRevoked(env.DB, row.user_id, now);
    await fail(env, row, TEXT.revoked, now);
    return ACK;
  }
  await fail(env, row, youtubeErrorText(reason), now);
  return ACK;
}

// The session expired (YouTube forgets one after about a week): start again
// from byte 0 with a new one, at most MAX_RESTARTS times.
async function restart(env: Env, row: UploadRow, now: number): Promise<StepResult> {
  if (row.restarts >= MAX_RESTARTS) {
    await fail(env, row, TEXT.restarts, now);
    return ACK;
  }
  await held(
    env,
    row,
    "status = 'queued', session_url_enc = NULL, bytes_sent = 0, restarts = restarts + 1, updated_at = ?",
    now
  );
  return NEXT;
}

// The empty PUT that asks a session how much it has. Anything it learns is
// written; a probe that itself gets no answer says only "retry".
async function probe(
  env: Env,
  cfg: YouTubeConfig,
  row: UploadRow,
  sessionUrl: string,
  total: number,
  deps: StepDeps
): Promise<StepResult> {
  let res: Response;
  try {
    res = await deps.fetch(sessionUrl, {
      method: "PUT",
      headers: { "Content-Range": statusRange(total), "Content-Length": "0" },
    });
  } catch {
    return transportRetry(deps);
  }
  return (await sessionResponse(env, cfg, row, res, deps)) ?? transportRetry(deps);
}

// ---------- the queue handler ----------------------------------------------------

// Beside `scheduled` in index.ts. The main queue steps uploads; the dead-letter
// queue is where a message lands after max_retries, and failing its row there
// is what stops an upload sitting at "Uploading" forever.
export async function youtubeQueue(
  batch: MessageBatch<{ upload_id: number }>,
  env: Env,
  deps: { fetch?: Fetch; now?: () => number; chunkBytes?: number } = {}
): Promise<void> {
  const now = deps.now ?? Date.now;
  if (batch.queue === YOUTUBE_DLQ_NAME) {
    for (const msg of batch.messages) {
      const id = Number(msg.body?.upload_id);
      if (Number.isInteger(id)) {
        await env.DB.prepare(
          `UPDATE youtube_uploads SET status = 'failed', error = ?, session_url_enc = NULL, lease_until = NULL, updated_at = ?
            WHERE id = ? AND status IN ('queued', 'uploading')`
        )
          .bind(TEXT.deadLetter, now(), id)
          .run();
      }
      msg.ack();
    }
    return;
  }
  for (const msg of batch.messages) {
    const id = Number(msg.body?.upload_id);
    if (!Number.isInteger(id)) {
      msg.ack();
      continue;
    }
    try {
      const result = await stepUpload(env, id, {
        fetch: deps.fetch ?? fetch,
        now: now(),
        chunkBytes: deps.chunkBytes,
        attempt: msg.attempts,
      });
      if (result.action === "next") await env.YOUTUBE_QUEUE!.send({ upload_id: id });
      else if (result.action === "later")
        await env.YOUTUBE_QUEUE!.send({ upload_id: id }, { delaySeconds: Math.min(result.delaySeconds, MAX_QUEUE_DELAY_S) });
      if (result.action === "retry") msg.retry({ delaySeconds: result.delaySeconds });
      else msg.ack();
    } catch (err) {
      console.error("youtube step failed:", id, err instanceof Error ? err.message : err);
      msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
    }
  }
}

// ---------- the daily sweep ----------------------------------------------------

// A queued or uploading row nobody has touched for this long has lost its
// message. Longer than the 12-hour maximum delay a quota wait schedules, so a
// row that is merely waiting is never given a second message.
export const STALE_STEP_MS = 13 * 60 * 60 * 1000;
// An upload still uploading after this has stopped for good.
export const DEAD_UPLOAD_MS = 2 * 24 * 60 * 60 * 1000;
export const SWEEP_REVOCATIONS = 200;
export const SWEEP_RECHECKS = 100;

export type YouTubeSweepReport = {
  revoked: number;
  revokeFailed: number;
  connectionsChecked: number;
  connectionsDeleted: number;
  videosChecked: number;
  videosDeleted: number;
  requeued: number;
  stalled: number;
};

// Beside sweepClips in `scheduled`.
export async function sweepYouTube(
  env: Env,
  now: number,
  f: Fetch = fetch
): Promise<YouTubeSweepReport> {
  const report: YouTubeSweepReport = {
    revoked: 0,
    revokeFailed: 0,
    connectionsChecked: 0,
    connectionsDeleted: 0,
    videosChecked: 0,
    videosDeleted: 0,
    requeued: 0,
    stalled: 0,
  };
  const db = env.DB;
  const cfg = youtubeConfig(env);

  // 1. Revocations. Without the key there is nothing to send; the rows wait.
  if (cfg) {
    const { results } = await db
      .prepare("SELECT refresh_token_enc FROM youtube_revocations ORDER BY queued_at LIMIT ?")
      .bind(SWEEP_REVOCATIONS)
      .all<{ refresh_token_enc: string }>();
    for (const r of results) {
      let token: string | null = null;
      try {
        token = await decryptSecret(cfg.tokenKey, r.refresh_token_enc);
      } catch {
        // Under a key we no longer have: nothing anyone can send.
      }
      const outcome = token ? await revokeToken(token, f) : "invalid";
      if (outcome === "failed") {
        report.revokeFailed++;
        continue;
      }
      await db.prepare("DELETE FROM youtube_revocations WHERE refresh_token_enc = ?").bind(r.refresh_token_enc).run();
      report.revoked++;
    }
  }

  // 2. Expired connect tickets.
  await db.prepare("DELETE FROM youtube_connect_tickets WHERE expires_at < ?").bind(now).run();

  // 3. The 30-day re-check (YouTube API Services developer policies).
  if (cfg) {
    const { results: due } = await db
      .prepare("SELECT user_id FROM youtube_connections WHERE status = 'ok' AND verified_at < ? LIMIT ?")
      .bind(now - RECHECK_AFTER_MS, SWEEP_RECHECKS)
      .all<{ user_id: number }>();
    for (const c of due) {
      // A forced refresh asks Google whether the grant still stands; success
      // bumps verified_at, an invalid_grant marks it revoked.
      await accessTokenFor(env, cfg, c.user_id, now, f, { force: true });
      report.connectionsChecked++;
    }
  }
  // A connection revoked this long ago goes; its trigger leaves the
  // revocation row for step 1.
  const gone = await db
    .prepare("DELETE FROM youtube_connections WHERE status = 'revoked' AND updated_at < ?")
    .bind(now - RECHECK_AFTER_MS)
    .run();
  report.connectionsDeleted = gone.meta.changes ?? 0;

  const { results: videos } = await db
    .prepare(
      "SELECT id, user_id, video_id FROM youtube_uploads WHERE status = 'done' AND (verified_at IS NULL OR verified_at < ?) LIMIT ?"
    )
    .bind(now - RECHECK_AFTER_MS, SWEEP_RECHECKS)
    .all<{ id: number; user_id: number; video_id: string | null }>();
  for (const v of videos) {
    report.videosChecked++;
    const token = cfg ? await accessTokenFor(env, cfg, v.user_id, now, f) : { kind: "none" as const };
    if (token.kind === "error") continue;
    // No usable grant: we can't re-check it, so we don't keep it.
    const state = token.kind === "ok" && v.video_id ? await videoState(token.token, v.video_id, f) : "gone";
    if (state === "gone") {
      await db.prepare("DELETE FROM youtube_uploads WHERE id = ?").bind(v.id).run();
      report.videosDeleted++;
    } else {
      // Present — or a video the upload-only scope can't see, which leaves
      // the grant (just refreshed) as the thing re-checked.
      await db.prepare("UPDATE youtube_uploads SET verified_at = ? WHERE id = ?").bind(now, v.id).run();
    }
  }

  // 4. Stopped uploads fail; lost messages are sent again.
  const stalled = await db
    .prepare(
      `UPDATE youtube_uploads SET status = 'failed', error = ?, session_url_enc = NULL, lease_until = NULL, updated_at = ?
        WHERE status = 'uploading' AND updated_at < ?`
    )
    .bind(TEXT.stalled, now, now - DEAD_UPLOAD_MS)
    .run();
  report.stalled = stalled.meta.changes ?? 0;
  if (env.YOUTUBE_QUEUE) {
    const { results: lost } = await db
      .prepare(
        `UPDATE youtube_uploads SET updated_at = ?1
          WHERE status IN ('queued', 'uploading') AND updated_at < ?2 AND (lease_until IS NULL OR lease_until < ?1)
          RETURNING id`
      )
      .bind(now, now - STALE_STEP_MS)
      .all<{ id: number }>();
    for (const r of lost) {
      try {
        await env.YOUTUBE_QUEUE.send({ upload_id: r.id });
        report.requeued++;
      } catch (err) {
        console.error("youtube requeue failed:", r.id, err instanceof Error ? err.message : err);
      }
    }
  }

  // The budget's old days.
  await db.prepare("DELETE FROM youtube_daily WHERE day < ?").bind(pacificDay(now - 7 * 24 * 60 * 60 * 1000)).run();
  return report;
}
