import { describe, expect, it } from "vitest";
import { bestLapTrace, buildGate, deriveLaps, gateCrossings, gateFromSegment, lapTrace, lapsFromCrossings, projectTrace } from "../../public/js/import/geo.js";
import { LAP_S, circleTrace } from "../fixtures/build.mjs";

const LAP_MS = Math.round(LAP_S() * 1000); // 47124

describe("projectTrace", () => {
  it("projects to meters relative to the origin", () => {
    const trace = projectTrace([
      { t: 0, lat: 36.56, lon: -79.2 },
      { t: 1, lat: 36.561, lon: -79.2 },
    ]);
    expect(trace[0]).toMatchObject({ x: 0, y: 0 });
    expect(trace[1].y).toBeCloseTo(110.54, 1); // 0.001 deg lat ≈ 110.5 m
    expect(trace[1].x).toBe(0);
  });

  it("uses a shared origin so gates transfer between traces", () => {
    const origin = { lat: 36.56, lon: -79.2 };
    const a = projectTrace([{ t: 0, lat: 36.561, lon: -79.2 }], origin);
    const b = projectTrace([{ t: 0, lat: 36.561, lon: -79.2 }], origin);
    expect(a[0]).toEqual(b[0]);
  });
});

describe("lap derivation on a circular trace", () => {
  const trace = projectTrace(circleTrace()); // 3.3 revolutions, lap ≈ 47.12s

  it("derives one lap per revolution across a picked point", () => {
    const idx = Math.round(0.25 * LAP_S() * 10); // quarter-turn point at 10 Hz
    const gate = buildGate(trace, idx);
    expect(gate).not.toBeNull();
    const laps = deriveLaps(trace, gate);
    expect(laps).toHaveLength(3);
    for (const lap of laps) {
      expect(Math.abs(lap.timeMs - LAP_MS)).toBeLessThan(200);
      expect(lap.estimated).toBe(true);
    }
  });

  it("derives the same laps from an explicit two-point gate", () => {
    const idx = Math.round(0.25 * LAP_S() * 10);
    const g = buildGate(trace, idx);
    const laps = deriveLaps(trace, gateFromSegment({ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 }));
    expect(laps).toHaveLength(3);
  });
});

describe("gateCrossings direction filter", () => {
  // Straight out-and-back: crosses y=0 northbound at t=10, southbound at t=110.
  const outAndBack = [];
  for (let i = 0; i <= 20; i++) outAndBack.push({ t: i, x: 0, y: (i - 10) * 10 });
  for (let i = 1; i <= 20; i++) outAndBack.push({ t: 100 + i, x: 0, y: (10 - i) * 10 });

  it("counts only crossings in the gate's direction of travel", () => {
    const gate = buildGate(outAndBack, 10); // heading north at the crossing
    expect(gateCrossings(outAndBack, gate)).toEqual([10]);
  });

  it("counts both directions for heading-less gates", () => {
    const gate = gateFromSegment({ x: -20, y: 0 }, { x: 20, y: 0 });
    expect(gateCrossings(outAndBack, gate)).toEqual([10, 110]);
  });

  it("treats near-simultaneous crossings as jitter", () => {
    const jitter = [
      { t: 0, x: 0, y: -5 },
      { t: 1, x: 0, y: 5 }, // crossing ~0.5
      { t: 2, x: 0, y: -5 }, // jitter back
      { t: 3, x: 0, y: 5 }, // crossing ~2.5, within minGapS
    ];
    const gate = gateFromSegment({ x: -20, y: 0 }, { x: 20, y: 0 });
    expect(gateCrossings(jitter, gate)).toHaveLength(1);
  });
});

describe("lapsFromCrossings", () => {
  it("drops deltas that can't be laps", () => {
    // 10s (jitter), 47s (lap), 2h gap (parked), 47s (lap)
    const laps = lapsFromCrossings([0, 10, 57, 7257, 7304]);
    expect(laps.map((l) => l.timeMs)).toEqual([47000, 47000]);
  });
});

describe("lapTrace", () => {
  const trace = projectTrace(circleTrace()); // 10 Hz samples

  it("slices the window and keeps [x, y, v] triples", () => {
    const out = lapTrace(trace, 0, LAP_S());
    expect(out.length).toBeGreaterThan(10);
    expect(out.length).toBeLessThanOrEqual(301);
    for (const p of out) {
      expect(p).toHaveLength(3);
      expect(p.every(Number.isFinite)).toBe(true);
    }
  });

  it("downsamples long windows to roughly the point budget", () => {
    const out = lapTrace(trace, 0, LAP_S(), 50);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out.length).toBeGreaterThan(25);
  });

  it("derives speed from the geometry when the source has none", () => {
    // circleTrace has no v — the circle is driven at constant speed, so
    // derived speeds should be nearly uniform and positive.
    const out = lapTrace(trace, 0, LAP_S());
    const speeds = out.map((p) => p[2]);
    expect(Math.min(...speeds)).toBeGreaterThan(0);
    expect(Math.max(...speeds) / Math.min(...speeds)).toBeLessThan(1.2);
  });

  it("returns null for windows with too few points", () => {
    expect(lapTrace(trace, 0, 0.5)).toBeNull();
  });
});

describe("bestLapTrace", () => {
  it("extracts one lap's worth of points across the gate", () => {
    const trace = projectTrace(circleTrace()); // 3.3 revolutions
    const gate = buildGate(trace, Math.round(0.25 * LAP_S() * 10));
    const out = bestLapTrace(trace, gate);
    expect(out).not.toBeNull();
    // one lap at 10 Hz ≈ 471 samples, downsampled to ≤ 300
    expect(out.length).toBeGreaterThan(100);
    expect(out.length).toBeLessThanOrEqual(301);
    // the lap starts and ends at the gate: closed loop, ends near each other
    const [first, last] = [out[0], out[out.length - 1]];
    expect(Math.hypot(first[0] - last[0], first[1] - last[1])).toBeLessThan(20);
  });

  it("returns null when no valid lap crosses the gate", () => {
    const straight = [];
    for (let i = 0; i <= 100; i++) straight.push({ t: i, x: i * 10, y: 0 });
    const gate = buildGate(straight, 50);
    expect(bestLapTrace(straight, gate)).toBeNull();
  });
});
