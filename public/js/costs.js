// Track-day cost tracking (#147) — pure, unit-testable, web-only for now (the
// phones decode the fields and leave them alone; see
// docs/specs/native/README.md).
//
// An event carries four optional line items in integer cents. Money is stored
// as cents and formatted here, single currency per user. `eventCostCents` is
// the mirror of the same function in src/lib/costs.ts — keep the two in sync;
// the offline layer uses it so a costed event created offline shows its total
// before the server has seen it.

import { fmtCost } from "./garage.js";

// Field, label and the input's placeholder — the order the form and the
// breakdown render in.
export const COST_FIELDS = [
  ["cost_entry_cents", "Entry fee", "450"],
  ["cost_fuel_cents", "Fuel", "120"],
  ["cost_travel_cents", "Travel & lodging", "300"],
  ["cost_misc_cents", "Misc", "tow, insurance, a mirror…"],
];

export const COST_LABELS = Object.fromEntries(COST_FIELDS.map(([f, label]) => [f, label]));

// Mirror of eventCostCents in src/lib/costs.ts: the sum of the entered line
// items, null — not zero — when none was entered.
export function eventCostCents(e) {
  let total = null;
  for (const [field] of COST_FIELDS) {
    const v = e?.[field];
    if (v != null) total = (total ?? 0) + v;
  }
  return total;
}

// Dollars typed on a form → whole cents, null for blank. Rounded, because
// 12.345 typed into a step-0.01 input is the browser's problem, not a 400.
export function dollarsToCents(raw) {
  const t = String(raw ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

// Cents → the dollars value a form input shows ("389" / "389.50", "" for null).
export const centsToDollars = (cents) =>
  cents == null ? "" : (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);

export { fmtCost };

// Spend across a set of events: the total, how many of them carried a cost,
// and the breakdown by line item. Null when no event carried one, so a page
// can leave the figure off rather than say "$0" about a season that was
// simply never costed.
export function spendSummary(events) {
  let total = 0;
  let costed = 0;
  const by = Object.fromEntries(COST_FIELDS.map(([f]) => [f, 0]));
  for (const e of events) {
    const cents = eventCostCents(e);
    if (cents == null) continue;
    costed++;
    total += cents;
    for (const [f] of COST_FIELDS) by[f] += e[f] ?? 0;
  }
  if (!costed) return null;
  return { total_cents: total, costed_events: costed, events: events.length, by_field: by };
}

// The wry one: cents per second found — what was spent at a track over a
// period divided by the seconds its best lap dropped in that period. Null
// unless both are known and the time actually dropped; a season that spent
// money and got slower has no price per second, it has a note in the diary.
export function centsPerSecond(spendCents, gainMs) {
  if (spendCents == null || gainMs == null || gainMs <= 0) return null;
  return spendCents / (gainMs / 1000);
}

// "$1,250/s" — whole dollars once it's past a dollar, cents below that.
export function fmtPerSecond(cents) {
  if (cents == null) return null;
  const dollars = cents / 100;
  const text =
    dollars >= 1
      ? `$${Math.round(dollars).toLocaleString("en-US")}`
      : `$${dollars.toFixed(2)}`;
  return `${text}/s`;
}

// "$1,250" with a thousands separator — fmtCost is the parts idiom (pinned by
// the garage fixture, no separators); the roll-ups use this because a season
// runs to five figures.
export function fmtSpend(cents) {
  if (cents == null) return null;
  const whole = cents % 100 === 0;
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}
