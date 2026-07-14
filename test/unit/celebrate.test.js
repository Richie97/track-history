import { describe, expect, it } from "vitest";
import { detectPB } from "../../public/js/celebrate.js";

describe("detectPB", () => {
  it("detects a faster time as a PB with the delta", () => {
    expect(detectPB(123530, 123110, null)).toEqual({ ms: 123110, delta: 420, goalBeaten: false });
  });

  it("does not celebrate a track's first-ever time", () => {
    expect(detectPB(null, 123110, null)).toBeNull();
  });

  it("does not celebrate matching or slower times", () => {
    expect(detectPB(123110, 123110, null)).toBeNull();
    expect(detectPB(123110, 125000, null)).toBeNull();
  });

  it("ignores mutations that leave no best (deletes)", () => {
    expect(detectPB(123110, null, null)).toBeNull();
  });

  it("flags the goal only when this PB crosses it", () => {
    // goal crossed by this improvement
    expect(detectPB(124500, 123110, 124000)?.goalBeaten).toBe(true);
    // goal was already beaten before — a further PB isn't a goal moment
    expect(detectPB(123500, 123110, 124000)?.goalBeaten).toBe(false);
    // goal still unbeaten
    expect(detectPB(126000, 125000, 124000)?.goalBeaten).toBe(false);
  });
});
