import { describe, expect, it } from "vitest";
import { applyGate, metricsSummary } from "../../public/js/import/ui.js";
import { buildGate, projectTrace } from "../../public/js/import/geo.js";
import { anchorPdrBatch } from "../../public/js/import/pdr-laps.js";
import { parseVboText } from "../../public/js/import/vbo.js";
import { parseTelemetryFile } from "../../public/js/import/parse.js";
import { LAP_S, buildPdrMp4, buildPdrRealMp4, buildVboText, circleTrace } from "../fixtures/build.mjs";

describe("applyGate across longitude sign conventions", () => {
  it("applies one picked line to west-positive (VBO) and east-positive (GPS) traces", () => {
    const points = circleTrace();
    // VBO parse preserves Racelogic's west-positive longitude (+79.2);
    // a GoPro trace of the same laps uses standard sign (-79.2).
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

  it("re-anchors a beacon-less PDR file to a batch-mate's start/finish", async () => {
    // File A: beacons at angle (40*30/300) = 4.0 rad. File B: same circle,
    // no beacons, pit-out at angle 1.0 rad.
    const lapS = (2 * Math.PI * 300) / 40;
    const withBeacons = await parseTelemetryFile(
      new File([buildPdrRealMp4({ beaconTimes: [30, 30 + lapS, 30 + 2 * lapS] })], "afternoon.mp4")
    );
    const noBeacons = await parseTelemetryFile(
      new File([buildPdrRealMp4({ startAngle: 1.0 })], "morning.mp4")
    );
    expect(noBeacons.lapRecovery.anchored).toBe(false);

    const results = [
      { file: "afternoon.mp4", parsed: withBeacons },
      { file: "morning.mp4", parsed: noBeacons },
    ];
    anchorPdrBatch(results);

    expect(noBeacons.lapRecovery.anchored).toBe(true);
    // The start/finish (4.0 rad) is 3.0 rad past B's pit-out: 900m / 22.5s in.
    expect(Math.abs(noBeacons.laps[0].startT - 22.5)).toBeLessThan(0.5);
    for (const lap of noBeacons.laps) {
      expect(lap.estimated).toBe(true);
      expect(Math.abs(lap.timeMs - lapS * 1000)).toBeLessThan(300);
    }
  });

  it("leaves recovered laps alone when no template matches the lap length", async () => {
    // Template lap ~1885m, beacon-less file drives a much smaller circle.
    const lapS = (2 * Math.PI * 300) / 40;
    const withBeacons = await parseTelemetryFile(
      new File([buildPdrRealMp4({ beaconTimes: [30, 30 + lapS, 30 + 2 * lapS] })], "big-track.mp4")
    );
    const smallCircle = await parseTelemetryFile(
      new File([buildPdrRealMp4({ radius: 200, revolutions: 4 })], "small-track.mp4")
    );
    const before = smallCircle.laps.map((l) => l.startT);
    anchorPdrBatch([
      { file: "big-track.mp4", parsed: withBeacons },
      { file: "small-track.mp4", parsed: smallCircle },
    ]);
    expect(smallCircle.lapRecovery.anchored).toBe(false);
    expect(smallCircle.laps.map((l) => l.startT)).toEqual(before);
  });

  it("clears derived laps when the gate is cleared", () => {
    const parsed = { kind: "gopro", needsLine: true, gps: circleTrace(), laps: [{ timeMs: 1, estimated: true }] };
    applyGate({ results: [{ file: "x.mp4", parsed }], origin: parsed.gps[0], gate: null });
    expect(parsed.laps).toEqual([]);
  });
});

describe("metricsSummary", () => {
  it("formats the car channels and skips missing ones", () => {
    expect(metricsSummary({ metrics: { topSpeedKph: 194.5, maxRpm: 6702.6, maxLatG: 1.432 } })).toBe(
      "top speed 121 mph · max 6,703 rpm · 1.43 G lateral"
    );
    expect(metricsSummary({ metrics: { topSpeedKph: 150.1, maxRpm: null, maxLatG: null } })).toBe(
      "top speed 93 mph"
    );
  });

  it("is empty for sources without metrics", () => {
    expect(metricsSummary({ kind: "gopro" })).toBe("");
    expect(metricsSummary({ metrics: { topSpeedKph: null, maxRpm: null, maxLatG: null } })).toBe("");
  });
});
