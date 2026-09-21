import { describe, expect, it } from "vitest";
import {
  COST_FIELDS,
  centsPerSecond,
  centsToDollars,
  dollarsToCents,
  eventCostCents,
  fmtPerSecond,
  fmtSpend,
  spendSummary,
} from "../../public/js/costs.js";

describe("eventCostCents (mirror of src/lib/costs.ts)", () => {
  it("is null with nothing entered and sums what is", () => {
    expect(eventCostCents({})).toBeNull();
    expect(eventCostCents({ cost_entry_cents: null })).toBeNull();
    expect(eventCostCents({ cost_entry_cents: 45_000, cost_misc_cents: 0 })).toBe(45_000);
    expect(eventCostCents({ cost_entry_cents: 45_000, cost_fuel_cents: 12_050 })).toBe(57_050);
  });

  it("names the four line items in form order", () => {
    expect(COST_FIELDS.map(([f]) => f)).toEqual([
      "cost_entry_cents", "cost_fuel_cents", "cost_travel_cents", "cost_misc_cents",
    ]);
  });
});

describe("form conversions", () => {
  it("dollars → whole cents, blank → null, garbage → null", () => {
    expect(dollarsToCents("450")).toBe(45_000);
    expect(dollarsToCents(" 120.50 ")).toBe(12_050);
    expect(dollarsToCents("0")).toBe(0);
    expect(dollarsToCents("")).toBeNull();
    expect(dollarsToCents("   ")).toBeNull();
    expect(dollarsToCents("-5")).toBeNull();
    expect(dollarsToCents("abc")).toBeNull();
    // Rounded, not truncated: 12.345 is the browser's step problem, not a 400.
    expect(dollarsToCents("12.345")).toBe(1235);
  });

  it("cents → the input's dollars text", () => {
    expect(centsToDollars(45_000)).toBe("450");
    expect(centsToDollars(12_050)).toBe("120.50");
    expect(centsToDollars(null)).toBe("");
  });
});

describe("spendSummary", () => {
  const ev = (over) => ({ cost_entry_cents: null, cost_fuel_cents: null, cost_travel_cents: null, cost_misc_cents: null, ...over });

  it("is null when no event carries a cost", () => {
    expect(spendSummary([])).toBeNull();
    expect(spendSummary([ev(), ev()])).toBeNull();
  });

  it("totals, counts the costed events and breaks down by line item", () => {
    const s = spendSummary([
      ev({ cost_entry_cents: 45_000, cost_fuel_cents: 8_000 }),
      ev(),
      ev({ cost_entry_cents: 40_000, cost_travel_cents: 30_000 }),
    ]);
    expect(s.total_cents).toBe(123_000);
    expect(s.costed_events).toBe(2);
    expect(s.events).toBe(3);
    expect(s.by_field).toEqual({
      cost_entry_cents: 85_000,
      cost_fuel_cents: 8_000,
      cost_travel_cents: 30_000,
      cost_misc_cents: 0,
    });
  });
});

describe("cents per second found", () => {
  it("divides the spend by the seconds found, null without both or when slower", () => {
    expect(centsPerSecond(150_000, 1_500)).toBe(100_000);
    expect(centsPerSecond(150_000, 0)).toBeNull();
    expect(centsPerSecond(150_000, -500)).toBeNull();
    expect(centsPerSecond(null, 1_500)).toBeNull();
    expect(centsPerSecond(150_000, null)).toBeNull();
  });

  it("formats as dollars per second, cents only under a dollar", () => {
    expect(fmtPerSecond(100_000)).toBe("$1,000/s");
    expect(fmtPerSecond(123_456)).toBe("$1,235/s");
    expect(fmtPerSecond(75)).toBe("$0.75/s");
    expect(fmtPerSecond(null)).toBeNull();
  });
});

describe("fmtSpend", () => {
  it("separates thousands and shows cents only when there are some", () => {
    expect(fmtSpend(123_000)).toBe("$1,230");
    expect(fmtSpend(123_050)).toBe("$1,230.50");
    expect(fmtSpend(0)).toBe("$0");
    expect(fmtSpend(null)).toBeNull();
  });
});
