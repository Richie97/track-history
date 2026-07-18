import { describe, expect, it } from "vitest";
import {
  addFix,
  createRecording,
  deserializeRecording,
  fixSpeeds,
  serializeRecording,
  shouldAutoStop,
  toParsed,
  trimIdle,
} from "../../public/js/record/core.js";
import { buildGate, deriveLaps, projectTrace } from "../../public/js/import/geo.js";

const LAT0 = 36.56;
const LON0 = -79.2;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110540;

// A synthetic track day at 1Hz: idle in the paddock, then `laps` laps of a
// 200 m-radius circle at 25 m/s (~50.3 s/lap), then idle again.
function syntheticRecording({ idleBeforeS = 120, laps = 5, idleAfterS = 120, speed = 25, startedAtMs = 1750000000000 } = {}) {
  const rec = createRecording("ev1", startedAtMs);
  const r = 200;
  const lapS = (2 * Math.PI * r) / speed;
  const driveS = Math.round(laps * lapS);
  let t = 0;
  const push = (lat, lon, v) =>
    addFix(rec, { timeMs: startedAtMs + t++ * 1000, lat, lon, speed: v, accuracy: 5 });
  for (let i = 0; i < idleBeforeS; i++) push(LAT0, LON0 - 500 / KX, 0);
  for (let i = 0; i <= driveS; i++) {
    const a = (i * speed) / r;
    push(LAT0 + (r * Math.sin(a)) / KY, LON0 + (r * Math.cos(a)) / KX, speed);
  }
  for (let i = 0; i < idleAfterS; i++) push(LAT0, LON0 - 500 / KX, 0);
  return { rec, lapS, driveS };
}

describe("addFix", () => {
  it("keeps plausible fixes and rejects garbage", () => {
    const rec = createRecording("e", 1000);
    expect(addFix(rec, { timeMs: 2000, lat: 36.5, lon: -79.2, speed: 3, accuracy: 8 })).toBe(true);
    expect(addFix(rec, { timeMs: 3000, lat: NaN, lon: -79.2 })).toBe(false);
    expect(addFix(rec, { timeMs: 4000, lat: 95, lon: -79.2 })).toBe(false);
    expect(addFix(rec, { timeMs: 5000, lat: 36.5, lon: -79.2, accuracy: 500 })).toBe(false); // hopeless accuracy
    expect(addFix(rec, { timeMs: 500, lat: 36.5, lon: -79.2 })).toBe(false); // before start
    expect(addFix(rec, { timeMs: 2000, lat: 36.5, lon: -79.2 })).toBe(false); // not after the last fix
    expect(rec.fixes).toHaveLength(1);
    expect(rec.fixes[0]).toEqual([1, 36.5, -79.2, 3, 8]);
  });

  it("stores null for missing speed/accuracy", () => {
    const rec = createRecording("e", 0);
    addFix(rec, { timeMs: 1000, lat: 1, lon: 2 });
    expect(rec.fixes[0]).toEqual([1, 1, 2, null, null]);
  });
});

describe("fixSpeeds", () => {
  it("prefers reported speed and falls back to displacement rate", () => {
    const rec = createRecording("e", 0);
    addFix(rec, { timeMs: 1000, lat: LAT0, lon: LON0 });
    addFix(rec, { timeMs: 2000, lat: LAT0 + 20 / KY, lon: LON0 }); // 20 m north in 1 s
    addFix(rec, { timeMs: 3000, lat: LAT0 + 40 / KY, lon: LON0, speed: 7 });
    const speeds = fixSpeeds(rec.fixes);
    expect(speeds[1]).toBeCloseTo(20, 0); // (40 m over 2 s window)
    expect(speeds[2]).toBe(7);
  });
});

describe("shouldAutoStop", () => {
  it("stops after long-stationary once the car has been driven at pace", () => {
    const { rec, driveS } = syntheticRecording({ idleAfterS: 0 });
    const endMs = rec.startedAtMs + (120 + driveS) * 1000;
    expect(shouldAutoStop(rec, endMs + 5 * 60 * 1000)).toBe(false);
    expect(shouldAutoStop(rec, endMs + 16 * 60 * 1000)).toBe(true);
  });

  it("never stops during a slow-speed wait before the first lap", () => {
    const rec = createRecording("e", 0);
    // paddock crawl at 3 m/s, then a 20-minute grid wait — no track pace yet
    for (let t = 0; t < 60; t++) {
      addFix(rec, { timeMs: t * 1000, lat: LAT0 + (3 * t) / KY, lon: LON0, speed: 3 });
    }
    expect(shouldAutoStop(rec, 60 * 1000 + 20 * 60 * 1000)).toBe(false);
  });

  it("always stops at the hard duration cap", () => {
    const rec = createRecording("e", 0);
    addFix(rec, { timeMs: 1000, lat: LAT0, lon: LON0, speed: 0 });
    expect(shouldAutoStop(rec, 5 * 3600 * 1000)).toBe(true);
  });
});

describe("trimIdle", () => {
  it("cuts stationary tails but keeps a margin around the driving", () => {
    const { rec, driveS } = syntheticRecording();
    const trimmed = trimIdle(rec.fixes);
    expect(trimmed.length).toBeGreaterThan(0);
    const t0 = trimmed[0][0];
    const t1 = trimmed[trimmed.length - 1][0];
    expect(t0).toBeGreaterThanOrEqual(120 - 31);
    expect(t0).toBeLessThan(120);
    expect(t1).toBeGreaterThan(120 + driveS);
    expect(t1).toBeLessThanOrEqual(120 + driveS + 31);
  });

  it("returns nothing for a recording that never moved", () => {
    const rec = createRecording("e", 0);
    for (let t = 0; t < 100; t++) addFix(rec, { timeMs: t * 1000, lat: LAT0, lon: LON0, speed: 0 });
    expect(trimIdle(rec.fixes)).toEqual([]);
  });
});

describe("toParsed", () => {
  it("produces a parser-contract object whose laps derive via the line picker path", () => {
    const { rec, lapS } = syntheticRecording();
    const parsed = toParsed(rec);
    expect(parsed.kind).toBe("live");
    expect(parsed.needsLine).toBe(true);
    expect(parsed.laps).toEqual([]);
    expect(parsed.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parsed.time).toMatch(/^\d{2}:\d{2}$/);
    expect(parsed.gps.length).toBeGreaterThan(200);

    // The exact flow js/import/ui.js runs after a line pick:
    const trace = projectTrace(parsed.gps);
    // pick a point mid-drive (away from the trim margins) as the start/finish
    const idx = Math.floor(trace.length / 2);
    const gate = buildGate(trace, idx);
    expect(gate).not.toBeNull();
    const laps = deriveLaps(trace, gate);
    expect(laps.length).toBeGreaterThanOrEqual(3);
    for (const lap of laps) {
      expect(lap.timeMs / 1000).toBeGreaterThan(lapS - 2);
      expect(lap.timeMs / 1000).toBeLessThan(lapS + 2);
      expect(lap.estimated).toBe(true);
    }
  });

  it("returns null for recordings too short to time", () => {
    const rec = createRecording("e", 0);
    for (let t = 0; t < 20; t++) {
      addFix(rec, { timeMs: t * 1000, lat: LAT0 + (25 * t) / KY, lon: LON0, speed: 25 });
    }
    expect(toParsed(rec)).toBeNull();
  });
});

describe("checkpoint serialization", () => {
  it("round-trips a recording", () => {
    const { rec } = syntheticRecording({ laps: 1, idleBeforeS: 5, idleAfterS: 5 });
    const back = deserializeRecording(serializeRecording(rec));
    expect(back).toEqual(rec);
  });

  it("rejects corrupt checkpoints instead of throwing", () => {
    expect(deserializeRecording(null)).toBeNull();
    expect(deserializeRecording("not json{")).toBeNull();
    expect(deserializeRecording('{"v":99,"fixes":[]}')).toBeNull();
    expect(deserializeRecording('{"v":1,"startedAtMs":0,"fixes":[["x"]]}')).toBeNull();
  });
});
