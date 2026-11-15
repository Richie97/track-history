// Coach comments on sessions and laps (NS-52,
// docs/specs/native/NS-52-coach-comments.md): the pure half — how a thread is
// grouped and ordered, where a placed comment is, and every fixed sentence, so
// no client words one differently. Dateless in the way ported logic here is:
// anything that says a calendar date takes the client's own formatter.
// Ported as `Comments` to the iOS Kit and Android `:core` under the same
// names; pinned for both by contracts/logic/comments.json.

import { cornerPlace } from "./video-sync.js";
import { fmtDist } from "./units.js";

// Mirrors COMMENT_MAX_CHARS in src/lib/comments.ts — code points, after
// trimming — and pinned to it by test/unit/comments-client.test.js.
export const COMMENT_MAX_CHARS = 1000;

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// How many characters a draft is, the way the server counts them.
export const commentLength = (text) => [...String(text ?? "").replace(/\r\n?/g, "\n").trim()].length;

// The comments on an event split into one thread per coach, in the order each
// coach first spoke. A coach's own read holds one thread; the owner's holds
// one per coach who has commented.
export function commentThreads(comments) {
  const byCoach = new Map();
  for (const c of comments ?? []) {
    if (!byCoach.has(c.coach_id)) byCoach.set(c.coach_id, []);
    byCoach.get(c.coach_id).push(c);
  }
  return [...byCoach].map(([coachId, list]) => ({ coach_id: coachId, comments: list }));
}

const byTime = (a, b) => a.created_at - b.created_at || a.id - b.id;

// One session's comments in reading order: what was said about the whole
// session first, then each lap's in lap order — a lap's own by place along
// the lap (an unplaced one last), then by time. A comment whose lap is no
// longer in the session is left out.
export function groupComments(comments, session) {
  const mine = (comments ?? []).filter((c) => String(c.session_id) === String(session?.id));
  const laps = [];
  for (const lap of session?.laps ?? []) {
    const list = mine
      .filter((c) => c.lap_id != null && String(c.lap_id) === String(lap.id))
      .sort((a, b) => {
        const pa = a.dist_m == null ? Infinity : a.dist_m;
        const pb = b.dist_m == null ? Infinity : b.dist_m;
        return pa - pb || byTime(a, b);
      });
    if (list.length) laps.push({ lap_id: lap.id, lap_num: lap.lap_num, time_ms: lap.time_ms, comments: list });
  }
  return { session: mine.filter((c) => c.lap_id == null).sort(byTime), laps };
}

// Counts for the markers: per session and per lap, each with how many the
// viewer has not read. A row the viewer wrote is never unread to them.
export function commentCounts(comments) {
  const bySession = {};
  const byLap = {};
  const bump = (into, key, c) => {
    const at = (into[key] ??= { count: 0, unread: 0 });
    at.count += 1;
    if (!c.mine && !c.seen) at.unread += 1;
  };
  for (const c of comments ?? []) {
    bump(bySession, c.session_id, c);
    if (c.lap_id != null) bump(byLap, c.lap_id, c);
  }
  return { bySession, byLap };
}

// What a lap's marker says aloud: "2 comments, 1 unread".
export function commentCountText(count) {
  if (!count?.count) return "";
  return `${plural(count.count, "comment")}${count.unread ? `, ${count.unread} unread` : ""}`;
}

// Where a placed comment is, in the reader's units and the session's own
// corner numbering: "in T4 · 1.24 km". `corners` is sessionCorners(channels)
// — derived when it is drawn, never stored, so it is the numbering the
// reader's own panel shows. The distance alone without corners; null with no
// place.
export function commentPlace(distM, dStepM, corners, units) {
  if (!Number.isFinite(distM)) return null;
  const dist = fmtDist(Math.round(distM), units);
  const where = dStepM > 0 ? cornerPlace(corners, distM / dStepM) : null;
  return where ? `${where} · ${dist}` : dist;
}

// The place a cursor at fractional grid index k is, as a comment stores it:
// whole metres from the line.
export function placeFromCursor(k, dStepM) {
  if (!Number.isFinite(k) || !(dStepM > 0)) return null;
  return Math.max(0, Math.round(k * dStepM));
}

// A lap's placed comments as marks along it: { id, frac, mine }, frac the
// fraction of the lap's own length, clamped — a place past the end of a lap
// that was re-imported shorter still marks its end.
export function commentMarkers(comments, lapId, lapLengthM) {
  if (!(lapLengthM > 0)) return [];
  return (comments ?? [])
    .filter((c) => c.dist_m != null && String(c.lap_id) === String(lapId))
    .map((c) => ({ id: c.id, frac: Math.max(0, Math.min(1, c.dist_m / lapLengthM)), mine: !!c.mine }))
    .sort((a, b) => a.frac - b.frac || a.id - b.id);
}

// A thread takes a reply only while its coach still has access.
export const canReply = (coach) => !!coach?.active;

// A thread's heading. The owner sees whose it is; the coach sees their own.
export function threadTitle(coach, isOwner) {
  if (!isOwner) return "Your comments";
  const name = coach?.name || "Your coach";
  return coach && !coach.active ? `${name} · no longer your coach` : name;
}

export const COMMENTS_HEADING = "Comments";
export const COMMENT_PLACEHOLDER = "Add a comment…";
export const REPLY_PLACEHOLDER = "Reply…";
export const WHOLE_SESSION = "Whole session";
export const COMMENT_OFFLINE = "Commenting needs a connection.";
export const THREAD_CLOSED = "They no longer have access to your logbook, so this thread is closed.";
// What a coach is told before the first comment: who reads it.
export const coachAudienceNote = (studentName) =>
  `Only you and ${studentName || "this driver"} see what you write here.`;
// Under a coach's comment, for the owner: the two controls the stores ask for.
export const REPORT_LABEL = "Report";
export const REPORT_EMAIL = "eric@speedshift.io";
export const reportSubject = (commentId) => `Report a comment (#${commentId})`;
export const reportBody = (commentId) =>
  `I'd like to report comment #${commentId} on Track Evolution.\n\nWhat's wrong with it:\n`;

// What a failed send says. `status` is the server's, null when the request
// never got an answer.
export function commentError(status, message) {
  if (status == null) return COMMENT_OFFLINE;
  if (status === 429) return "Too many comments at once — try again in a minute.";
  if (status === 409) return "This session has as many comments as it can hold.";
  if (status === 404) return "That can't be commented on any more — the session or the coaching link is gone.";
  return message || "Couldn't send that comment.";
}

// When a comment was written, in words while it is recent; null once it is
// old enough that the client should say the date.
export function commentWhen(createdAt, now) {
  const ago = Math.max(0, now - createdAt);
  if (ago < MIN_MS) return "just now";
  if (ago < HOUR_MS) return `${Math.floor(ago / MIN_MS)} min ago`;
  if (ago < DAY_MS) return `${plural(Math.floor(ago / HOUR_MS), "hour")} ago`;
  if (ago < 7 * DAY_MS) return `${plural(Math.floor(ago / DAY_MS), "day")} ago`;
  return null;
}

// What a feed row is about: "Lap 6 · VIR" or "Session 2 · VIR".
export function feedTarget(row) {
  const what = row.lap_num != null ? `Lap ${row.lap_num}` : row.session_label || "a session";
  return row.track_name ? `${what} · ${row.track_name}` : what;
}

// One feed row's line. On your own logbook a coach commented; on a student's,
// the student replied.
export function feedLine(row) {
  const who = row.author?.name || (row.student ? "Your student" : "Your coach");
  return `${who} ${row.student ? "replied on" : "commented on"} ${feedTarget(row)}`;
}

// The dashboard card's one line over the feed (GET /coaching/comments), or
// null with nothing unread: the comment itself when there is one, a count
// when there are more.
export function unreadLine(feed) {
  const unread = (feed?.comments ?? []).filter((c) => !c.seen);
  const n = Math.max(feed?.unread ?? 0, unread.length);
  if (!n) return null;
  if (n === 1 && unread.length === 1) return feedLine(unread[0]);
  const people = new Set(unread.map((c) => c.author?.id));
  const only = people.size === 1 ? unread[0].author?.name : null;
  return `${n} new comments${only ? ` from ${only}` : people.size > 1 ? ` from ${people.size} people` : ""}`;
}
