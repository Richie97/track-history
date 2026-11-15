import { Hono } from "hono";
import type { AppContext, Ctx } from "../types";
import {
  FEED_LIMIT,
  MAX_THREAD_COMMENTS,
  commentView,
  sanitizeComment,
  sanitizeCommentBody,
  type CommentInput,
  type CommentRow,
} from "../lib/comments";
import { RATE_LIMIT_RETRY_AFTER_S, withinLimit } from "../lib/ratelimit";
import { notifyComment } from "../push/fcm";

// Coach comments on sessions and laps (NS-52,
// docs/specs/native/NS-52-coach-comments.md). An ordinary /api router: the
// caller is always themselves here, never a student seen through the coach
// mount, which stays GET-only and knows nothing of this file.
//
// The owner, on their own logbook:
//   GET  /events/:id/comments          every thread on the event
//   POST /sessions/:id/comments        a reply into one coach's thread
//   POST /events/:id/comments/seen
// A coach, on a student's — every statement joined to coach_grants, and no
// grant is a 404, never a 403, which would confirm the student exists:
//   GET  /coaching/students/:sid/events/:eid/comments     their thread only
//   POST /coaching/students/:sid/sessions/:id/comments
//   POST /coaching/students/:sid/events/:eid/comments/seen
// Either, on one row:
//   PUT    /comments/:id               the author
//   DELETE /comments/:id               the author, or the logbook's owner
// And both roles at once:
//   GET  /coaching/comments            what was said to the caller, newest first
//
// One private thread per coach: a row's coach_id is whose conversation it is,
// and a coach's statements always carry `coach_id = <caller>`, so one coach
// can never read, count or infer another's thread.
//
// Free on both sides — nothing here checks entitlement. Live writes: no client
// queues one offline.
export const comments = new Hono<AppContext>();

const NOT_FOUND = { error: "not found" } as const;

const SELECT = `SELECT c.id, c.student_id, c.coach_id, c.author_id, c.event_id, c.session_id, c.lap_id, c.dist_m,
                       c.body, c.created_at, c.edited_at, c.seen_at, a.name AS author_name, a.picture AS author_picture
                  FROM coach_comments c JOIN users a ON a.id = c.author_id`;

// A path id: a positive integer, or null — which every caller answers as 404.
const idParam = (raw: string | undefined) => (raw && /^\d{1,15}$/.test(raw) ? Number(raw) : null);

const limited = (c: Ctx) =>
  c.json({ error: "too many comments — try again in a minute" }, 429, { "Retry-After": String(RATE_LIMIT_RETRY_AFTER_S) });

// The rows a user has not read: written by someone else, in a thread they can
// currently read — their own logbook's, or a student's while the grant lasts.
const ADDRESSED = `c.author_id <> ?1
   AND (c.student_id = ?1
        OR (c.coach_id = ?1 AND EXISTS (SELECT 1 FROM coach_grants g WHERE g.student_id = c.student_id AND g.coach_id = ?1)))`;

// How many comments are waiting for a user, both roles together — `GET /me`'s
// `comments_unread`, joined into its batch.
export function unreadCommentsStmt(db: D1Database, userId: number) {
  return db.prepare(`SELECT COUNT(*) AS unread FROM coach_comments c WHERE ${ADDRESSED} AND c.seen_at IS NULL`).bind(userId);
}

// Insert one comment. The ownership of the session, the lap belonging to it,
// the live grant and the per-thread cap are all in the statement, so zero rows
// means one of them failed and nothing was written. `coach_id`, `author_id`
// and `event_id` come from the caller and the session, never from the body.
async function insertComment(
  c: Ctx,
  ids: { studentId: number; coachId: number; sessionId: number },
  input: CommentInput
) {
  const authorId = c.get("userId");
  const row = await c.env.DB.prepare(
    `INSERT INTO coach_comments (student_id, coach_id, author_id, event_id, session_id, lap_id, dist_m, body, created_at)
     SELECT e.user_id, g.coach_id, ?3, e.id, s.id, ?5, ?6, ?7, ?8
       FROM sessions s
       JOIN events e ON e.id = s.event_id
       JOIN coach_grants g ON g.student_id = e.user_id AND g.coach_id = ?2
      WHERE s.id = ?4 AND e.user_id = ?1
        AND (?5 IS NULL OR EXISTS (SELECT 1 FROM laps l WHERE l.id = ?5 AND l.session_id = s.id))
        AND (SELECT COUNT(*) FROM coach_comments x WHERE x.session_id = s.id AND x.coach_id = g.coach_id) < ?9
     RETURNING id`
  )
    .bind(ids.studentId, ids.coachId, authorId, ids.sessionId, input.lap_id, input.dist_m, input.body, Date.now(), MAX_THREAD_COMMENTS)
    .first<{ id: number }>();
  if (!row) {
    // Tell a full thread from everything else, which is a 404. The count is
    // scoped to the caller's own thread, so it confirms nothing they couldn't
    // already read.
    const full = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM coach_comments x
        WHERE x.session_id = ?1 AND x.student_id = ?2 AND x.coach_id = ?3
          AND EXISTS (SELECT 1 FROM coach_grants g WHERE g.student_id = ?2 AND g.coach_id = ?3)`
    )
      .bind(ids.sessionId, ids.studentId, ids.coachId)
      .first<{ n: number }>();
    if ((full?.n ?? 0) >= MAX_THREAD_COMMENTS) return c.json({ error: "too many comments on this session" }, 409);
    return c.json(NOT_FOUND, 404);
  }
  const created = await c.env.DB.prepare(`${SELECT} WHERE c.id = ?`).bind(row.id).first<CommentRow>();
  // Tell the other person in the thread (NS-54) — after the write, outside
  // the response, so a push failure never touches the comment.
  c.executionCtx.waitUntil(notifyComment(c.env, row.id, Date.now()).catch((err) => console.error("push:", err)));
  return c.json({ comment: commentView(created!, authorId) }, 201);
}

// --- the owner ---------------------------------------------------------------

comments.get("/events/:id/comments", async (c) => {
  const userId = c.get("userId");
  const eventId = idParam(c.req.param("id"));
  if (eventId == null) return c.json(NOT_FOUND, 404);
  const [owned, rows, coaches] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT 1 FROM events WHERE id = ? AND user_id = ?").bind(eventId, userId),
    c.env.DB.prepare(`${SELECT} WHERE c.event_id = ? AND c.student_id = ? ORDER BY c.created_at, c.id`).bind(eventId, userId),
    // Each thread's coach, and whether they can still read it: a closed
    // thread shows no reply box.
    c.env.DB.prepare(
      `SELECT u.id, u.name, u.picture,
              EXISTS (SELECT 1 FROM coach_grants g WHERE g.student_id = ?2 AND g.coach_id = u.id) AS active
         FROM users u
        WHERE u.id IN (SELECT DISTINCT coach_id FROM coach_comments WHERE event_id = ?1 AND student_id = ?2)
        ORDER BY u.name COLLATE NOCASE, u.id`
    ).bind(eventId, userId),
  ]);
  if (!owned.results.length) return c.json(NOT_FOUND, 404);
  return c.json({
    comments: (rows.results as CommentRow[]).map((r) => commentView(r, userId)),
    coaches: (coaches.results as { id: number; name: string | null; picture: string | null; active: number }[]).map((u) => ({
      id: u.id,
      name: u.name,
      picture: u.picture,
      active: Boolean(u.active),
    })),
  });
});

comments.post("/sessions/:id/comments", async (c) => {
  const userId = c.get("userId");
  const sessionId = idParam(c.req.param("id"));
  const body = await c.req.json().catch(() => null);
  const input = sanitizeComment(body);
  if ("error" in input) return c.json({ error: input.error }, 400);
  const coachId = (body as { coach_id?: unknown }).coach_id;
  if (typeof coachId !== "number" || !Number.isInteger(coachId) || coachId <= 0)
    return c.json({ error: "coach_id must be the coach you are replying to" }, 400);
  if (sessionId == null) return c.json(NOT_FOUND, 404);
  if (!(await withinLimit(c.env.COACH_COMMENTS, String(userId)))) return limited(c);
  return insertComment(c, { studentId: userId, coachId, sessionId }, input.comment);
});

comments.post("/events/:id/comments/seen", async (c) => {
  const userId = c.get("userId");
  const eventId = idParam(c.req.param("id"));
  if (eventId == null) return c.json(NOT_FOUND, 404);
  const res = await c.env.DB.prepare(
    "UPDATE coach_comments SET seen_at = ?1 WHERE event_id = ?2 AND student_id = ?3 AND author_id <> ?3 AND seen_at IS NULL"
  )
    .bind(Date.now(), eventId, userId)
    .run();
  return c.json({ ok: true, seen: res.meta.changes ?? 0 });
});

// --- a coach -------------------------------------------------------------------

comments.get("/coaching/students/:sid/events/:eid/comments", async (c) => {
  const userId = c.get("userId");
  const studentId = idParam(c.req.param("sid"));
  const eventId = idParam(c.req.param("eid"));
  if (studentId == null || eventId == null) return c.json(NOT_FOUND, 404);
  const [granted, rows] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT 1 FROM coach_grants g JOIN events e ON e.user_id = g.student_id
        WHERE g.student_id = ? AND g.coach_id = ? AND e.id = ?`
    ).bind(studentId, userId, eventId),
    // coach_id = the caller, always: another coach's thread is not in reach.
    c.env.DB.prepare(
      `${SELECT} WHERE c.event_id = ? AND c.student_id = ? AND c.coach_id = ? ORDER BY c.created_at, c.id`
    ).bind(eventId, studentId, userId),
  ]);
  if (!granted.results.length) return c.json(NOT_FOUND, 404);
  return c.json({ comments: (rows.results as CommentRow[]).map((r) => commentView(r, userId)) });
});

comments.post("/coaching/students/:sid/sessions/:id/comments", async (c) => {
  const userId = c.get("userId");
  const studentId = idParam(c.req.param("sid"));
  const sessionId = idParam(c.req.param("id"));
  const input = sanitizeComment(await c.req.json().catch(() => null));
  if ("error" in input) return c.json({ error: input.error }, 400);
  if (studentId == null || sessionId == null) return c.json(NOT_FOUND, 404);
  if (!(await withinLimit(c.env.COACH_COMMENTS, String(userId)))) return limited(c);
  return insertComment(c, { studentId, coachId: userId, sessionId }, input.comment);
});

comments.post("/coaching/students/:sid/events/:eid/comments/seen", async (c) => {
  const userId = c.get("userId");
  const studentId = idParam(c.req.param("sid"));
  const eventId = idParam(c.req.param("eid"));
  if (studentId == null || eventId == null) return c.json(NOT_FOUND, 404);
  const [granted, updated] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT 1 FROM coach_grants WHERE student_id = ? AND coach_id = ?").bind(studentId, userId),
    c.env.DB.prepare(
      `UPDATE coach_comments SET seen_at = ?1
        WHERE event_id = ?2 AND student_id = ?3 AND coach_id = ?4 AND author_id <> ?4 AND seen_at IS NULL
          AND EXISTS (SELECT 1 FROM coach_grants g WHERE g.student_id = ?3 AND g.coach_id = ?4)`
    ).bind(Date.now(), eventId, studentId, userId),
  ]);
  if (!granted.results.length) return c.json(NOT_FOUND, 404);
  return c.json({ ok: true, seen: updated.meta.changes ?? 0 });
});

// --- one row ---------------------------------------------------------------------

// A coach author needs the grant still; the owner's own replies are theirs to
// change whether or not the thread is open.
const LIVE_AUTHOR = `author_id = ?2
   AND (author_id = student_id
        OR EXISTS (SELECT 1 FROM coach_grants g
                    WHERE g.student_id = coach_comments.student_id AND g.coach_id = coach_comments.coach_id))`;

comments.put("/comments/:id", async (c) => {
  const userId = c.get("userId");
  const id = idParam(c.req.param("id"));
  const body = await c.req.json().catch(() => null);
  const text = sanitizeCommentBody((body as { body?: unknown } | null)?.body);
  if ("error" in text) return c.json({ error: text.error }, 400);
  if (id == null) return c.json(NOT_FOUND, 404);
  if (!(await withinLimit(c.env.COACH_COMMENTS, String(userId)))) return limited(c);
  const res = await c.env.DB.prepare(`UPDATE coach_comments SET body = ?3, edited_at = ?4 WHERE id = ?1 AND ${LIVE_AUTHOR}`)
    .bind(id, userId, text.body, Date.now())
    .run();
  if (!res.meta.changes) return c.json(NOT_FOUND, 404);
  const row = await c.env.DB.prepare(`${SELECT} WHERE c.id = ?`).bind(id).first<CommentRow>();
  return c.json({ comment: commentView(row!, userId) });
});

// The author takes back their own; the owner removes anything said in their
// logbook — that is the moderation.
comments.delete("/comments/:id", async (c) => {
  const userId = c.get("userId");
  const id = idParam(c.req.param("id"));
  if (id == null) return c.json(NOT_FOUND, 404);
  const res = await c.env.DB.prepare(`DELETE FROM coach_comments WHERE id = ?1 AND (student_id = ?2 OR (${LIVE_AUTHOR}))`)
    .bind(id, userId)
    .run();
  if (!res.meta.changes) return c.json(NOT_FOUND, 404);
  return c.json({ ok: true });
});

// --- the feed ----------------------------------------------------------------------

type FeedRow = CommentRow & {
  student_name: string | null;
  track_name: string | null;
  start_date: string;
  session_label: string | null;
  lap_num: number | null;
};

comments.get("/coaching/comments", async (c) => {
  const userId = c.get("userId");
  const [unread, rows] = await c.env.DB.batch([
    unreadCommentsStmt(c.env.DB, userId),
    c.env.DB.prepare(
      `SELECT c.id, c.student_id, c.coach_id, c.author_id, c.event_id, c.session_id, c.lap_id, c.dist_m,
              c.body, c.created_at, c.edited_at, c.seen_at, a.name AS author_name, a.picture AS author_picture,
              st.name AS student_name, t.name AS track_name, e.start_date, s.label AS session_label, l.lap_num
         FROM coach_comments c
         JOIN users a ON a.id = c.author_id
         JOIN users st ON st.id = c.student_id
         JOIN events e ON e.id = c.event_id
         JOIN tracks t ON t.id = e.track_id
         JOIN sessions s ON s.id = c.session_id
         LEFT JOIN laps l ON l.id = c.lap_id
        WHERE ${ADDRESSED}
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ?2`
    ).bind(userId, FEED_LIMIT),
  ]);
  return c.json({
    unread: (unread.results[0] as { unread: number }).unread,
    comments: (rows.results as FeedRow[]).map((r) => ({
      ...commentView(r, userId),
      // null when the logbook is the caller's own, so a client knows which
      // logbook the link opens in.
      student: r.student_id === userId ? null : { id: r.student_id, name: r.student_name },
      event_id: r.event_id,
      track_name: r.track_name,
      start_date: r.start_date,
      session_label: r.session_label,
      lap_num: r.lap_num ?? null,
    })),
  });
});
