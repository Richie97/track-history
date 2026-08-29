import { describe, expect, it } from "vitest";
import {
  ARM_MPS,
  addTimingFix,
  createLiveTiming,
  liveTimingDisplay,
  liveTimingFromFixes,
} from "../../public/js/record/live-timing.js";

const LAT0 = 36.56;
const LON0 = -79.2;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110540;
const R = 200; // circle radius, meters

// Fix tuples ([tRelS, lat, lon, v, acc], the core.js recording shape) driving
// a 200 m circle at 5 Hz, one entry in `lapSpeeds` per lap (m/s). Constant
// speed within a lap, so time-at-distance is analytic and deltas are exact.
function circleFixes(lapSpeeds, { hz = 5 } = {}) {
  const fixes = [];
  let t = 0;
  let a = 0;
  const dt = 1 / hz;
  for (const v of lapSpeeds) {
    const lapS = (2 * Math.PI * R) / v;
    const n = Math.round(lapS * hz);
    for (let i = 0; i < n; i++) {
      fixes.push([
        Math.round(t * 100) / 100,
        LAT0 + (R * Math.sin(a)) / KY,
        LON0 + (R * Math.cos(a)) / KX,
        v,
        5,
      ]);
      t += dt;
      a += (v * dt) / R;
    }
  }
  return fixes;
}

const LAP_25_MS = Math.round(((2 * Math.PI * R) / 25) * 1000); // ≈ 50265

describe("addTimingFix", () => {
  it("stays disarmed below track pace", () => {
    const lt = createLiveTiming();
    for (const f of circleFixes([5]).slice(0, 100)) addTimingFix(lt, f);
    expect(lt.gate).toBeNull();
    expect(liveTimingDisplay(lt, 20).currentLapS).toBeNull();
  });

  it("arms at track pace and times laps at the circle period", () => {
    const lt = liveTimingFromFixes(circleFixes([25, 25, 25, 25]));
    expect(lt.gate).not.toBeNull();
    expect(lt.lapCount).toBe(3); // the 4th lap's final crossing lands after the last fix
    expect(Math.abs(lt.lastLapMs - LAP_25_MS)).toBeLessThan(150);
    expect(Math.abs(lt.bestLapMs - LAP_25_MS)).toBeLessThan(150);
  });

  it("shows a growing positive delta on a slower lap", () => {
    const lt = createLiveTiming();
    const laps = circleFixes([25, 25, 20]);
    for (const f of laps) addTimingFix(lt, f);
    // Mid-way through the 20 m/s lap: t = d/20 vs best t = d/25 → d/100 s.
    // The last fixes of the slow lap sit near d ≈ 2πR, so the delta is near
    // 2πR/100 ≈ 12.6 s and must be positive well before that.
    expect(lt.deltaS).toBeGreaterThan(8);
    const display = liveTimingDisplay(lt, laps[laps.length - 1][0]);
    expect(display.deltaS).toBe(lt.deltaS);
    expect(display.bestLapMs).toBe(lt.bestLapMs);
  });

  it("promotes a faster lap to the reference", () => {
    const lt = liveTimingFromFixes(circleFixes([25, 30, 30]));
    // Lap 2 at 30 m/s beats lap 1's 25 m/s time and becomes the best.
    const lap30 = Math.round(((2 * Math.PI * R) / 30) * 1000);
    expect(Math.abs(lt.bestLapMs - lap30)).toBeLessThan(150);
    expect(lt.bestLapMs).toBeLessThan(LAP_25_MS);
  });

  it("negative delta when running ahead of the best lap", () => {
    const lt = createLiveTiming();
    const fixes = circleFixes([25, 30]);
    // Stop feeding mid-way through the faster lap: still in progress.
    const cut = Math.floor(fixes.length * 0.85);
    for (const f of fixes.slice(0, cut)) addTimingFix(lt, f);
    expect(lt.lapCount).toBe(1);
    expect(lt.deltaS).toBeLessThan(-1);
  });

  it("replay equals incremental feeding", () => {
    const fixes = circleFixes([25, 22, 28]);
    const inc = createLiveTiming();
    for (const f of fixes) addTimingFix(inc, f);
    const replay = liveTimingFromFixes(fixes);
    expect(liveTimingDisplay(replay, 500)).toEqual(liveTimingDisplay(inc, 500));
    expect(replay.bestLapMs).toBe(inc.bestLapMs);
  });

  it("arming needs a real heading, not a GPS teleport at zero speed", () => {
    const lt = createLiveTiming();
    // Two fixes at the same spot: speed claims track pace but there is no
    // displacement to build a gate across. Must stay disarmed, not divide by
    // zero.
    addTimingFix(lt, [0, LAT0, LON0, ARM_MPS + 1, 5]);
    addTimingFix(lt, [1, LAT0, LON0 + 0.5 / KX, ARM_MPS + 1, 5]);
    expect(lt.gate).toBeNull();
  });
});
