import { Hono } from "hono";
import type { AppContext } from "../types";
import { userTotals } from "../db";
import { DEFAULT_UNITS, isValidUnits, sanitizeChecklistTemplate } from "../lib/validate";

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
  const row = await c.env.DB.prepare(
    "SELECT id, email, name, picture, share_slug, checklist_template, units FROM users WHERE id = ?"
  )
    .bind(userId)
    .first();
  // `units` is always a concrete system, never null: the default lives here,
  // in one place, rather than in three clients that would each have to agree
  // on what "unset" means.
  const user = row && {
    ...row,
    checklist_template: parseTemplate(row.checklist_template),
    units: isValidUnits(row.units) ? row.units : DEFAULT_UNITS,
  };
  const totals = await userTotals(c.env.DB, userId);
  return c.json({ user, totals });
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
