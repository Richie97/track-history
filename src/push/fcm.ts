// The push sender for coach comments (NS-54,
// docs/specs/native/NS-54-comment-push.md): Firebase Cloud Messaging's HTTP v1
// API, for both phones — FCM relays to APNs for iOS, so the Worker needs no
// HTTP/2 APNs client of its own.
//
// Best-effort by design: routes/comments.ts calls notifyComment through
// waitUntil after the comment's 201, so a push failure never fails or delays
// a comment, and nothing is retried. A device FCM says is gone is deleted.
//
// `fetch` is injected (the YouTube step's pattern), so test/api/push.test.ts
// scripts FCM and the token endpoint without a network.

import type { Env } from "../types";
import { googleAccessToken } from "../lib/billing/google";
import {
  FCM_SCOPE,
  commentPushMessage,
  isDeadToken,
  parseFcmServiceAccount,
  pushRecipient,
  type CommentPushRow,
  type PushPlatform,
} from "../lib/push";

export type NotifyResult = { sent: number; removed: number; failed: number };

const NOTHING: NotifyResult = { sent: 0, removed: 0, failed: 0 };

export async function notifyComment(
  env: Env,
  commentId: number,
  nowMs: number,
  fetcher: typeof fetch = fetch
): Promise<NotifyResult> {
  const sa = parseFcmServiceAccount(env.FCM_SERVICE_ACCOUNT);
  if (!sa) return NOTHING;

  const row = await env.DB.prepare(
    `SELECT c.id, c.student_id, c.coach_id, c.author_id, c.event_id, c.session_id, c.lap_id, c.body,
            a.name AS author_name, t.name AS track_name, s.label AS session_label, l.lap_num
       FROM coach_comments c
       JOIN users a ON a.id = c.author_id
       JOIN events e ON e.id = c.event_id
       JOIN tracks t ON t.id = e.track_id
       JOIN sessions s ON s.id = c.session_id
       LEFT JOIN laps l ON l.id = c.lap_id
      WHERE c.id = ?`
  )
    .bind(commentId)
    .first<CommentPushRow>();
  if (!row) return NOTHING;
  const recipient = pushRecipient(row);

  const [devices, unread] = await env.DB.batch([
    // Only devices whose session is still live: an expired session's row
    // waits for its session to be deleted, and must not be sent to meanwhile.
    // A coach receives only while the grant lasts — the insert already
    // required it, and a revoke between the two must still win.
    env.DB.prepare(
      `SELECT d.id, d.platform, d.token
         FROM push_devices d JOIN auth_sessions s ON s.token = d.auth_token
        WHERE d.user_id = ?1 AND s.expires_at > ?2
          AND (?1 = ?3 OR EXISTS (SELECT 1 FROM coach_grants g WHERE g.student_id = ?3 AND g.coach_id = ?1))`
    ).bind(recipient, nowMs, row.student_id),
    // The iOS badge: the recipient's unread count, the same as GET /me's.
    env.DB.prepare(
      `SELECT COUNT(*) AS unread FROM coach_comments c
        WHERE c.author_id <> ?1 AND c.seen_at IS NULL
          AND (c.student_id = ?1
               OR (c.coach_id = ?1 AND EXISTS (SELECT 1 FROM coach_grants g WHERE g.student_id = c.student_id AND g.coach_id = ?1)))`
    ).bind(recipient),
  ]);
  const targets = devices.results as { id: number; platform: PushPlatform; token: string }[];
  if (!targets.length) return NOTHING;
  const count = (unread.results[0] as { unread: number }).unread;

  let accessToken: string;
  try {
    accessToken = await googleAccessToken(sa, nowMs, FCM_SCOPE, fetcher);
  } catch (err) {
    console.error("push: FCM token exchange failed", err);
    return { ...NOTHING, failed: targets.length };
  }

  const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
  const results = await Promise.all(
    targets.map(async (d) => {
      try {
        const res = await fetcher(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ message: commentPushMessage(row, d, recipient, count) }),
        });
        if (res.ok) return "sent" as const;
        const body = await res.json().catch(() => null);
        if (isDeadToken(res.status, body)) return d.id;
        console.error("push: FCM send failed", res.status, JSON.stringify(body));
        return "failed" as const;
      } catch (err) {
        console.error("push: FCM send failed", err);
        return "failed" as const;
      }
    })
  );

  const dead = results.filter((r): r is number => typeof r === "number");
  if (dead.length) {
    await env.DB.prepare(`DELETE FROM push_devices WHERE id IN (${dead.map(() => "?").join(",")})`)
      .bind(...dead)
      .run();
  }
  return {
    sent: results.filter((r) => r === "sent").length,
    removed: dead.length,
    failed: results.filter((r) => r === "failed").length,
  };
}
