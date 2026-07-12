import { describe, expect, it } from "vitest";
import { parseFitBuffer } from "../../public/js/import/fit.js";
import { buildGate, deriveLaps, projectTrace } from "../../public/js/import/geo.js";
import { LAP_S, buildFitLaps, buildFitRecords, circleTrace } from "../fixtures/build.mjs";

describe("parseFitBuffer with lap messages (Garmin Catalyst shape)", () => {
  it("returns device-computed laps as exact", () => {
    const out = parseFitBuffer(buildFitLaps({ lapMs: [47120, 46800, 47500] }).buffer);
    expect(out.kind).toBe("fit");
    expect(out.laps.map((l) => l.timeMs)).toEqual([47120, 46800, 47500]);
    expect(out.laps.every((l) => l.estimated === false)).toBe(true);
    expect(out.needsLine).toBe(false);
    expect(out.date).toBe("2026-06-20");
    expect(out.time).toBe("13:15:00");
  });
});

describe("parseFitBuffer with only GPS records", () => {
  it("returns a trace that needs a line", () => {
    const points = circleTrace({ hz: 1 });
    const out = parseFitBuffer(buildFitRecords(points).buffer);
    expect(out.laps).toEqual([]);
    expect(out.needsLine).toBe(true);
    expect(out.gps.length).toBe(points.length);
    expect(out.gps[0].lat).toBeCloseTo(36.56, 5);
    expect(out.gps[0].v).toBeCloseTo(40, 3);
  });

  it("supports line picking on the decoded trace", () => {
    const out = parseFitBuffer(buildFitRecords(circleTrace({ hz: 1 })).buffer);
    const trace = projectTrace(out.gps, out.gps[0]);
    const gate = buildGate(trace, Math.round(0.25 * LAP_S()));
    const laps = deriveLaps(trace, gate);
    expect(laps).toHaveLength(3);
    // 1 Hz timestamps -> coarser interpolation, still lap-accurate to ~1s
    for (const lap of laps) expect(Math.abs(lap.timeMs - LAP_S() * 1000)).toBeLessThan(1500);
  });
});

describe("parseFitBuffer validation", () => {
  it("rejects non-FIT data", () => {
    expect(() => parseFitBuffer(new Uint8Array(20).buffer)).toThrow(/FIT/);
  });
});
