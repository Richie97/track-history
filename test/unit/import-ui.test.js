import { describe, expect, it } from "vitest";
import { applyGate } from "../../public/js/import/ui.js";
import { buildGate, projectTrace } from "../../public/js/import/geo.js";
import { parseVboText } from "../../public/js/import/vbo.js";
import { parseTelemetryFile } from "../../public/js/import/parse.js";
import { LAP_S, buildPdrMp4, buildVboText, circleTrace } from "../fixtures/build.mjs";

describe("applyGate across longitude sign conventions", () => {
  it("applies one picked line to west-positive (VBO) and east-positive (GPS) traces", () => {
    const points = circleTrace();
    // VBO parse preserves Racelogic's west-positive longitude (+79.2);
    // a GoPro/FIT trace of the same laps uses standard sign (-79.2).
    const vbo = parseVboText(buildVboText(points));
    const gps = { kind: "gopro", needsLine: true, gps: points, laps: [] };

    const state = {
      results: [{ file: "a.vbo", parsed: vbo }, { file: "b.mp4", parsed: gps }],
      origin: vbo.gps[0],
      gate: null,
    };
    // Pick the line on the displayed (VBO) trace at a quarter revolution.
    const pickTrace = projectTrace(vbo.gps, state.origin);
    state.gate = buildGate(pickTrace, Math.round(0.25 * LAP_S() * 10));

    applyGate(state);
    expect(vbo.laps).toHaveLength(3);
    expect(gps.laps).toHaveLength(3); // mirrored automatically
    for (const lap of [...vbo.laps, ...gps.laps]) {
      expect(Math.abs(lap.timeMs - LAP_S() * 1000)).toBeLessThan(300);
    }
  });

  it("leaves laps empty when a trace is genuinely elsewhere", () => {
    const other = circleTrace({ lat0: 40.0, lon0: -75.0 }); // different track
    const vbo = parseVboText(buildVboText(circleTrace()));
    const state = {
      results: [{ file: "elsewhere.mp4", parsed: { kind: "gopro", needsLine: true, gps: other, laps: [] } }],
      origin: vbo.gps[0],
      gate: buildGate(projectTrace(vbo.gps, vbo.gps[0]), 100),
    };
    applyGate(state);
    expect(state.results[0].parsed.laps).toEqual([]);
  });

  it("times a beacon-less PDR file's laps from the picked line", async () => {
    const file = new File([buildPdrMp4({ beaconTimes: [], gpsPoints: circleTrace() })], "pdr.mp4");
    const parsed = await parseTelemetryFile(file);
    const state = { results: [{ file: "pdr.mp4", parsed }], origin: parsed.gps[0], gate: null };
    const pickTrace = projectTrace(parsed.gps, state.origin);
    state.gate = buildGate(pickTrace, Math.round(0.25 * LAP_S() * 10));

    applyGate(state);
    expect(parsed.laps).toHaveLength(3);
    for (const lap of parsed.laps) {
      expect(lap.estimated).toBe(true);
      expect(Math.abs(lap.timeMs - LAP_S() * 1000)).toBeLessThan(300);
    }
    expect(parsed.bestLapTrace.length).toBeGreaterThan(10);
  });

  it("clears derived laps when the gate is cleared", () => {
    const parsed = { kind: "gopro", needsLine: true, gps: circleTrace(), laps: [{ timeMs: 1, estimated: true }] };
    applyGate({ results: [{ file: "x.mp4", parsed }], origin: parsed.gps[0], gate: null });
    expect(parsed.laps).toEqual([]);
  });
});
