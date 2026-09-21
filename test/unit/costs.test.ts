import { describe, expect, it } from "vitest";
import { COST_FIELDS, MAX_COST_CENTS, eventCostCents, isValidCostCents } from "../../src/lib/costs";

describe("isValidCostCents", () => {
  it("accepts null, undefined and whole non-negative cents up to the ceiling", () => {
    expect(isValidCostCents(null)).toBe(true);
    expect(isValidCostCents(undefined)).toBe(true);
    expect(isValidCostCents(0)).toBe(true);
    expect(isValidCostCents(45_000)).toBe(true);
    expect(isValidCostCents(MAX_COST_CENTS)).toBe(true);
  });

  it("refuses negatives, fractions, strings and anything past the ceiling", () => {
    expect(isValidCostCents(-1)).toBe(false);
    expect(isValidCostCents(12.5)).toBe(false);
    expect(isValidCostCents("450")).toBe(false);
    expect(isValidCostCents(MAX_COST_CENTS + 1)).toBe(false);
    expect(isValidCostCents(Number.NaN)).toBe(false);
  });
});

describe("eventCostCents", () => {
  it("is null — not zero — when no line item was entered", () => {
    expect(eventCostCents({})).toBeNull();
    expect(eventCostCents({ cost_entry_cents: null, cost_fuel_cents: null })).toBeNull();
  });

  it("sums whichever line items were entered", () => {
    expect(eventCostCents({ cost_entry_cents: 45_000 })).toBe(45_000);
    expect(
      eventCostCents({ cost_entry_cents: 45_000, cost_fuel_cents: 12_050, cost_travel_cents: null, cost_misc_cents: 0 })
    ).toBe(57_050);
  });

  it("names exactly the four migration-0025 columns", () => {
    expect([...COST_FIELDS]).toEqual(["cost_entry_cents", "cost_fuel_cents", "cost_travel_cents", "cost_misc_cents"]);
  });
});
