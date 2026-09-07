import { describe, expect, it } from "vitest";
import { parseStoredChannels, publicLapChannels } from "../../src/lib/leaderboard";
import { GRIDDED_CHANNEL_NAMES } from "../../src/lib/validate";

// NS-35: what a shared leaderboard lap publishes. The route tests
// (test/api/leaderboard-lap.test.ts) cover who may read it; these cover what
// they get.

const arr = (v: number) => Array.from({ length: 12 }, (_, i) => v + i);

const stored = {
  v: 1 as const,
  dStepM: 20,
  meta: { ambientC: 21.5, intakeC: 44, elevationM: 320, odometerKm: 41234 },
  laps: [
    { n: 1, timeMs: 95000, speed: arr(90), oilC: 110 },
    {
      n: 2,
      timeMs: 93211,
      speed: arr(100),
      throttle: arr(10),
      brake: arr(0),
      steering: arr(-5),
      oilC: 118.5,
      fuelPct: 42.5,
      tyreKpaLF: 210,
      battV: 13.9,
    },
  ],
};

describe("publicLapChannels", () => {
  it("publishes only the matching lap, in the stored one-lap shape", () => {
    const out = publicLapChannels(stored, 93211)!;
    expect(out.v).toBe(1);
    expect(out.dStepM).toBe(20);
    expect(out.laps).toHaveLength(1);
    expect(out.laps[0].n).toBe(2);
    expect(out.laps[0].timeMs).toBe(93211);
    expect(out.laps[0].speed).toEqual(arr(100));
    expect(out.laps[0].steering).toEqual(arr(-5));
  });

  it("drops the per-lap scalars and the session meta", () => {
    const out = publicLapChannels(stored, 93211)!;
    expect(Object.keys(out.laps[0]).sort()).toEqual(
      ["brake", "n", "speed", "steering", "throttle", "timeMs"]
    );
    // The car's lifetime odometer is the most identifying number in the blob.
    expect(out.meta).toBeUndefined();
  });

  // The exclusion has to survive a channel nobody has thought of yet: the
  // entry is built by copying the allow-list, so a field outside it can only
  // be published deliberately.
  it("copies every gridded channel and nothing else", () => {
    const every = {
      v: 1 as const,
      dStepM: 20,
      laps: [
        {
          n: 1,
          timeMs: 90000,
          ...Object.fromEntries(GRIDDED_CHANNEL_NAMES.map((k) => [k, arr(1)])),
          somethingNew: 7,
          oilC: 100,
        },
      ],
    };
    const out = publicLapChannels(every as never, 90000)!;
    expect(Object.keys(out.laps[0]).sort()).toEqual(
      ["n", "timeMs", ...GRIDDED_CHANNEL_NAMES].sort()
    );
  });

  it("is null when no entry matches the lap time", () => {
    expect(publicLapChannels(stored, 12345)).toBeNull();
    expect(publicLapChannels(null, 93211)).toBeNull();
  });

  // A lap time restated as an object is not telemetry — the response already
  // carries the time.
  it("is null when the matching entry carries no traces", () => {
    const scalarsOnly = { v: 1 as const, dStepM: 20, laps: [{ n: 1, timeMs: 90000, oilC: 100 }] };
    expect(publicLapChannels(scalarsOnly, 90000)).toBeNull();
  });
});

describe("parseStoredChannels", () => {
  it("reads a stored blob and degrades to null on anything else", () => {
    expect(parseStoredChannels(JSON.stringify(stored))?.dStepM).toBe(20);
    expect(parseStoredChannels(null)).toBeNull();
    expect(parseStoredChannels("")).toBeNull();
    expect(parseStoredChannels("{ not json")).toBeNull();
    expect(parseStoredChannels("[]")).toBeNull();
    expect(parseStoredChannels(JSON.stringify({ dStepM: 20 }))).toBeNull();
  });
});
