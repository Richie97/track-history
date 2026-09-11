import { describe, expect, it } from "vitest";
import {
  CORNER_MERGE_GAP_POINTS,
  CORNER_MIN_G,
  MIN_CORNER_POINTS,
  cornerAt,
  cornerLabel,
  cornerMask,
  cornersFromMask,
  hasCornerData,
  lapCorners,
  sessionCorners,
} from "../../public/js/corners.js";

// 24 grid points: a real corner at k 2–5, a chicane at k 9–13 with a one-point
// dip in the middle, a kerb strike at k 17 and a straight everywhere else —
// the straights three points long, so the merge gap (two) leaves them apart.
const latG = [0, 0.1, 0.5, 0.9, 1.0, 0.6, 0.1, 0, 0, 0.7, 0.8, 0.2, 0.9, 0.7, 0.1, 0, 0, 1.4, 0, 0, 0.1, 0, 0, 0];
const lap = { n: 1, timeMs: 90_000, speed: Array(24).fill(100), latG };

describe("cornerMask / hasCornerData", () => {
  it("marks sustained lateral load and treats a stored sign as a magnitude", () => {
    expect(cornerMask([0, 0.34, 0.35, -0.9])).toEqual([false, false, true, true]);
    expect(cornerMask(undefined)).toEqual([]);
    expect(hasCornerData(lap)).toBe(true);
    expect(hasCornerData({ speed: [1] })).toBe(false);
    expect(CORNER_MIN_G).toBe(0.35);
  });
});

describe("cornersFromMask", () => {
  it("merges across a short dip and drops a run too short to be a corner", () => {
    const mask = cornerMask(latG);
    expect(cornersFromMask(mask)).toEqual([
      { k0: 2, k1: 5 },
      { k0: 9, k1: 13 }, // the chicane's dip at k 11 is one clear point: merged
    ]); // the kerb strike at k 17 is one point: dropped
    expect(CORNER_MERGE_GAP_POINTS).toBe(2);
    expect(MIN_CORNER_POINTS).toBe(3);
  });
  it("takes its thresholds as options", () => {
    const mask = cornerMask(latG);
    expect(cornersFromMask(mask, { mergeGap: 0 })).toEqual([{ k0: 2, k1: 5 }]); // the chicane's halves are two points each
    expect(cornersFromMask(mask, { mergeGap: 0, minPoints: 2 })).toEqual([{ k0: 2, k1: 5 }, { k0: 9, k1: 10 }, { k0: 12, k1: 13 }]);
    expect(cornersFromMask(mask, { minPoints: 1 })).toHaveLength(3); // the strike counts
  });
});

describe("lapCorners", () => {
  it("numbers the corners from the start/finish line and finds each one's peak", () => {
    const cs = lapCorners(lap);
    expect(cs.map((c) => [c.n, c.k0, c.k1])).toEqual([
      [1, 2, 5],
      [2, 9, 13],
    ]);
    expect(cs[0].peakG).toBeCloseTo(1.0, 9);
    expect(cs[0].peakK).toBe(4);
    expect(cs[1].peakG).toBeCloseTo(0.9, 9);
    expect(cs[1].peakK).toBe(12);
    expect(cornerLabel(cs[1])).toBe("T2");
  });
  it("is empty without a latG channel", () => {
    expect(lapCorners({ speed: [1, 2, 3] })).toEqual([]);
    expect(lapCorners(undefined)).toEqual([]);
  });
});

describe("sessionCorners", () => {
  it("segments the union of every lap's mask, so the list is one list for the session", () => {
    // The second lap takes the first corner wider (load starts a point
    // earlier) and never loads the tyre through the chicane.
    const wide = { ...lap, latG: latG.map((g, k) => (k === 1 ? 0.4 : k >= 9 && k <= 13 ? 0.1 : g)) };
    const cs = sessionCorners({ laps: [lap, wide] });
    expect(cs.map((c) => [c.n, c.k0, c.k1, c.laps])).toEqual([
      [1, 1, 5, 2], // the union starts where the wide lap did; both laps took it
      [2, 9, 13, 1], // only the first lap loaded the tyre here
    ]);
    expect(cs[0].peakG).toBeCloseTo(1.0, 9); // the highest any lap saw
  });
  it("ignores laps without latG and is empty when none has it", () => {
    expect(sessionCorners({ laps: [{ speed: [1] }, lap] })).toHaveLength(2);
    expect(sessionCorners({ laps: [{ speed: [1] }] })).toEqual([]);
    expect(sessionCorners(null)).toEqual([]);
  });
});

describe("cornerAt", () => {
  it("finds the corner a grid point sits in, null on a straight", () => {
    const cs = lapCorners(lap);
    expect(cornerAt(cs, 3)).toBe(cs[0]);
    expect(cornerAt(cs, 11)).toBe(cs[1]); // the dip inside the chicane is still the chicane
    expect(cornerAt(cs, 7)).toBeNull();
    expect(cornerAt([], 3)).toBeNull();
  });
});
