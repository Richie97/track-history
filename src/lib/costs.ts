// Track-day cost tracking (#147) — pure, unit-testable.
//
// An event carries four optional line items in integer cents (migration 0025).
// The one derived figure is the event's total, which is null — not zero — when
// nothing was entered, so an uncosted event never counts as a free one in a
// roll-up. Mirrored by `eventCostCents` in public/js/costs.js; keep in sync.

export const COST_FIELDS = [
  "cost_entry_cents",
  "cost_fuel_cents",
  "cost_travel_cents",
  "cost_misc_cents",
] as const;

export type CostField = (typeof COST_FIELDS)[number];

export type EventCosts = { [K in CostField]: number | null };

// Same ceiling as parts.cost_cents: $100,000 per line item.
export const MAX_COST_CENTS = 100_000_00;

// A line item is null (not entered) or a whole, non-negative number of cents
// within the ceiling. Fractions are refused rather than rounded — the client
// converts dollars to cents, and a fractional cent means it didn't.
export function isValidCostCents(v: unknown): v is number | null | undefined {
  if (v == null) return true;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_COST_CENTS;
}

// The event's total in cents, or null when no line item was entered.
export function eventCostCents(e: Partial<EventCosts>): number | null {
  let total: number | null = null;
  for (const field of COST_FIELDS) {
    const v = e[field];
    if (v != null) total = (total ?? 0) + v;
  }
  return total;
}
