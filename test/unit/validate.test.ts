import { describe, expect, it } from "vitest";
import {
  isValidConditions,
  isValidGoal,
  isValidSlug,
  isValidTemp,
  isValidDate,
  isValidPartKind,
  sanitizeChecklist,
  sanitizeLaps,
  sanitizeSetup,
  sanitizeTrace,
} from "../../src/lib/validate";

describe("sanitizeTrace", () => {
  const point = (i: number): [number, number, number] => [i * 1.5, i * -2.5, 30 + i];

  it("clears with null/undefined", () => {
    expect(sanitizeTrace(null)).toBeNull();
    expect(sanitizeTrace(undefined)).toBeNull();
  });

  it("accepts [x, y, v] arrays and rounds for storage", () => {
    const out = sanitizeTrace([[1.2345, -2.6789, 31.23456], ...Array.from({ length: 11 }, (_, i) => point(i))]);
    expect(out).toHaveLength(12);
    expect(out![0]).toEqual([1.2, -2.7, 31.23]);
  });

  it("defaults a missing speed to 0", () => {
    const out = sanitizeTrace(Array.from({ length: 10 }, (_, i) => [i, i]));
    expect(out![0]).toEqual([0, 0, 0]);
  });

  it("rejects implausible shapes and values", () => {
    expect(sanitizeTrace("nope")).toBeUndefined();
    expect(sanitizeTrace([[1, 2]])).toBeUndefined(); // too few points
    expect(sanitizeTrace(Array.from({ length: 601 }, (_, i) => point(i)))).toBeUndefined();
    expect(sanitizeTrace(Array.from({ length: 10 }, () => [1]))).toBeUndefined();
    expect(sanitizeTrace(Array.from({ length: 10 }, () => [1, NaN, 3]))).toBeUndefined();
    expect(sanitizeTrace(Array.from({ length: 10 }, () => [1e7, 0, 0]))).toBeUndefined();
    expect(sanitizeTrace(Array.from({ length: 10 }, () => ["1", 2, 3]))).toBeUndefined();
  });
});

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

describe("isValidDate / isValidPartKind", () => {
  it("accepts ISO dates and known kinds", () => {
    expect(isValidDate("2026-01-15")).toBe(true);
    expect(isValidPartKind("pads_front")).toBe(true);
    expect(isValidPartKind("tires")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isValidDate("15/01/2026")).toBe(false);
    expect(isValidDate("2026-1-5")).toBe(false);
    expect(isValidDate(20260115 as any)).toBe(false);
    expect(isValidPartKind("wing")).toBe(false);
    expect(isValidPartKind(null)).toBe(false);
  });
});

describe("sanitizeSetup", () => {
  it("null clears, empty object is null too", () => {
    expect(sanitizeSetup(null)).toBeNull();
    expect(sanitizeSetup({})).toBeNull();
    expect(sanitizeSetup({ unknown_field: 1 })).toBeNull(); // unknown keys dropped
  });

  it("normalizes corner and axle groups and rounds values", () => {
    expect(
      sanitizeSetup({
        tp_cold: { fl: 31.456, fr: 31.5, rl: 30, rr: 30 },
        camber: { f: -3.2004, r: -2 },
        fuel: 12.34,
        notes: "  baseline  ",
      })
    ).toEqual({
      tp_cold: { fl: 31.46, fr: 31.5, rl: 30, rr: 30 },
      camber: { f: -3.2, r: -2 },
      fuel: 12.3,
      notes: "baseline",
    });
  });

  it("keeps part references as positive integers", () => {
    expect(sanitizeSetup({ tires_id: 12, pads_f_id: 3 })).toEqual({ tires_id: 12, pads_f_id: 3 });
    expect(sanitizeSetup({ tires_id: 0 })).toBeUndefined();
    expect(sanitizeSetup({ tires_id: 1.5 })).toBeUndefined();
  });

  it("rejects implausible values instead of silently dropping them", () => {
    expect(sanitizeSetup({ tp_cold: { fl: 500 } })).toBeUndefined();
    expect(sanitizeSetup({ camber: { f: -45 } })).toBeUndefined();
    expect(sanitizeSetup({ fuel: -2 })).toBeUndefined();
    expect(sanitizeSetup({ notes: "x".repeat(2001) })).toBeUndefined();
    expect(sanitizeSetup({ tp_cold: "32 everywhere" })).toBeUndefined();
    expect(sanitizeSetup([1, 2, 3])).toBeUndefined();
  });

  it("drops unknown corner keys but keeps known ones", () => {
    expect(sanitizeSetup({ tp_cold: { fl: 31, xx: 4 } })).toEqual({ tp_cold: { fl: 31 } });
  });
});
