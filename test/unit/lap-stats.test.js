import { describe, expect, it } from "vitest";
import { bestNAvg, cleanLaps, paceSlope, warmupLapCount } from "../../public/js/lap-stats.js";

describe("cleanLaps", () => {
  it("drops laps slower than the 107% cutoff", () => {
    // best 100s -> cutoff 107s; the 130s out-lap goes
    expect(cleanLaps([130000, 100000, 105000, 106900])).toEqual([100000, 105000, 106900]);
  });

  it("handles empty input", () => {
    expect(cleanLaps([])).toEqual([]);
  });
});

describe("bestNAvg", () => {
  it("averages the best n laps", () => {
    expect(bestNAvg([125000, 121000, 123000, 129000], 3)).toBe((121000 + 123000 + 125000) / 3);
  });

  it("is null with fewer than n laps", () => {
    expect(bestNAvg([121000, 122000], 3)).toBeNull();
  });

  it("does not mutate the input", () => {
    const laps = [125000, 121000, 123000];
    bestNAvg(laps, 3);
    expect(laps).toEqual([125000, 121000, 123000]);
  });
});

describe("paceSlope", () => {
  it("is positive when laps get slower through the session", () => {
    // +500ms per lap, exactly
    expect(paceSlope([120000, 120500, 121000, 121500, 122000])).toBeCloseTo(500, 6);
  });

  it("is negative when still improving", () => {
    expect(paceSlope([122000, 121500, 121000, 120500, 120000])).toBeCloseTo(-500, 6);
  });

  it("ignores out-laps beyond the 107% cutoff", () => {
    // The 140s out-lap would swamp the trend; clean laps are flat.
    expect(paceSlope([140000, 120000, 120000, 120000, 120000])).toBeCloseTo(0, 6);
  });

  it("is null with fewer than 4 clean laps", () => {
    expect(paceSlope([120000, 121000, 122000])).toBeNull();
    expect(paceSlope([])).toBeNull();
  });
});

describe("warmupLapCount", () => {
  it("finds the first lap within 1% of the session best", () => {
    // best 120s -> threshold 121.2s; lap 3 is the first under it
    expect(warmupLapCount([130000, 124000, 121000, 120000])).toBe(3);
  });

  it("is 1 when on pace immediately", () => {
    expect(warmupLapCount([120000, 120500, 121000])).toBe(1);
  });

  it("is null with fewer than 2 laps", () => {
    expect(warmupLapCount([120000])).toBeNull();
    expect(warmupLapCount([])).toBeNull();
  });
});
