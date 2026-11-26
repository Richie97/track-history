import { describe, expect, it } from "vitest";
import {
  CORNER_MERGE_GAP_POINTS,
  CORNER_MIN_G,
  MIN_CORNER_POINTS,
  cornerAt,
  cornerDirs,
  cornerLabel,
  cornersFromDirs,
  hasCornerData,
  lapCorners,
  lateralSigns,
  sessionCorners,
  sessionDirs,
} from "../../public/js/corners.js";

// 24 grid points: a real corner at k 2–5, a double apex at k 9–13 with a
// one-point dip in the middle, a kerb strike at k 17 and a straight everywhere
// else — the straights three points long, so the merge gap (two) leaves them
// apart. No yaw and no steering: the magnitude-only reading.
const latG = [0, 0.1, 0.5, 0.9, 1.0, 0.6, 0.1, 0, 0, 0.7, 0.8, 0.2, 0.9, 0.7, 0.1, 0, 0, 1.4, 0, 0, 0.1, 0, 0, 0];
const lap = { n: 1, timeMs: 90_000, speed: Array(24).fill(100), latG };

// 21 grid points of esses: left at k 1–3, right at k 5–7 with one clear point
// between them, then a left double apex at k 11–13 and k 15–17. Read as a
// magnitude the first two are one corner; read with a direction they are two,
// and the double apex is still one.
const essG = [0, 0.6, 0.8, 0.7, 0.2, 0.7, 0.9, 0.8, 0.1, 0, 0, 0.6, 0.7, 0.6, 0.1, 0.5, 0.6, 0.5, 0, 0, 0];
const essYaw = [1, 5, 6, 5, 1, -5, -6, -5, -1, 1, 1, 4, 4, 4, 1, 4, 4, 4, 1, 1, 1];
const esses = { n: 1, timeMs: 60_000, speed: Array(21).fill(100), latG: essG, yaw: essYaw };
const windows = (cs) => cs.map((c) => [c.n, c.k0, c.k1]);

describe("lateralSigns / hasCornerData", () => {
  it("reads the direction from yaw, else steering, and has none without either", () => {
    expect(lateralSigns({ latG: [1, 1, 1], yaw: [2, -3, 0] })).toEqual([1, -1, 1]);
    expect(lateralSigns({ latG: [1, 1], steering: [-40, 40] })).toEqual([-1, 1]);
    // yaw wins when a lap has both
    expect(lateralSigns({ latG: [1, 1], yaw: [1, 1], steering: [-40, -40] })).toEqual([1, 1]);
    expect(lateralSigns(lap)).toBeNull();
    expect(lateralSigns({ yaw: [1, 2] })).toBeNull();
    expect(hasCornerData(lap)).toBe(true);
    expect(hasCornerData({ speed: [1] })).toBe(false);
  });
});

describe("cornerDirs", () => {
  it("marks sustained lateral load and treats a stored sign as a magnitude", () => {
    expect(cornerDirs([0, 0.34, 0.35, -0.9])).toEqual([0, 0, 1, 1]);
    expect(cornerDirs([0, 0.34, 0.35, -0.9], [1, -1, -1, 1])).toEqual([0, 0, -1, 1]);
    expect(cornerDirs(undefined)).toEqual([]);
    expect(CORNER_MIN_G).toBe(0.35);
  });
});

describe("cornersFromDirs", () => {
  it("merges across a short dip and drops a run too short to be a corner", () => {
    const dirs = cornerDirs(latG);
    expect(cornersFromDirs(dirs)).toEqual([
      { k0: 2, k1: 5 },
      { k0: 9, k1: 13 }, // the double apex's dip at k 11 is one clear point: merged
    ]); // the kerb strike at k 17 is one point: dropped
    expect(CORNER_MERGE_GAP_POINTS).toBe(2);
    expect(MIN_CORNER_POINTS).toBe(3);
  });
  it("takes its thresholds as options", () => {
    const dirs = cornerDirs(latG);
    expect(cornersFromDirs(dirs, { mergeGap: 0 })).toEqual([{ k0: 2, k1: 5 }]); // the apexes are two points each
    expect(cornersFromDirs(dirs, { mergeGap: 0, minPoints: 2 })).toEqual([{ k0: 2, k1: 5 }, { k0: 9, k1: 10 }, { k0: 12, k1: 13 }]);
    expect(cornersFromDirs(dirs, { minPoints: 1 })).toHaveLength(3); // the strike counts
  });
  it("never merges across a change of direction", () => {
    expect(cornersFromDirs([1, 1, 1, 0, -1, -1, -1])).toEqual([{ k0: 0, k1: 2 }, { k0: 4, k1: 6 }]);
    expect(cornersFromDirs([1, 1, 1, -1, -1, -1])).toEqual([{ k0: 0, k1: 2 }, { k0: 3, k1: 5 }]); // no gap at all
    // An opposite flick between two same-direction runs keeps them apart even
    // though the gap between them is inside the merge distance.
    expect(cornersFromDirs([1, 1, 1, -1, 1, 1, 1], { minPoints: 1 })).toEqual([{ k0: 0, k1: 2 }, { k0: 3, k1: 3 }, { k0: 4, k1: 6 }]);
    expect(cornersFromDirs([1, 1, 1, -1, 1, 1, 1])).toEqual([{ k0: 0, k1: 2 }, { k0: 4, k1: 6 }]);
  });
});

describe("lapCorners", () => {
  it("numbers the corners from the start/finish line and finds each one's peak", () => {
    const cs = lapCorners(lap);
    expect(windows(cs)).toEqual([
      [1, 2, 5],
      [2, 9, 13],
    ]);
    expect(cs[0].peakG).toBeCloseTo(1.0, 9);
    expect(cs[0].peakK).toBe(4);
    expect(cs[1].peakG).toBeCloseTo(0.9, 9);
    expect(cs[1].peakK).toBe(12);
    expect(cornerLabel(cs[1])).toBe("T2");
  });
  it("cuts linked corners apart where the direction changes", () => {
    expect(windows(lapCorners(esses))).toEqual([
      [1, 1, 3],
      [2, 5, 7],
      [3, 11, 17], // same direction either side of the dip: still one corner
    ]);
    // Which sign is "left" is the recorder's business: the cut is the same.
    const steered = { ...esses, yaw: undefined, steering: essYaw.map((v) => v * -3) };
    expect(windows(lapCorners(steered))).toEqual(windows(lapCorners(esses)));
    // Without a direction the esses are one corner, as they were.
    expect(windows(lapCorners({ ...esses, yaw: undefined }))).toEqual([
      [1, 1, 7],
      [2, 11, 17],
    ]);
  });
  it("is empty without a latG channel", () => {
    expect(lapCorners({ speed: [1, 2, 3] })).toEqual([]);
    expect(lapCorners(undefined)).toEqual([]);
  });
});

describe("sessionDirs", () => {
  it("puts a lap from a recorder with the opposite convention the same way round", () => {
    const flipped = { ...esses, yaw: essYaw.map((v) => -v) };
    const [a, b] = sessionDirs([esses, flipped]);
    expect(b).toEqual(a);
    expect(a.slice(0, 8)).toEqual([0, 1, 1, 1, 0, -1, -1, -1]);
  });
  it("uses no direction at all when any lap has none", () => {
    const [a, b] = sessionDirs([esses, { ...esses, yaw: undefined }]);
    expect(a).toEqual(b);
    expect(a.slice(0, 8)).toEqual([0, 1, 1, 1, 0, 1, 1, 1]);
  });
});

describe("sessionCorners", () => {
  it("segments every lap together, so the list is one list for the session", () => {
    // The second lap takes the first corner wider (load starts a point
    // earlier) and never loads the tire through the double apex.
    const wide = { ...lap, latG: latG.map((g, k) => (k === 1 ? 0.4 : k >= 9 && k <= 13 ? 0.1 : g)) };
    const cs = sessionCorners({ laps: [lap, wide] });
    expect(cs.map((c) => [c.n, c.k0, c.k1, c.laps])).toEqual([
      [1, 1, 5, 2], // the window starts where the wide lap did; both laps took it
      [2, 9, 13, 1], // only the first lap loaded the tire here
    ]);
    expect(cs[0].peakG).toBeCloseTo(1.0, 9); // the highest any lap saw
  });
  it("keeps linked corners apart across laps, whatever each recorder calls left", () => {
    const flipped = { ...esses, n: 2, yaw: essYaw.map((v) => -v) };
    const cs = sessionCorners({ laps: [esses, flipped] });
    expect(cs.map((c) => [c.n, c.k0, c.k1, c.laps])).toEqual([
      [1, 1, 3, 2],
      [2, 5, 7, 2],
      [3, 11, 17, 2],
    ]);
  });
  it("gives a contested point to the direction more laps turn, the earliest lap's on a tie", () => {
    // This lap is still loaded left through k 4 and k 5, where the others have
    // let go (k 4) or are already turning right (k 5).
    const late = {
      ...esses,
      n: 3,
      latG: essG.map((g, k) => (k === 4 || k === 5 ? 0.5 : g)),
      yaw: essYaw.map((v, k) => (k === 4 || k === 5 ? 3 : v)),
    };
    // Two against one at k 5: it stays in the right-hander. k 4 is loaded by
    // one lap only, so the left-hander reaches it.
    expect(windows(sessionCorners({ laps: [esses, { ...esses, n: 2 }, late] }))).toEqual([
      [1, 1, 4],
      [2, 5, 7],
      [3, 11, 17],
    ]);
    // One against one at k 5: the earliest lap decides, either way round.
    expect(windows(sessionCorners({ laps: [esses, late] }))[1]).toEqual([2, 5, 7]);
    // …and what is left of the right-hander is then too short to be a corner.
    expect(windows(sessionCorners({ laps: [late, esses] }))).toEqual([
      [1, 1, 5],
      [2, 11, 17],
    ]);
  });
  it("falls back to magnitude alone when a lap has no direction", () => {
    const cs = sessionCorners({ laps: [esses, { ...esses, n: 2, yaw: undefined }] });
    expect(windows(cs)).toEqual([
      [1, 1, 7],
      [2, 11, 17],
    ]);
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
    expect(cornerAt(cs, 11)).toBe(cs[1]); // the dip inside the double apex is still that corner
    expect(cornerAt(cs, 7)).toBeNull();
    expect(cornerAt([], 3)).toBeNull();
  });
});
