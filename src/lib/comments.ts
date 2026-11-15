// Coach comments on sessions and laps (NS-52,
// docs/specs/native/NS-52-coach-comments.md): the pure half — the limits, the
// body's validation and the response row. The routes are routes/comments.ts.
//
// public/js/comments.js mirrors COMMENT_MAX_CHARS for the composer's counter;
// test/unit/comments.test.ts pins the two together.

// Code points after trimming, not UTF-16 units: an emoji is one character to
// the person typing it.
export const COMMENT_MAX_CHARS = 1000;
// Metres from the start/finish line. No circuit lap is 100 km; the bound only
// keeps a nonsense value out of the column.
export const MAX_DIST_M = 100_000;
// Per coach, per session — both sides' rows together. A conversation that
// long has outgrown a comment thread.
export const MAX_THREAD_COMMENTS = 200;
// Rows the feed answers.
export const FEED_LIMIT = 50;

export type CommentInput = { body: string; lap_id: number | null; dist_m: number | null };
export type CommentResult = { comment: CommentInput } | { error: string };

// Anything a text field cannot show: C0 controls other than the newline, and
// DEL. A tab is refused with them rather than guessed at.
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F]/;

// The body alone — what an edit sends.
export function sanitizeCommentBody(v: unknown): { body: string } | { error: string } {
  if (typeof v !== "string") return { error: "body must be text" };
  const body = v.replace(/\r\n?/g, "\n").trim();
  if (!body) return { error: "a comment can't be empty" };
  if (CONTROL.test(body)) return { error: "a comment can't contain control characters" };
  if ([...body].length > COMMENT_MAX_CHARS) return { error: `a comment can be at most ${COMMENT_MAX_CHARS} characters` };
  return { body };
}

const positiveInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;

// A new comment: the body, and where on the session it is said — the whole
// session (no lap), a lap, or a place on a lap. Unknown keys are dropped; a
// present key that fails its rule rejects the body and says which rule.
export function sanitizeComment(v: unknown): CommentResult {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "comment must be an object" };
  const o = v as Record<string, unknown>;
  const text = sanitizeCommentBody(o.body);
  if ("error" in text) return text;
  const lapId = o.lap_id ?? null;
  if (lapId !== null && !positiveInt(lapId)) return { error: "lap_id must be a lap's id" };
  const distM = o.dist_m ?? null;
  if (distM !== null) {
    if (typeof distM !== "number" || !Number.isInteger(distM) || distM < 0 || distM > MAX_DIST_M)
      return { error: `dist_m must be whole metres from 0 to ${MAX_DIST_M}` };
    if (lapId === null) return { error: "a place needs a lap" };
  }
  return { comment: { body: text.body, lap_id: lapId as number | null, dist_m: distM as number | null } };
}

// A comment as D1 hands it over, joined to its author.
export type CommentRow = {
  id: number;
  student_id: number;
  coach_id: number;
  author_id: number;
  event_id: number;
  session_id: number;
  lap_id: number | null;
  dist_m: number | null;
  body: string;
  created_at: number;
  edited_at: number | null;
  seen_at: number | null;
  author_name: string | null;
  author_picture: string | null;
};

export type CommentView = {
  id: number;
  coach_id: number;
  session_id: number;
  lap_id: number | null;
  dist_m: number | null;
  body: string;
  created_at: number;
  edited_at: number | null;
  author: { id: number; name: string | null; picture: string | null };
  mine: boolean;
  seen: boolean;
};

// The response row, built by allow-list (the publicLapChannels rule), so a
// column added to the table later stays private until it is added here — and
// never an email. `mine` is whether the viewer wrote it. `seen` is whether its
// one reader has: on a row the viewer wrote it is the read receipt, on any
// other it is the viewer's own unread mark.
export function commentView(row: CommentRow, viewerId: number): CommentView {
  return {
    id: row.id,
    coach_id: row.coach_id,
    session_id: row.session_id,
    lap_id: row.lap_id ?? null,
    dist_m: row.dist_m ?? null,
    body: row.body,
    created_at: row.created_at,
    edited_at: row.edited_at ?? null,
    author: { id: row.author_id, name: row.author_name ?? null, picture: row.author_picture ?? null },
    mine: row.author_id === viewerId,
    seen: row.seen_at != null,
  };
}
