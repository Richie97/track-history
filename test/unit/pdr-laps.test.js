import { describe, expect, it } from "vitest";
import {
  cutLapsAtDistance,
  findLapLength,
  latDistanceProfile,
  matchPhase,
  recoverPdrLaps,
} from "../../public/js/import/pdr-laps.js";

// Synthetic real-firmware channels: latitude at 2Hz, cumulative odometer at
// ~7Hz, car lapping the 300m-radius reference circle at 40 m/s.
const RADIUS = 300;
const SPEED = 40;
const LAP_M = 2 * Math.PI * RADIUS; // 1884.96m
const LAP_MS = (LAP_M / SPEED) * 1000; // 47124ms

function circleChannels({ revolutions = 3.3, startAngle = 0, lat0 = 36.56 } = {}) {
  const totalS = (LAP_M * revolutions) / SPEED;
  const latPts = [], odoPts = [];
  for (let t = 0; t <= totalS; t += 0.5) {
    const lat = lat0 + (RADIUS * Math.sin(startAngle + (SPEED * t) / RADIUS)) / 110540;
    latPts.push({ t, v: Math.round(lat * 1e7) });
  }
  for (let t = 0; t <= totalS; t += 0.15) {
    odoPts.push({ t, v: Math.round(SPEED * t) });
  }
  return { latPts, odoPts };
}

describe("findLapLength", () => {
  it("recovers the lap length from lat(distance) periodicity", () => {
    const { latPts, odoPts } = circleChannels();
    const profile = latDistanceProfile(latPts, odoPts);
    const found = findLapLength(profile);
    expect(found).not.toBeNull();
    expect(Math.abs(found.lapM - LAP_M)).toBeLessThan(10);
    expect(found.r).toBeGreaterThan(0.95);
  });

  it("prefers the true lap length over its multiples", () => {
    const { latPts, odoPts } = circleChannels({ revolutions: 5 });
    const found = findLapLength(latDistanceProfile(latPts, odoPts));
    // with 5 laps of data, 2x the lap length correlates just as well —
    // the smallest strong peak must win
    expect(Math.abs(found.lapM - LAP_M)).toBeLessThan(10);
  });

  it("rejects straight-line driving (linear lat correlates at every lag)", () => {
    const latPts = [], odoPts = [];
    for (let t = 0; t <= 200; t += 0.5) latPts.push({ t, v: Math.round((36.56 + (SPEED * t) / 110540) * 1e7) });
    for (let t = 0; t <= 200; t += 0.15) odoPts.push({ t, v: Math.round(SPEED * t) });
    const profile = latDistanceProfile(latPts, odoPts);
    expect(profile).not.toBeNull(); // 8km of driving — plenty of distance...
    expect(findLapLength(profile)).toBeNull(); // ...but no lap periodicity
  });
});

describe("latDistanceProfile", () => {
  it("refuses paddock footage (not enough distance for two laps)", () => {
    const latPts = [], odoPts = [];
    for (let t = 0; t <= 600; t += 0.5) latPts.push({ t, v: Math.round((36.56 + (8 * Math.sin(t / 45)) / 110540) * 1e7) });
    for (let t = 0; t <= 600; t += 0.15) odoPts.push({ t, v: Math.round(t * 1.2) }); // 720m crawled
    expect(latDistanceProfile(latPts, odoPts)).toBeNull();
  });

  it("refuses thin channels", () => {
    expect(latDistanceProfile([], [])).toBeNull();
    expect(latDistanceProfile(null, null)).toBeNull();
  });
});

describe("matchPhase + cutLapsAtDistance", () => {
  it("locates the template's start/finish in a session that began elsewhere", () => {
    // Template: one lap of lat(distance) starting at angle 4.0 rad.
    const theta = 4.0;
    const tmpl = [];
    for (let d = 0; d < LAP_M; d += 5) tmpl.push(36.56 + (RADIUS * Math.sin(theta + d / RADIUS)) / 110540);
    // Session: same circle, pit-out at angle 1.0 rad.
    const { latPts, odoPts } = circleChannels({ startAngle: 1.0 });
    const profile = latDistanceProfile(latPts, odoPts);
    const phase = matchPhase(profile, tmpl, LAP_M);
    expect(phase).not.toBeNull();
    expect(phase.r).toBeGreaterThan(0.95);
    // start/finish is (4.0 - 1.0) rad ahead of the session start
    expect(Math.abs(phase.offsetM - 3.0 * RADIUS)).toBeLessThan(15);

    const laps = cutLapsAtDistance(odoPts, profile.d0 + phase.offsetM, LAP_M);
    expect(laps.length).toBeGreaterThanOrEqual(2);
    for (const lap of laps) {
      expect(lap.estimated).toBe(true);
      expect(Math.abs(lap.timeMs - LAP_MS)).toBeLessThan(300);
    }
    // first boundary lands when the car reaches the start/finish angle
    expect(Math.abs(laps[0].startT - (3.0 * RADIUS) / SPEED)).toBeLessThan(0.5);
  });
});

describe("recoverPdrLaps", () => {
  it("cuts rolling laps of the right length without any template", () => {
    const channels = circleChannels();
    const rec = recoverPdrLaps(channels);
    expect(rec).not.toBeNull();
    expect(rec.anchored).toBe(false);
    expect(rec.laps).toHaveLength(3); // 3.3 revolutions
    for (const lap of rec.laps) {
      expect(lap.estimated).toBe(true);
      expect(Math.abs(lap.timeMs - LAP_MS)).toBeLessThan(300);
    }
  });

  it("returns null when there is nothing lap-like", () => {
    expect(recoverPdrLaps(null)).toBeNull();
    expect(recoverPdrLaps({ latPts: [], odoPts: [] })).toBeNull();
  });
});
