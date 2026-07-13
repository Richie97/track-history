import { describe, expect, it } from "vitest";
import {
  isValidConditions,
  isValidGoal,
  isValidSlug,
  isValidTemp,
  sanitizeChecklist,
  sanitizeLaps,
} from "../../src/lib/validate";

describe("isValidSlug", () => {
  it("accepts 3-32 char lowercase slugs", () => {
    for (const s of ["abc", "a-b", "abc123", "my-track-history", "a".repeat(32)]) {
      expect(isValidSlug(s), s).toBe(true);
    }
  });

  it("rejects bad shapes", () => {
    for (const s of ["", "ab", "-abc", "abc-", "ABC", "a b", "a_b", "a".repeat(33), "héllo"]) {
      expect(isValidSlug(s), s).toBe(false);
    }
  });
});

describe("sanitizeLaps", () => {
  it("keeps positive finite numbers, rounded to whole ms", () => {
    expect(sanitizeLaps([121240.4, 95000])).toEqual([121240, 95000]);
  });

  it("drops zero, negative, non-finite and non-numeric entries", () => {
    expect(sanitizeLaps([0, -5, NaN, Infinity, "121000" as any, null as any, 100])).toEqual([100]);
  });

  it("returns [] for non-arrays", () => {
    expect(sanitizeLaps(undefined)).toEqual([]);
    expect(sanitizeLaps("nope")).toEqual([]);
  });
});

describe("isValidGoal", () => {
  it("allows clearing and positive times", () => {
    expect(isValidGoal(null)).toBe(true);
    expect(isValidGoal(undefined)).toBe(true);
    expect(isValidGoal(119500)).toBe(true);
  });

  it("rejects zero, negatives and non-numbers", () => {
    expect(isValidGoal(0)).toBe(false);
    expect(isValidGoal(-1)).toBe(false);
    expect(isValidGoal("1:59" as any)).toBe(false);
    expect(isValidGoal(NaN)).toBe(false);
  });
});

describe("isValidConditions", () => {
  it("allows clearing and the known values", () => {
    expect(isValidConditions(null)).toBe(true);
    expect(isValidConditions(undefined)).toBe(true);
    for (const v of ["dry", "damp", "wet", "mixed"]) expect(isValidConditions(v)).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(isValidConditions("snow")).toBe(false);
    expect(isValidConditions("DRY")).toBe(false);
    expect(isValidConditions(1 as any)).toBe(false);
  });
});

describe("isValidTemp", () => {
  it("allows clearing and plausible whole °F", () => {
    expect(isValidTemp(null)).toBe(true);
    expect(isValidTemp(undefined)).toBe(true);
    expect(isValidTemp(72)).toBe(true);
    expect(isValidTemp(-10)).toBe(true);
  });

  it("rejects out-of-range and non-integers", () => {
    expect(isValidTemp(200)).toBe(false);
    expect(isValidTemp(-100)).toBe(false);
    expect(isValidTemp(72.5)).toBe(false);
    expect(isValidTemp("72" as any)).toBe(false);
  });
});

describe("sanitizeChecklist", () => {
  it("null/undefined clears the checklist", () => {
    expect(sanitizeChecklist(null)).toBeNull();
    expect(sanitizeChecklist(undefined)).toBeNull();
  });

  it("normalizes items to trimmed {text, done}", () => {
    expect(sanitizeChecklist([{ text: "  Tech inspection  ", done: 1 }, { text: "Fuel" }])).toEqual([
      { text: "Tech inspection", done: true },
      { text: "Fuel", done: false },
    ]);
  });

  it("returns undefined for invalid shapes", () => {
    expect(sanitizeChecklist("nope")).toBeUndefined();
    expect(sanitizeChecklist([{ done: true }])).toBeUndefined(); // no text
    expect(sanitizeChecklist([{ text: "" }])).toBeUndefined();
    expect(sanitizeChecklist([{ text: "x".repeat(201) }])).toBeUndefined();
    expect(sanitizeChecklist([null])).toBeUndefined();
    expect(sanitizeChecklist(Array.from({ length: 101 }, () => ({ text: "x" })))).toBeUndefined();
  });
});
