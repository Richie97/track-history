import { Hono } from "hono";
import type { AppContext } from "../types";
import { userTotalsStmt } from "../db";
import { DEFAULT_UNITS, isValidUnits, sanitizeChecklistTemplate } from "../lib/validate";
import { entitlementResponse, type SubscriptionRow } from "../lib/entitlement";
import { subscriptionsForUserStmt } from "../lib/billing/store";

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
  // The user row, the totals and the subscription rows are independent — one
  // batched round trip.
  const [userRes, totalsRes, subsRes] = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT id, email, name, picture, share_slug, checklist_template, leaderboard_opt_in, leaderboard_share_laps, units FROM users WHERE id = ?"
    ).bind(userId),
    userTotalsStmt(c.env.DB, userId),
    subscriptionsForUserStmt(c.env.DB, userId),
  ]);
  const row = (userRes.results[0] ?? null) as Record<string, unknown> | null;
  const user = row && {
    ...row,
    checklist_template: parseTemplate(row.checklist_template),
    leaderboard_opt_in: Boolean(row.leaderboard_opt_in),
    leaderboard_share_laps: Boolean(row.leaderboard_share_laps),
    // `units` is always a concrete system, never null: the default lives here,
    // in one place, rather than in three clients that would each have to agree
    // on what "unset" means.
    units: isValidUnits(row.units) ? row.units : DEFAULT_UNITS,
  };
  // Tier comes from entitled_until as loaded with the session; the rows only
  // say where it came from (NS-32 requirement 1).
  const entitlement = entitlementResponse(c.get("entitledUntil"), subsRes.results as SubscriptionRow[], Date.now());
  return c.json({ user, totals: totalsRes.results[0], entitlement });
});

// Toggle the per-track leaderboard opt-in, and the second, narrower consent
// stacked on top of it (NS-35). Off (the default) means nothing about the user
// appears on any leaderboard; `opt_in` publishes their display name and best
// device-timed lap per catalog track to other signed-in users, and
// `share_laps` additionally publishes *that lap* — its GPS trace and per-lap
// channel data — so a driver ranked at the same track can open it and compare
// (see GET /tracks/:id/leaderboard and its /laps/:lapId sibling in
// routes/tracks.ts).
//
// `share_laps` is optional, so a shipped older client's `{ opt_in }` body keeps
// working and never silently clears a flag it doesn't know about. Opting *out*
// clears both in the same statement: laps cannot be shared by someone who is
// not on the board, and a second flag left set would re-publish telemetry the
// moment they rejoined.
me.put("/me/leaderboard", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const optIn = o.opt_in;
  if (typeof optIn !== "boolean") return c.json({ error: "opt_in must be true or false" }, 400);
  const shareLaps = o.share_laps;
  if (shareLaps !== undefined && typeof shareLaps !== "boolean")
    return c.json({ error: "share_laps must be true or false" }, 400);
  // null = leave the stored value alone; opting out overrides it to 0.
  const share = !optIn ? 0 : shareLaps === undefined ? null : shareLaps ? 1 : 0;
  await c.env.DB.prepare(
    "UPDATE users SET leaderboard_opt_in = ?, leaderboard_share_laps = COALESCE(?, leaderboard_share_laps) WHERE id = ?"
  )
    .bind(optIn ? 1 : 0, share, userId)
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

// Choose the unit system the logbook is shown in ("metric" or "imperial").
// Display-only — nothing stored changes — so there is no "clear" here: a user
// always sees one system or the other, and the default is what GET /me answers
// for an account that never chose.
me.put("/me/units", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid body" }, 400);
  const units = (body as Record<string, unknown>).units;
  if (!isValidUnits(units)) return c.json({ error: "units must be \"metric\" or \"imperial\"" }, 400);
  await c.env.DB.prepare("UPDATE users SET units = ? WHERE id = ?").bind(units, userId).run();
  return c.json({ ok: true });
});
