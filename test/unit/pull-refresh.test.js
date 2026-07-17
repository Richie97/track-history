import { describe, expect, it } from "vitest";
import { dampen, PULL_MAX, PULL_THRESHOLD } from "../../public/js/pull-refresh.js";

describe("dampen", () => {
  it("ignores upward and zero movement", () => {
    expect(dampen(0)).toBe(0);
    expect(dampen(-50)).toBe(0);
    expect(dampen(NaN)).toBe(0);
  });

  it("increases monotonically with finger travel", () => {
    let prev = 0;
    for (const dy of [10, 40, 80, 160, 320]) {
      const d = dampen(dy);
      expect(d).toBeGreaterThan(prev);
      prev = d;
    }
  });

  it("tracks the finger closely at the start, with resistance building later", () => {
    expect(dampen(20)).toBeGreaterThan(14); // near 1:1 early
    expect(dampen(300) - dampen(280)).toBeLessThan(4); // heavy resistance late
  });

  it("never exceeds PULL_MAX", () => {
    expect(dampen(10000)).toBeLessThanOrEqual(PULL_MAX);
  });

  it("reaches the refresh threshold with a reasonable pull (~120px)", () => {
    expect(dampen(110)).toBeLessThan(PULL_THRESHOLD);
    expect(dampen(130)).toBeGreaterThanOrEqual(PULL_THRESHOLD);
  });
});
