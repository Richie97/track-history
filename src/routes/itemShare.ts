import { Hono } from "hono";
import type { AppContext, Ctx } from "../types";
import { type ShareKind, sharePath, shareToken } from "../lib/itemShare";

// Share one event or one session (NS-48), one lap or two laps compared
// (NS-56) — the owner's half, under /api.
//
//   POST   /events/:id/share     the event's link, minted on first use
//   GET    /events/:id/share     the link if there is one, else 404
//   DELETE /events/:id/share     stop sharing it
//   …and the same three under /sessions/:id/share, /laps/:id/share and
//   /laps/:id/compare/:otherId/share (lap :id is side A, :otherId side B).
//
// Every answer is { kind, token, url, created_at }. POST is idempotent — a
// second Share answers the link already out there rather than minting another,
// so "Stop sharing" is one row to delete. Free for every account, like the
// logbook share: sharing is in "free forever" on every paywall, and what the
// link *shows* follows the owner's tier on its own (lib/itemShare.ts). Live
// writes, off every offline queue — a link needs the server to exist.
//
// Nothing in another user's logbook can be shared or unshared from here:
// each statement is scoped by user_id, and a miss is a 404.
export const itemShare = new Hono<AppContext>();

type Row = { token: string; created_at: number };

const answer = (c: Ctx, kind: ShareKind, row: Row, status: 200 | 201 = 200) =>
  c.json(
    { kind, token: row.token, url: new URL(sharePath(kind, row.token), c.req.url).toString(), created_at: row.created_at },
    status
  );

// The share row for an item, or null. `sessionId` null is the event's own.
function findStmt(c: Ctx, eventId: number | string, sessionId: number | string | null) {
  return sessionId == null
    ? c.env.DB.prepare(
        "SELECT token, created_at FROM item_shares WHERE event_id = ? AND session_id IS NULL AND user_id = ?"
      ).bind(eventId, c.get("userId"))
    : c.env.DB.prepare("SELECT token, created_at FROM item_shares WHERE session_id = ? AND lap_id IS NULL AND user_id = ?").bind(
        sessionId,
        c.get("userId")
      );
}

// The item's event id, scoped to the caller — null when it isn't theirs.
async function ownedEventId(c: Ctx, kind: ShareKind, id: string): Promise<number | null> {
  const row =
    kind === "event"
      ? await c.env.DB.prepare("SELECT id FROM events WHERE id = ? AND user_id = ?").bind(id, c.get("userId")).first<{ id: number }>()
      : await c.env.DB.prepare(
          "SELECT s.event_id AS id FROM sessions s JOIN events e ON e.id = s.event_id WHERE s.id = ? AND e.user_id = ?"
        )
          .bind(id, c.get("userId"))
          .first<{ id: number }>();
  return row?.id ?? null;
}

for (const kind of ["event", "session"] as const) {
  const path = kind === "event" ? "/events/:id/share" : "/sessions/:id/share";
  const sessionOf = (c: Ctx) => (kind === "session" ? c.req.param("id")! : null);

  itemShare.post(path, async (c) => {
    const eventId = await ownedEventId(c, kind, c.req.param("id")!);
    if (eventId == null) return c.json({ error: "not found" }, 404);
    // INSERT OR IGNORE against the partial unique indexes, then read back
    // whichever row is there — two Shares racing each other both answer the
    // one link.
    const now = Date.now();
    const res = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO item_shares (user_id, token, event_id, session_id, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(c.get("userId"), shareToken(), eventId, sessionOf(c), now)
      .run();
    const row = await findStmt(c, eventId, sessionOf(c)).first<Row>();
    if (!row) return c.json({ error: "not found" }, 404);
    return answer(c, kind, row, res.meta.changes ? 201 : 200);
  });

  itemShare.get(path, async (c) => {
    const row =
      kind === "event"
        ? await findStmt(c, c.req.param("id")!, null).first<Row>()
        : await findStmt(c, 0, c.req.param("id")!).first<Row>();
    if (!row) return c.json({ error: "not shared" }, 404);
    return answer(c, kind, row);
  });

  itemShare.delete(path, async (c) => {
    const res =
      kind === "event"
        ? await c.env.DB.prepare("DELETE FROM item_shares WHERE event_id = ? AND session_id IS NULL AND user_id = ?")
            .bind(c.req.param("id"), c.get("userId"))
            .run()
        : await c.env.DB.prepare("DELETE FROM item_shares WHERE session_id = ? AND lap_id IS NULL AND user_id = ?")
            .bind(c.req.param("id"), c.get("userId"))
            .run();
    if (!res.meta.changes) return c.json({ error: "not shared" }, 404);
    return c.json({ ok: true });
  });
}

// --- one lap, or two laps compared (NS-56) ---------------------------------

type OwnedLap = { id: number; session_id: number; event_id: number; track_id: number };

// The caller's own lap with where it sits — null when it isn't theirs.
const ownedLap = (c: Ctx, id: string) =>
  c.env.DB.prepare(
    `SELECT l.id, l.session_id, s.event_id, e.track_id
       FROM laps l JOIN sessions s ON s.id = l.session_id JOIN events e ON e.id = s.event_id
      WHERE l.id = ? AND e.user_id = ?`
  )
    .bind(id, c.get("userId"))
    .first<OwnedLap>();

const lapShareStmt = (c: Ctx, lapId: number | string) =>
  c.env.DB.prepare(
    "SELECT token, created_at FROM item_shares WHERE lap_id = ? AND lap_b_id IS NULL AND user_id = ?"
  ).bind(lapId, c.get("userId"));

const compareShareStmt = (c: Ctx, a: number | string, b: number | string) =>
  c.env.DB.prepare("SELECT token, created_at FROM item_shares WHERE lap_id = ? AND lap_b_id = ? AND user_id = ?").bind(
    a,
    b,
    c.get("userId")
  );

itemShare.post("/laps/:id/share", async (c) => {
  const lap = await ownedLap(c, c.req.param("id"));
  if (!lap) return c.json({ error: "not found" }, 404);
  const res = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO item_shares (user_id, token, event_id, session_id, lap_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(c.get("userId"), shareToken(), lap.event_id, lap.session_id, lap.id, Date.now())
    .run();
  const row = await lapShareStmt(c, lap.id).first<Row>();
  if (!row) return c.json({ error: "not found" }, 404);
  return answer(c, "lap", row, res.meta.changes ? 201 : 200);
});

itemShare.get("/laps/:id/share", async (c) => {
  const row = await lapShareStmt(c, c.req.param("id")).first<Row>();
  if (!row) return c.json({ error: "not shared" }, 404);
  return answer(c, "lap", row);
});

itemShare.delete("/laps/:id/share", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM item_shares WHERE lap_id = ? AND lap_b_id IS NULL AND user_id = ?")
    .bind(c.req.param("id"), c.get("userId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not shared" }, 404);
  return c.json({ ok: true });
});

// Two of the caller's laps at one track, A against B. Different layouts are
// different tracks here, and a comparison across them is not one the app draws.
itemShare.post("/laps/:id/compare/:otherId/share", async (c) => {
  const [a, b] = await Promise.all([ownedLap(c, c.req.param("id")), ownedLap(c, c.req.param("otherId"))]);
  if (!a || !b) return c.json({ error: "not found" }, 404);
  if (a.id === b.id) return c.json({ error: "pick two different laps" }, 400);
  if (a.track_id !== b.track_id) return c.json({ error: "laps must be at the same track" }, 400);
  const res = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO item_shares (user_id, token, event_id, session_id, lap_id, lap_b_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(c.get("userId"), shareToken(), a.event_id, a.session_id, a.id, b.id, Date.now())
    .run();
  const row = await compareShareStmt(c, a.id, b.id).first<Row>();
  if (!row) return c.json({ error: "not found" }, 404);
  return answer(c, "compare", row, res.meta.changes ? 201 : 200);
});

itemShare.get("/laps/:id/compare/:otherId/share", async (c) => {
  const row = await compareShareStmt(c, c.req.param("id"), c.req.param("otherId")).first<Row>();
  if (!row) return c.json({ error: "not shared" }, 404);
  return answer(c, "compare", row);
});

itemShare.delete("/laps/:id/compare/:otherId/share", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM item_shares WHERE lap_id = ? AND lap_b_id = ? AND user_id = ?")
    .bind(c.req.param("id"), c.req.param("otherId"), c.get("userId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not shared" }, 404);
  return c.json({ ok: true });
});
