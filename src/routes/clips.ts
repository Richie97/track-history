import { Hono } from "hono";
import type { AppContext, Ctx } from "../types";
import { requireEntitlement } from "../middleware";
import {
  CLIP_PART_BYTES,
  CLIP_QUOTA_BYTES,
  STALE_UPLOAD_MS,
  SWEEP_BATCH,
  clipFilename,
  clipKey,
  partCount,
  partSize,
  signClipUrl,
  validateClipCreate,
  verifyClipUrl,
} from "../lib/clips";
import { RATE_LIMIT_RETRY_AFTER_S, withinLimit } from "../lib/ratelimit";
import type { Env } from "../types";

// Best-lap video clips (NS-45, docs/specs/native/NS-45-best-lap-clips.md).
//
// The phones cut a session's best lap out of the source video at save time and
// upload it here in CLIP_PART_BYTES parts, each streamed straight into R2's
// multipart upload over the binding — no R2 access keys in the Worker, no SigV4
// code, no CORS on the bucket, and the ordinary session/bearer auth on every
// part. Playback is a short-lived signed URL served by `clipFiles` below,
// outside /api.
//
// Tier: creating a clip and getting a URL to play or download one are Pro —
// the third stated exception to "no write route checks entitlement", after the
// setup writes and coaching invites, safe for the same reason: a clip is not a
// recording, and the session it belongs to has already saved without it. The
// part uploads and `complete` are not gated, so a driver whose Pro lapses
// mid-upload still finishes; deleting is never gated.
//
// Every refusal on another user's clip is a 404. Under the coach mount only
// GET /clips/:id/url is reachable (COACH_ROUTES in lib/coaching.ts), and it
// runs as the student with the student's tier.
export const clips = new Hono<AppContext>();

type ClipRow = {
  id: number;
  r2_key: string;
  upload_id: string | null;
  status: "uploading" | "ready";
  size_bytes: number;
  duration_ms: number;
  lap_offset_ms: number;
};

const NOT_CONFIGURED = { error: "lap video isn't available on this server" };

// What a ready clip answers as — the same four fields the event detail's
// `lap.clip` carries.
const clipBody = (r: ClipRow) => ({
  id: r.id,
  duration_ms: r.duration_ms,
  lap_offset_ms: r.lap_offset_ms,
  size_bytes: r.size_bytes,
});

function ownedClip(db: D1Database, userId: number, id: string) {
  return db
    .prepare(
      "SELECT id, r2_key, upload_id, status, size_bytes, duration_ms, lap_offset_ms FROM lap_clips WHERE id = ? AND user_id = ?"
    )
    .bind(id, userId)
    .first<ClipRow>();
}

async function uploadedParts(db: D1Database, clipId: number) {
  const { results } = await db
    .prepare("SELECT part_number, etag, size_bytes FROM lap_clip_parts WHERE clip_id = ? ORDER BY part_number")
    .bind(clipId)
    .all<{ part_number: number; etag: string; size_bytes: number }>();
  return results;
}

// Start (or resume) the upload of one lap's clip. Keyed on the session and the
// lap's time rather than a lap id, because a session POST answers only the
// session's id — the phone never learns its laps' ids. Since NS-50 a client
// also sends `lap_num`, its position in the posted session, and then both must
// match: that is what reaches the second of two laps with the same time, which
// every-lap clips meet. Without it, the lowest lap number with that time.
clips.post("/sessions/:id/clip", requireEntitlement, async (c) => {
  const userId = c.get("userId");
  const bucket = c.env.CLIPS;
  if (!bucket) return c.json(NOT_CONFIGURED, 503);
  const body = validateClipCreate(await c.req.json().catch(() => null));
  if ("error" in body) return c.json({ error: body.error }, 400);
  const db = c.env.DB;

  const lapStmt = db
    .prepare(
      `SELECT l.id AS lap_id, k.id AS clip_id, k.status, k.size_bytes, k.upload_id
         FROM laps l JOIN sessions s ON s.id = l.session_id JOIN events e ON e.id = s.event_id
         LEFT JOIN lap_clips k ON k.lap_id = l.id
        WHERE s.id = ?1 AND e.user_id = ?2 AND l.time_ms = ?3 AND (?4 IS NULL OR l.lap_num = ?4)
        ORDER BY l.lap_num LIMIT 1`
    )
    .bind(c.req.param("id"), userId, body.time_ms, body.lap_num);
  type LapClipRow = {
    lap_id: number;
    clip_id: number | null;
    status: string | null;
    size_bytes: number | null;
    upload_id: string | null;
  };
  let lap = await lapStmt.first<LapClipRow>();
  if (!lap) return c.json({ error: "not found" }, 404);

  for (let attempt = 0; attempt < 2; attempt++) {
    if (lap.clip_id != null) {
      if (lap.status === "ready") return c.json({ error: "lap already has a clip" }, 409);
      // Resume: the same cut, declared again after the app was killed or the
      // network dropped. Answer the row and the parts R2 already holds — unless
      // the row never got its multipart upload (a create that died between the
      // insert and the R2 call), which nothing could ever upload into.
      if (lap.size_bytes === body.size_bytes && lap.upload_id) {
        const parts = await uploadedParts(db, lap.clip_id);
        return c.json({
          clip_id: lap.clip_id,
          part_bytes: CLIP_PART_BYTES,
          parts: partCount(body.size_bytes),
          uploaded: parts.map((p) => p.part_number),
        });
      }
      // A different cut of the same lap, or a row with no upload behind it:
      // the old one is abandoned. Its tombstone aborts it on the next cron run.
      await db.prepare("DELETE FROM lap_clips WHERE id = ? AND status = 'uploading'").bind(lap.clip_id).run();
    }

    // Ownership is already settled by the lookup; the quota is folded into
    // the insert so two creates at once can't both slip under it, and the
    // lap's UNIQUE turns a concurrent create of the same lap into no row.
    const now = Date.now();
    const inserted = await db
      .prepare(
        `INSERT INTO lap_clips (user_id, lap_id, r2_key, status, size_bytes, duration_ms, lap_offset_ms, created_at, updated_at)
         SELECT ?1, ?2, ?3, 'uploading', ?4, ?5, ?6, ?7, ?7
          WHERE (SELECT COALESCE(SUM(size_bytes), 0) FROM lap_clips WHERE user_id = ?1) + ?4 <= ?8
         ON CONFLICT(lap_id) DO NOTHING
         RETURNING id`
      )
      .bind(
        userId,
        lap.lap_id,
        `pending/${crypto.randomUUID()}`,
        body.size_bytes,
        body.duration_ms,
        body.lap_offset_ms,
        now,
        CLIP_QUOTA_BYTES
      )
      .first<{ id: number }>();

    if (inserted) {
      const key = clipKey(userId, inserted.id);
      let uploadId: string;
      try {
        uploadId = (await bucket.createMultipartUpload(key, { httpMetadata: { contentType: "video/mp4" } })).uploadId;
      } catch (err) {
        console.error("clip createMultipartUpload failed:", err instanceof Error ? err.message : err);
        await db.prepare("DELETE FROM lap_clips WHERE id = ?").bind(inserted.id).run();
        return c.json({ error: "couldn't start the upload — try again" }, 502);
      }
      await db.prepare("UPDATE lap_clips SET r2_key = ?, upload_id = ? WHERE id = ?").bind(key, uploadId, inserted.id).run();
      return c.json(
        { clip_id: inserted.id, part_bytes: CLIP_PART_BYTES, parts: partCount(body.size_bytes), uploaded: [] },
        201
      );
    }

    // No row: either the quota refused it or another create of this lap won
    // the race. Look again — a row now on the lap is the second.
    lap = (await lapStmt.first<LapClipRow>())!;
    if (!lap || lap.clip_id == null) return c.json({ error: "clip storage full" }, 409);
  }
  return c.json({ error: "lap already has a clip" }, 409);
});

// One part, streamed into R2 and never buffered. Content-Length is required and
// must be exactly the part's size: R2 refuses to stitch parts of unequal size,
// and finding that out at `complete` would cost the whole upload.
clips.put("/clips/:id/parts/:n", async (c) => {
  const userId = c.get("userId");
  const bucket = c.env.CLIPS;
  if (!bucket) return c.json(NOT_CONFIGURED, 503);
  if (!(await withinLimit(c.env.CLIP_PARTS, `user:${userId}`))) {
    c.header("Retry-After", String(RATE_LIMIT_RETRY_AFTER_S));
    return c.json({ error: "Too many uploads in a row — try again in a minute." }, 429);
  }
  const clip = await ownedClip(c.env.DB, userId, c.req.param("id"));
  if (!clip) return c.json({ error: "not found" }, 404);
  if (clip.status !== "uploading" || !clip.upload_id) return c.json({ error: "clip already uploaded" }, 409);
  const n = Number(c.req.param("n"));
  const expected = partSize(clip.size_bytes, n);
  if (expected == null) return c.json({ error: "invalid part number" }, 400);
  const lengthHeader = c.req.header("Content-Length");
  if (lengthHeader == null) return c.json({ error: "Content-Length required" }, 411);
  if (Number(lengthHeader) !== expected)
    return c.json({ error: `part ${n} must be ${expected} bytes` }, 400);
  const stream = c.req.raw.body;
  if (!stream) return c.json({ error: `part ${n} must be ${expected} bytes` }, 400);

  let etag: string;
  try {
    const upload = bucket.resumeMultipartUpload(clip.r2_key, clip.upload_id);
    etag = (await upload.uploadPart(n, stream)).etag;
  } catch (err) {
    console.error("clip uploadPart failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "couldn't store that part — try again" }, 502);
  }
  await c.env.DB.prepare(
    `INSERT INTO lap_clip_parts (clip_id, part_number, etag, size_bytes) VALUES (?, ?, ?, ?)
     ON CONFLICT(clip_id, part_number) DO UPDATE SET etag = excluded.etag, size_bytes = excluded.size_bytes`
  )
    .bind(clip.id, n, etag, expected)
    .run();
  return c.json({ ok: true });
});

// Stitch the parts. Every part must be in, at the sizes that sum to what was
// declared; a clip already ready answers itself, so a retry after a lost
// response is harmless.
clips.post("/clips/:id/complete", async (c) => {
  const userId = c.get("userId");
  const bucket = c.env.CLIPS;
  if (!bucket) return c.json(NOT_CONFIGURED, 503);
  const clip = await ownedClip(c.env.DB, userId, c.req.param("id"));
  if (!clip) return c.json({ error: "not found" }, 404);
  if (clip.status === "ready") return c.json(clipBody(clip));
  const parts = await uploadedParts(c.env.DB, clip.id);
  const have = new Map(parts.map((p) => [p.part_number, p]));
  const total = partCount(clip.size_bytes);
  const missing: number[] = [];
  for (let n = 1; n <= total; n++) if (have.get(n)?.size_bytes !== partSize(clip.size_bytes, n)) missing.push(n);
  if (missing.length) return c.json({ error: "missing parts", missing }, 409);

  try {
    await bucket
      .resumeMultipartUpload(clip.r2_key, clip.upload_id!)
      .complete(parts.filter((p) => p.part_number <= total).map((p) => ({ partNumber: p.part_number, etag: p.etag })));
  } catch (err) {
    console.error("clip complete failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "couldn't finish the upload — try again" }, 502);
  }
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE lap_clips SET status = 'ready', upload_id = NULL, updated_at = ? WHERE id = ?").bind(
      Date.now(),
      clip.id
    ),
    c.env.DB.prepare("DELETE FROM lap_clip_parts WHERE clip_id = ?").bind(clip.id),
  ]);
  return c.json(clipBody({ ...clip, status: "ready", upload_id: null }));
});

// Free, always: a lapsed driver can remove their video. The row goes now; its
// tombstone and the cron take the object.
clips.delete("/clips/:id", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM lap_clips WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), c.get("userId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

async function readyClipUrl(c: Ctx, download: boolean) {
  const secret = c.env.CLIP_URL_SECRET;
  if (!secret || !c.env.CLIPS) return c.json(NOT_CONFIGURED, 503);
  const clip = await ownedClip(c.env.DB, c.get("userId"), c.req.param("id")!);
  if (!clip || clip.status !== "ready") return c.json({ error: "not found" }, 404);
  return signClipUrl(secret, new URL(c.req.url).origin, clip.id, Date.now(), { download });
}

// A URL that plays for an hour. Under the coach mount this is the student's
// clip, signed the same way: /clips/* doesn't know who asked, which is why
// removing a coach can't recall a URL already handed out.
clips.get("/clips/:id/url", requireEntitlement, async (c) => {
  const signed = await readyClipUrl(c, false);
  return signed instanceof Response ? signed : c.json(signed);
});

// The same file as an attachment, named after its track, day and lap. A
// redirect, so a plain link (the web) and a downloading client (the phones)
// both land on the file. Not on the coach mount's table: a coach watches,
// and never downloads.
clips.get("/clips/:id/download", requireEntitlement, async (c) => {
  const signed = await readyClipUrl(c, true);
  if (signed instanceof Response) return signed;
  c.header("Cache-Control", "no-store");
  return c.redirect(signed.url, 302);
});

// ---------- /clips/<id>.mp4 — the signed URL itself --------------------------

// Outside /api, in run_worker_first. The signature is the authorization, so no
// session is consulted — which is what lets a player that sends no cookies
// (AirPlay, a cast receiver) play it. A bad or expired signature is a 403 that
// says nothing about whether the clip exists.
export const clipFiles = new Hono<AppContext>();

clipFiles.get("/:file", async (c) => {
  const m = /^(\d{1,15})\.mp4$/.exec(c.req.param("file"));
  if (!m) return c.json({ error: "not found" }, 404);
  const id = Number(m[1]);
  const secret = c.env.CLIP_URL_SECRET;
  const bucket = c.env.CLIPS;
  if (!secret || !bucket || !(await verifyClipUrl(secret, id, c.req.query("exp"), c.req.query("sig"), Date.now())))
    return c.json({ error: "forbidden" }, 403);

  const download = c.req.query("dl") === "1";
  const row = await c.env.DB.prepare(
    `SELECT k.r2_key, l.lap_num, e.start_date, t.name AS track_name
       FROM lap_clips k JOIN laps l ON l.id = k.lap_id JOIN sessions s ON s.id = l.session_id
       JOIN events e ON e.id = s.event_id JOIN tracks t ON t.id = e.track_id
      WHERE k.id = ? AND k.status = 'ready'`
  )
    .bind(id)
    .first<{ r2_key: string; lap_num: number; start_date: string; track_name: string }>();
  if (!row) return c.json({ error: "not found" }, 404);

  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  if (download)
    headers.set("Content-Disposition", `attachment; filename="${clipFilename(row.track_name, row.start_date, row.lap_num)}"`);

  if (c.req.method === "HEAD") {
    const head = await bucket.head(row.r2_key);
    if (!head) return c.json({ error: "not found" }, 404);
    headers.set("Content-Length", String(head.size));
    headers.set("ETag", head.httpEtag);
    return new Response(null, { status: 200, headers });
  }

  let object: R2ObjectBody | R2Object | null;
  const rangeHeader = c.req.header("Range");
  try {
    object = await bucket.get(row.r2_key, rangeHeader ? { range: c.req.raw.headers } : undefined);
  } catch {
    // An unsatisfiable or malformed range.
    return new Response(null, { status: 416, headers: { "Content-Range": "bytes */*" } });
  }
  if (!object || !("body" in object)) return c.json({ error: "not found" }, 404);
  headers.set("ETag", object.httpEtag);

  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (rangeHeader && range) {
    const size = object.size;
    const offset = range.suffix != null ? Math.max(0, size - range.suffix) : (range.offset ?? 0);
    const length = range.suffix != null ? size - offset : (range.length ?? size - offset);
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
});

// ---------- the daily sweep ----------------------------------------------------

// Beside sweepOAuth in `scheduled`. Deleting a row never deletes the object
// (the tombstone trigger in migration 0032 records it), so this is where the
// bytes actually go: a tombstone with an upload id aborts that multipart
// upload, one without deletes the object. A failure leaves the tombstone for
// tomorrow. Then uploads abandoned for STALE_UPLOAD_MS are deleted, which
// tombstones them for the next run.
export async function sweepClips(env: Env, now: number): Promise<{ swept: number; failed: number; stale: number }> {
  const report = { swept: 0, failed: 0, stale: 0 };
  const bucket = env.CLIPS;
  if (bucket) {
    const { results } = await env.DB.prepare(
      "SELECT r2_key, upload_id FROM lap_clip_tombstones ORDER BY deleted_at LIMIT ?"
    )
      .bind(SWEEP_BATCH)
      .all<{ r2_key: string; upload_id: string | null }>();
    const done: string[] = [];
    for (const t of results) {
      try {
        if (t.upload_id) {
          await bucket
            .resumeMultipartUpload(t.r2_key, t.upload_id)
            .abort()
            // An upload R2 no longer knows (already aborted, or completed and
            // then deleted) has nothing left to abort.
            .catch(async () => bucket.delete(t.r2_key));
        } else {
          await bucket.delete(t.r2_key);
        }
        done.push(t.r2_key);
      } catch (err) {
        report.failed++;
        console.error("clip sweep failed:", t.r2_key, err instanceof Error ? err.message : err);
      }
    }
    for (let i = 0; i < done.length; i += 50) {
      const chunk = done.slice(i, i + 50);
      await env.DB.prepare(`DELETE FROM lap_clip_tombstones WHERE r2_key IN (${chunk.map(() => "?").join(", ")})`)
        .bind(...chunk)
        .run();
    }
    report.swept = done.length;
  }
  const stale = await env.DB.prepare("DELETE FROM lap_clips WHERE status = 'uploading' AND created_at < ?")
    .bind(now - STALE_UPLOAD_MS)
    .run();
  report.stale = stale.meta.changes ?? 0;
  return report;
}
