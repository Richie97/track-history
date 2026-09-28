import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppContext } from "../types";
import { requireEntitlement } from "../middleware";
import { SESSION_COOKIE, bearerToken, randomToken, sha256Hex } from "../lib/session";
import {
  INVITE_TTL_MS,
  MAX_COACHES,
  MAX_OPEN_INVITES,
  VIEW_TOUCH_MS,
  coachRoute,
} from "../lib/coaching";

// Share with a coach (NS-38, docs/specs/native/NS-38-coach-sharing.md).
//
// Two halves. `coaching` is the authed management router under /api — invites,
// the grants in both directions, revoking — mounted by apiApp like every other
// router. `requireCoachGrant` is the middleware of a *third* apiApp instance,
// mounted at /api/students/:id (index.ts), which is how a coach reads: the
// ordinary routes run as the student, with the student's tier, GET only,
// behind the allow-list in lib/coaching.ts.

export const coaching = new Hono<AppContext>();

type GrantRow = { id: number; name: string | null; picture: string | null; since: number };

coaching.get("/coaching", async (c) => {
  const userId = c.get("userId");
  const [coachesRes, studentsRes, invitesRes] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT u.id, u.name, u.picture, g.created_at AS since, g.last_viewed_at
         FROM coach_grants g JOIN users u ON u.id = g.coach_id
        WHERE g.student_id = ?
        ORDER BY g.created_at`
    ).bind(userId),
    // Past events only, on the totals' rule (userTotalsStmt in db.ts).
    c.env.DB.prepare(
      `SELECT u.id, u.name, u.picture, g.created_at AS since,
              (SELECT COUNT(*) FROM events e WHERE e.user_id = u.id AND e.start_date <= date('now')) AS event_count,
              (SELECT MAX(e.start_date) FROM events e WHERE e.user_id = u.id AND e.start_date <= date('now')) AS last_event_date
         FROM coach_grants g JOIN users u ON u.id = g.student_id
        WHERE g.coach_id = ?
        ORDER BY u.name COLLATE NOCASE, u.id`
    ).bind(userId),
    c.env.DB.prepare(
      "SELECT id, created_at, expires_at FROM coach_invites WHERE student_id = ? AND expires_at > ? ORDER BY created_at DESC"
    ).bind(userId, Date.now()),
  ]);
  return c.json({
    coaches: coachesRes.results as (GrantRow & { last_viewed_at: number | null })[],
    students: studentsRes.results as (GrantRow & { event_count: number; last_event_date: string | null })[],
    invites: invitesRes.results,
  });
});

// Mint an invite link. Pro, because what it shares is the analysis Pro pays
// for — and a stated exception to "no write route checks entitlement", on the
// setups rule: an invite is not a recording, and a refused one costs a tap.
// The token is shown this once; only its hash is stored.
coaching.post("/coaching/invites", requireEntitlement, async (c) => {
  const userId = c.get("userId");
  const now = Date.now();
  const counts = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM coach_invites WHERE student_id = ?1 AND expires_at > ?2) AS invites,
            (SELECT COUNT(*) FROM coach_grants WHERE student_id = ?1) AS coaches`
  )
    .bind(userId, now)
    .first<{ invites: number; coaches: number }>();
  if (counts!.coaches >= MAX_COACHES)
    return c.json({ error: `you already have ${MAX_COACHES} coaches — remove one to invite another` }, 409);
  if (counts!.invites >= MAX_OPEN_INVITES)
    return c.json({ error: `you have ${MAX_OPEN_INVITES} unused invites — withdraw one first` }, 409);

  const token = randomToken();
  const expiresAt = now + INVITE_TTL_MS;
  const row = await c.env.DB.prepare(
    "INSERT INTO coach_invites (student_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?) RETURNING id"
  )
    .bind(userId, await sha256Hex(token), now, expiresAt)
    .first<{ id: number }>();
  return c.json({ id: row!.id, url: new URL(`/coach/${token}`, c.req.url).toString(), expires_at: expiresAt }, 201);
});

coaching.delete("/coaching/invites/:id", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM coach_invites WHERE id = ? AND student_id = ?")
    .bind(c.req.param("id"), c.get("userId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

type InviteLookup = {
  id: number;
  student_id: number;
  name: string | null;
  picture: string | null;
  expires_at: number;
  already: number | null;
  coaches: number;
};

// An invite as the person opening the link sees it: whose logbook, and
// whether accepting would work. One statement.
async function lookupInvite(db: D1Database, token: string, coachId: number) {
  return db
    .prepare(
      `SELECT i.id, i.student_id, u.name, u.picture, i.expires_at,
              (SELECT 1 FROM coach_grants g WHERE g.student_id = i.student_id AND g.coach_id = ?1) AS already,
              (SELECT COUNT(*) FROM coach_grants g WHERE g.student_id = i.student_id) AS coaches
         FROM coach_invites i JOIN users u ON u.id = i.student_id
        WHERE i.token_hash = ?2 AND i.expires_at > ?3`
    )
    .bind(coachId, await sha256Hex(token), Date.now())
    .first<InviteLookup>();
}

const GONE = "this invite link has expired or has already been used — ask for a new one";

coaching.get("/coaching/invites/:token", async (c) => {
  const userId = c.get("userId");
  const invite = await lookupInvite(c.env.DB, c.req.param("token"), userId);
  if (!invite) return c.json({ error: GONE }, 404);
  return c.json({
    student: { id: invite.student_id, name: invite.name, picture: invite.picture },
    expires_at: invite.expires_at,
    own: invite.student_id === userId,
    already_coach: Boolean(invite.already),
  });
});

coaching.post("/coaching/invites/:token/accept", async (c) => {
  const userId = c.get("userId");
  const invite = await lookupInvite(c.env.DB, c.req.param("token"), userId);
  if (!invite) return c.json({ error: GONE }, 404);
  // Refused without burning the link, so the student can still send it on.
  if (invite.student_id === userId) return c.json({ error: "that's your own invite — send it to your coach" }, 400);
  if (invite.already) return c.json({ error: "you're already a coach of this driver" }, 409);
  if (invite.coaches >= MAX_COACHES) return c.json({ error: "this driver already has the most coaches allowed" }, 409);

  // Burn the link first: of two people accepting at once, exactly one deletes
  // the row, and only they get the grant.
  const burned = await c.env.DB.prepare("DELETE FROM coach_invites WHERE id = ? RETURNING id").bind(invite.id).first();
  if (!burned) return c.json({ error: GONE }, 404);
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO coach_grants (student_id, coach_id, created_at) VALUES (?, ?, ?)"
  )
    .bind(invite.student_id, userId, Date.now())
    .run();
  return c.json({ student: { id: invite.student_id, name: invite.name, picture: invite.picture } }, 201);
});

// The student revokes a coach. Takes effect on that coach's next request:
// the grant is read on every one, never cached.
coaching.delete("/coaching/coaches/:coachId", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM coach_grants WHERE student_id = ? AND coach_id = ?")
    .bind(c.get("userId"), c.req.param("coachId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// The coach stops coaching a student.
coaching.delete("/coaching/students/:studentId", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM coach_grants WHERE coach_id = ? AND student_id = ?")
    .bind(c.get("userId"), c.req.param("studentId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// --- the coach's read path -------------------------------------------------

const STUDENT_PATH = /^\/api\/students\/(\d+)(\/.*)$/;

// Resolves the caller's session *and* their grant over the student in one
// statement, then runs the rest of the chain as the student:
//
//   - no session → 401, exactly as /api answers;
//   - no grant, a method other than GET, or a path off the allow-list → 404,
//     never 403 — a 403 would confirm the student exists;
//   - otherwise userId is the student and entitledUntil is the *student's*, so
//     stripProFields decides `channels` by the tier of the person who paid,
//     and the response passes through the path's view on the way out.
export const requireCoachGrant = createMiddleware<AppContext>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization")) || getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "unauthorized" }, 401);
  const match = STUDENT_PATH.exec(c.req.path);
  const studentId = match ? Number(match[1]) : 0;
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT s.user_id AS coach_id, g.id AS grant_id, g.last_viewed_at, u.entitled_until
       FROM auth_sessions s
       LEFT JOIN coach_grants g ON g.coach_id = s.user_id AND g.student_id = ?
       LEFT JOIN users u ON u.id = g.student_id
      WHERE s.token = ? AND s.expires_at > ?`
  )
    .bind(studentId, await sha256Hex(token), now)
    .first<{ coach_id: number; grant_id: number | null; last_viewed_at: number | null; entitled_until: number | null }>();
  if (!row) return c.json({ error: "unauthorized" }, 401);

  const view = row.grant_id && match ? coachRoute(c.req.method, match[2]) : null;
  if (!view) return c.json({ error: "not found" }, 404);

  c.set("userId", studentId);
  c.set("entitledUntil", row.entitled_until ?? null);
  await next();

  if (row.last_viewed_at == null || row.last_viewed_at < now - VIEW_TOUCH_MS) {
    const touch = c.env.DB.prepare("UPDATE coach_grants SET last_viewed_at = ? WHERE id = ?")
      .bind(now, row.grant_id)
      .run()
      .catch(() => {});
    try {
      c.executionCtx.waitUntil(touch);
    } catch {
      await touch;
    }
  }

  if (c.res.status !== 200 || !c.res.headers.get("Content-Type")?.includes("application/json")) return;
  const body = await c.res.json();
  const headers = new Headers(c.res.headers);
  headers.delete("Content-Length");
  c.res = undefined;
  c.res = new Response(JSON.stringify(view(body)), { status: 200, headers });
});

// Expired invites, swept by the daily cron beside the OAuth sweep.
export async function sweepCoachInvites(db: D1Database, now: number) {
  await db.prepare("DELETE FROM coach_invites WHERE expires_at <= ?").bind(now).run();
}
