import { Hono } from "hono";
import type { AppContext } from "../types";
import { sanitizePushDevice } from "../lib/push";

// Registering a phone for coach-comment notifications (NS-54,
// docs/specs/native/NS-54-comment-push.md). An ordinary /api router:
//   PUT    /push/device   { platform, token } — this app session's phone
//   DELETE /push/device   — stop notifying it (Settings' toggle); idempotent
//
// A device belongs to the auth session that registered it, so signing out
// unregisters it through the cascade, and these routes need no id: the
// session *is* the device. Bearer only — the web registers nothing.
//
// Free, ungated, and a live write on every client (never queued offline).
export const push = new Hono<AppContext>();

push.put("/push/device", async (c) => {
  const authSession = c.get("authSession");
  if (c.get("authTransport") !== "bearer" || !authSession) return c.json({ error: "push needs the app" }, 400);
  const input = sanitizePushDevice(await c.req.json().catch(() => null));
  if ("error" in input) return c.json({ error: input.error }, 400);
  const { platform, token } = input.device;
  const userId = c.get("userId");
  const now = Date.now();
  // The token leaves any other session first (a shared phone; a sign-out the
  // server never saw), then this session's row is replaced — one batch, so a
  // phone is never registered to two accounts even for a moment.
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM push_devices WHERE token = ? AND auth_token <> ?").bind(token, authSession),
    c.env.DB.prepare(
      `INSERT INTO push_devices (user_id, auth_token, platform, token, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT (auth_token) DO UPDATE SET platform = excluded.platform, token = excluded.token, updated_at = excluded.updated_at`
    ).bind(userId, authSession, platform, token, now),
  ]);
  return c.json({ ok: true });
});

push.delete("/push/device", async (c) => {
  const authSession = c.get("authSession");
  if (authSession) await c.env.DB.prepare("DELETE FROM push_devices WHERE auth_token = ?").bind(authSession).run();
  return c.json({ ok: true });
});
