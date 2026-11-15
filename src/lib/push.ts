// Push notifications for coach comments (NS-54,
// docs/specs/native/NS-54-comment-push.md): the pure half — the device
// registration's validation, the notification's words and shape, and which
// FCM answers mean a device is gone. The sender is src/push/fcm.ts; the
// routes are routes/push.ts.

import { parseServiceAccount, type ServiceAccount } from "./billing/google";

export const PUSH_PLATFORMS = ["ios", "android"] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

// Code points of the comment a notification carries. The OS truncates
// further on a locked screen; this keeps a 1,000-character comment from
// shipping whole in a payload that only ever shows two lines.
export const PUSH_BODY_MAX = 180;
// An FCM registration token is ~160 characters today; the bound only keeps a
// nonsense value out of the column.
export const PUSH_TOKEN_MAX = 4096;

export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
// The Android notification channel both the server and the app name.
export const ANDROID_CHANNEL = "coach_comments";

export type PushDevice = { platform: PushPlatform; token: string };

export function sanitizePushDevice(v: unknown): { device: PushDevice } | { error: string } {
  if (!v || typeof v !== "object") return { error: "body must be an object" };
  const { platform, token } = v as { platform?: unknown; token?: unknown };
  if (typeof platform !== "string" || !(PUSH_PLATFORMS as readonly string[]).includes(platform))
    return { error: "platform must be ios or android" };
  if (typeof token !== "string" || !token || token.length > PUSH_TOKEN_MAX || !/^[\x21-\x7E]+$/.test(token))
    return { error: "token must be a push registration token" };
  return { device: { platform: platform as PushPlatform, token } };
}

// The comment as one line: newlines become spaces, and a cut ends in an
// ellipsis. Counted in code points, so an emoji is never split in half.
export function pushExcerpt(body: string): string {
  const flat = body.replace(/\s*\n\s*/g, " ").trim();
  const chars = [...flat];
  if (chars.length <= PUSH_BODY_MAX) return flat;
  return `${chars.slice(0, PUSH_BODY_MAX - 1).join("").trimEnd()}…`;
}

// What a notification is about and who said it — the feed row's fields from
// GET /coaching/comments, which is where these words come from too.
export type CommentPushRow = {
  id: number;
  student_id: number;
  coach_id: number;
  author_id: number;
  event_id: number;
  session_id: number;
  lap_id: number | null;
  body: string;
  author_name: string | null;
  track_name: string | null;
  session_label: string | null;
  lap_num: number | null;
};

// The same words as public/js/comments.js's feedTarget / feedLine, pinned to
// them by test/unit/push.test.ts: "Lap 6 · VIR", "Sam Lee commented on …".
export function pushTarget(row: Pick<CommentPushRow, "lap_num" | "session_label" | "track_name">): string {
  const what = row.lap_num != null ? `Lap ${row.lap_num}` : row.session_label || "a session";
  return row.track_name ? `${what} · ${row.track_name}` : what;
}

// `recipientId` is the one person in the thread who did not write it. A
// coach receiving is reading a student's logbook — the student replied.
export function pushTitle(row: CommentPushRow, recipientId: number): string {
  const toCoach = recipientId !== row.student_id;
  const who = row.author_name || (toCoach ? "Your student" : "Your coach");
  return `${who} ${toCoach ? "replied on" : "commented on"} ${pushTarget(row)}`;
}

// Who a comment notifies: the other person in its thread.
export function pushRecipient(row: Pick<CommentPushRow, "student_id" | "coach_id" | "author_id">): number {
  return row.author_id === row.student_id ? row.coach_id : row.student_id;
}

// The FCM v1 `message` for one device. `data` is everything a client routes
// by — ids only, all strings (FCM's rule) — and `student_id` is there only
// when the recipient is the coach, which is what tells the app the lap is in
// a student's logbook.
export function commentPushMessage(row: CommentPushRow, device: PushDevice, recipientId: number, unread: number) {
  const thread = `event-${row.event_id}`;
  const data: Record<string, string> = {
    kind: "comment",
    comment_id: String(row.id),
    event_id: String(row.event_id),
    session_id: String(row.session_id),
  };
  if (row.lap_id != null) data.lap_id = String(row.lap_id);
  if (recipientId !== row.student_id) data.student_id = String(row.student_id);
  const notification = { title: pushTitle(row, recipientId), body: pushExcerpt(row.body) };
  return {
    token: device.token,
    notification,
    data,
    ...(device.platform === "ios"
      ? { apns: { payload: { aps: { badge: Math.max(0, unread), sound: "default", "thread-id": thread } } } }
      : { android: { priority: "HIGH" as const, notification: { channel_id: ANDROID_CHANNEL, tag: thread } } }),
  };
}

// FCM's answers that mean the token will never work again, so the device row
// goes: 404 UNREGISTERED (the app was uninstalled or the token rotated) and a
// 400 INVALID_ARGUMENT about the token itself. Anything else — an outage, a
// quota, our own credentials — is not the device's fault and keeps the row.
export function isDeadToken(status: number, body: unknown): boolean {
  if (status === 404) return true;
  const err = (body as { error?: { status?: string; message?: string; details?: { errorCode?: string }[] } } | null)?.error;
  const codes = [err?.status, ...(err?.details ?? []).map((d) => d?.errorCode)];
  if (codes.includes("UNREGISTERED")) return true;
  return status === 400 && codes.includes("INVALID_ARGUMENT") && /registration token/i.test(err?.message ?? "");
}

export type FcmServiceAccount = ServiceAccount & { project_id: string };

export function parseFcmServiceAccount(json: string | undefined): FcmServiceAccount | null {
  const sa = parseServiceAccount(json);
  if (!sa || !json) return null;
  try {
    const projectId = (JSON.parse(json) as { project_id?: unknown }).project_id;
    return typeof projectId === "string" && /^[a-z0-9-]+$/.test(projectId) ? { ...sa, project_id: projectId } : null;
  } catch {
    return null;
  }
}
