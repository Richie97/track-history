import { describe, expect, it } from "vitest";
import { isValidGoal, isValidSlug, sanitizeLaps } from "../../src/lib/validate";

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
