import { Hono } from "hono";
import type { AppContext } from "../types";
import { userTotalsStmt } from "../db";
import { sanitizeChecklistTemplate } from "../lib/validate";

export const me = new Hono<AppContext>();

// The stored prep-checklist template, or null when the user hasn't customized
// one. Malformed JSON degrades to null rather than throwing, the same way a
// malformed event checklist does (`parseChecklist` in lib/stats.ts) — a bad row
// must not make the whole app unloadable.
function parseTemplate(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  try {
    return sanitizeChecklistTemplate(JSON.parse(raw)) ?? null;
  } catch {
    return null;
  }
}

me.get("/me", async (c) => {
  const userId = c.get("userId");
  // The user row and the totals are independent — one batched round trip.
  const [userRes, totalsRes] = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT id, email, name, picture, share_slug, checklist_template, leaderboard_opt_in FROM users WHERE id = ?"
    ).bind(userId),
    userTotalsStmt(c.env.DB, userId),
  ]);
  const row = (userRes.results[0] ?? null) as Record<string, unknown> | null;
  const user = row && {
    ...row,
    checklist_template: parseTemplate(row.checklist_template),
    leaderboard_opt_in: Boolean(row.leaderboard_opt_in),
  };
  return c.json({ user, totals: totalsRes.results[0] });
});

// Toggle the per-track leaderboard opt-in. Off (the default) means nothing
// about the user appears on any leaderboard; on publishes their display name
// and best lap per catalog track to other signed-in users (see
// GET /tracks/:id/leaderboard in routes/tracks.ts).
me.put("/me/leaderboard", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  const optIn = body && typeof body === "object" ? (body as Record<string, unknown>).opt_in : undefined;
  if (typeof optIn !== "boolean") return c.json({ error: "opt_in must be true or false" }, 400);
  await c.env.DB.prepare("UPDATE users SET leaderboard_opt_in = ? WHERE id = ?")
    .bind(optIn ? 1 : 0, userId)
    .run();
  return c.json({ ok: true });
});

// Replace the prep-checklist template. Null — or an empty list — clears it,
// which puts the user back on the app's built-in default rather than leaving
// them with nothing to start a checklist from.
me.put("/me/checklist-template", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid body" }, 400);
  const template = sanitizeChecklistTemplate((body as Record<string, unknown>).checklist_template);
  if (template === undefined) return c.json({ error: "invalid checklist template" }, 400);
  await c.env.DB.prepare("UPDATE users SET checklist_template = ? WHERE id = ?")
    .bind(template ? JSON.stringify(template) : null, userId)
    .run();
  return c.json({ ok: true });
});
