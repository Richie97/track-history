import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_FIT_SESSIONS, steeringFit } from "../../src/lib/steering";
import { steeringFit as reference } from "../../public/js/balance.js";

// `src/lib/steering.ts` is a mirror of `steeringFit` in `public/js/balance.js`
// (the two share no code by convention), so it is pinned to the fixture the
// web implementation generated rather than tested on its own terms — the same
// arrangement as the native ports. Every case there is asserted here, nulls
// included, and the reference itself is run alongside so the pin cannot go
// stale without `npm run contracts:logic` saying so.
const fixture = JSON.parse(readFileSync(new URL("../../contracts/logic/balance.json", import.meta.url), "utf8"));
const { sessions } = fixture.input.steering;
const want = fixture.expected.steering.fits;

describe("steeringFit (server mirror)", () => {
  it("matches the web reference on every fixture session", () => {
    for (const [name, channels] of Object.entries(sessions)) {
      const got = steeringFit(channels);
      const expected = want[name];
      if (expected == null) {
        expect(got, name).toBeNull();
        continue;
      }
      expect(got, name).not.toBeNull();
      expect(got.samples, `${name} samples`).toBe(expected.samples);
      expect(got.gain0, `${name} gain0`).toBeCloseTo(expected.gain0, 12);
      expect(got.K, `${name} K`).toBeCloseTo(expected.K, 12);
      expect(got.r2, `${name} r2`).toBeCloseTo(expected.r2, 12);
      // And the reference agrees with its own fixture — the pin is live.
      expect(reference(channels)).toEqual(expected);
    }
  });

  it("recovers the model's ratio and gradient exactly", () => {
    const fit = steeringFit(sessions.model);
    expect(fit.gain0).toBeCloseTo(1 / (16.25 * 2.71), 9);
    expect(fit.K).toBeCloseTo(0.0014, 9);
    expect(fit.r2).toBeCloseTo(1, 9);
  });

  it("is null for nothing and for laps without the three channels", () => {
    expect(steeringFit(null)).toBeNull();
    expect(steeringFit({ v: 1, dStepM: 20, laps: [] })).toBeNull();
    expect(steeringFit({ v: 1, dStepM: 20, laps: [{ n: 1, timeMs: 1000, speed: [100] }] })).toBeNull();
  });

  it("fits a couple of track days' worth of sessions", () => {
    expect(MAX_FIT_SESSIONS).toBe(8);
  });
});
