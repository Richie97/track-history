import { describe, expect, it } from "vitest";
import {
  FLAG_ABS,
  FLAG_TC,
  FLAG_VSC,
  LIMIT_KINDS,
  MERGE_GAP_POINTS,
  activeLimitLabels,
  booleanRuns,
  hasLimitData,
  limitAt,
  limitMarkers,
  limitRuns,
  limitSummary,
  sessionLimits,
} from "../../public/js/limits.js";

// 20 grid points: ABS pulses across a braking zone (k 2–5, with a one-point
// gap), TC once on an exit (k 9–10), VSC never; wheelspin on that same exit
// and a lockup at k 3.
const flags = [0, 0, FLAG_ABS, 0, FLAG_ABS, FLAG_ABS, 0, 0, 0, FLAG_TC, FLAG_TC, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const slip = [0, 0, 0, -3, -1, 0, 0, 0, 0.5, 3, 4.5, 1, 0, 0, 0, 0, 0, 0, 0, 0];
const lap = { n: 1, timeMs: 90_000, speed: Array(20).fill(100), flags, wheelSlip: slip };

describe("limitAt / hasLimitData", () => {
  it("reads the flag bits and the slip thresholds, null for a channel the lap lacks", () => {
    expect(limitAt(lap, "abs", 2)).toBe(true);
    expect(limitAt(lap, "abs", 3)).toBe(false);
    expect(limitAt(lap, "tc", 9)).toBe(true);
    expect(limitAt(lap, "vsc", 9)).toBe(false);
    expect(limitAt(lap, "wheelspin", 10)).toBe(true);
    expect(limitAt(lap, "wheelspin", 8)).toBe(false); // 0.5 % is noise
    expect(limitAt(lap, "lockup", 3)).toBe(true);
    expect(limitAt({ flags }, "wheelspin", 3)).toBeNull();
    expect(limitAt({ wheelSlip: slip }, "abs", 3)).toBeNull();
    expect(limitAt(lap, "abs", 99)).toBeNull();
    expect(hasLimitData(lap)).toBe(true);
    expect(hasLimitData({ speed: [1, 2] })).toBe(false);
  });
  it("VSC is bit 2", () => {
    expect(limitAt({ flags: [FLAG_VSC | FLAG_ABS] }, "vsc", 0)).toBe(true);
    expect(limitAt({ flags: [FLAG_VSC | FLAG_ABS] }, "tc", 0)).toBe(false);
  });
});

describe("booleanRuns", () => {
  it("merges runs across short gaps and keeps longer ones apart", () => {
    const s = [false, true, true, false, true, false, false, false, true, true];
    expect(booleanRuns(s, 2)).toEqual([
      { k0: 1, k1: 4 }, // one clear point between: merged
      { k0: 8, k1: 9 }, // three clear points: separate
    ]);
    expect(booleanRuns(s, 0)).toEqual([{ k0: 1, k1: 2 }, { k0: 4, k1: 4 }, { k0: 8, k1: 9 }]);
    expect(booleanRuns([], 2)).toEqual([]);
    expect(MERGE_GAP_POINTS).toBe(2);
  });
});

describe("limitRuns", () => {
  it("lists every kind's runs in kind order, the ABS pulse train as one run", () => {
    expect(limitRuns(lap)).toEqual([
      { kind: "abs", k0: 2, k1: 5 },
      { kind: "lockup", k0: 3, k1: 3 },
      { kind: "tc", k0: 9, k1: 10 },
      { kind: "wheelspin", k0: 9, k1: 10 },
    ]);
  });
  it("skips the kinds whose channel is missing", () => {
    expect(limitRuns({ flags }).map((r) => r.kind)).toEqual(["abs", "tc"]);
    expect(limitRuns({ speed: [1, 2] })).toEqual([]);
  });
});

describe("activeLimitLabels", () => {
  it("names what is active at a grid point", () => {
    expect(activeLimitLabels(lap, 3)).toEqual(["Lockup"]);
    expect(activeLimitLabels(lap, 10)).toEqual(["Traction control", "Wheelspin"]);
    expect(activeLimitLabels(lap, 0)).toEqual([]);
  });
});

describe("sessionLimits / limitSummary", () => {
  const lap2 = {
    n: 2,
    timeMs: 91_000,
    speed: Array(20).fill(100),
    // ABS in the same zone, plus a second zone at k 15–16; no slip channel
    flags: flags.map((f, k) => (k === 15 || k === 16 ? FLAG_ABS : f & FLAG_ABS)),
  };

  it("counts distinct places across laps and the laps involved", () => {
    const sl = sessionLimits({ v: 1, dStepM: 20, laps: [lap, lap2, { n: 3, speed: [1, 2] }] });
    expect(sl.hasFlags).toBe(true);
    expect(sl.hasSlip).toBe(true);
    expect(sl.kinds).toEqual([
      { kind: "abs", places: 2, laps: 2 },
      { kind: "lockup", places: 1, laps: 1 },
      { kind: "tc", places: 1, laps: 1 },
      { kind: "wheelspin", places: 1, laps: 1 },
      { kind: "vsc", places: 0, laps: 0 },
    ]);
    expect(limitSummary({ v: 1, dStepM: 20, laps: [lap, lap2] })).toBe(
      "ABS in 2 braking zones, lockup in 1 braking zone, traction control in 1 acceleration zone, wheelspin in 1 acceleration zone"
    );
  });

  it("says no interventions when the systems never fired, and null without the channels", () => {
    const quiet = { v: 1, dStepM: 20, laps: [{ n: 1, flags: Array(20).fill(0) }] };
    expect(limitSummary(quiet)).toBe("no interventions");
    expect(sessionLimits(quiet).kinds.map((k) => k.kind)).toEqual(["abs", "tc", "vsc"]); // no slip channel: those kinds absent
    expect(limitSummary({ v: 1, dStepM: 20, laps: [{ n: 1, speed: [1, 2] }] })).toBeNull();
    expect(limitSummary(null)).toBeNull();
  });
});

describe("limitMarkers", () => {
  // A 380 m straight line trace sampled every 10 m, so distance fractions
  // map to indexes directly.
  const trace = Array.from({ length: 39 }, (_, i) => [i * 10, 0, 50]);

  it("places each run's mid-point on the trace by driven-distance fraction", () => {
    const m = limitMarkers(lap, 20, trace);
    expect(m.map((x) => x.kind)).toEqual(["abs", "lockup", "tc", "wheelspin"]);
    // ABS mid-point k=3.5 of 19 → 70 m of 380 → index 7 on the 10 m trace.
    expect(m[0]).toEqual({ kind: "abs", k0: 2, k1: 5, idx: 7 });
    expect(m[2].idx).toBe(19); // k=9.5 → 190 m
  });

  it("scales to the trace's own length when it differs from the grid length", () => {
    const shortTrace = Array.from({ length: 20 }, (_, i) => [i * 10, 0, 50]); // 190 m
    expect(limitMarkers(lap, 20, shortTrace)[0].idx).toBe(4); // 70/380 · 190 = 35 m → first point ≥ 35 m
  });

  it("is empty without a trace or without runs", () => {
    expect(limitMarkers(lap, 20, null)).toEqual([]);
    expect(limitMarkers({ speed: Array(20).fill(100), flags: Array(20).fill(0) }, 20, trace)).toEqual([]);
  });
});

describe("LIMIT_KINDS", () => {
  it("colours by side and never leaves two kinds of one side colour-alone", () => {
    for (const side of ["brake", "power"]) {
      const kinds = LIMIT_KINDS.filter((k) => k.side === side);
      expect(kinds).toHaveLength(2);
      expect(kinds[0].filled).not.toBe(kinds[1].filled);
    }
  });
});
