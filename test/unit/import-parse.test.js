import { describe, expect, it } from "vitest";
import { parseTelemetryFile } from "../../public/js/import/parse.js";
import { buildGpmfMp4, buildPdrDeltaMp4, buildPdrMp4, buildPdrRealMp4, buildVboText, circleTrace } from "../fixtures/build.mjs";
import { emptyMp4 } from "./gpmf.test.js";

describe("parseTelemetryFile dispatch", () => {
  it("still parses Corvette PDR MP4s exactly as before (regression)", async () => {
    // beacons at 100s / 147.12s / 194.24s -> two exact laps of 47.12s
    const file = new File([buildPdrMp4()], "pdr-session.mp4");
    const out = await parseTelemetryFile(file);
    expect(out.kind).toBe("pdr");
    expect(out.laps.map((l) => l.timeMs)).toEqual([47120, 47120]);
    expect(out.laps.every((l) => l.estimated === false)).toBe(true);
    expect(out.needsLine).toBe(false);
    expect(out.beaconCount).toBe(3);
  });

  it("falls through to GoPro GPMF for non-PDR MP4s", async () => {
    const file = new File([buildGpmfMp4(circleTrace())], "GX010042.MP4");
    const out = await parseTelemetryFile(file);
    expect(out.kind).toBe("gopro");
    expect(out.needsLine).toBe(true);
    expect(out.gps.length).toBeGreaterThan(100);
  });

  it("dispatches .vbo by extension", async () => {
    const vbo = await parseTelemetryFile(new File([buildVboText(circleTrace())], "session.VBO"));
    expect(vbo.kind).toBe("vbo");
  });

  it("reports a combined error for MP4s with neither telemetry flavour", async () => {
    await expect(parseTelemetryFile(new File([emptyMp4()], "dashcam.mp4"))).rejects.toThrow(
      /No PDR or GoPro telemetry/
    );
  });
});

describe("delta-encoded PDR (real firmware shape)", () => {
  it("beacon-timed laps cut a best-lap trace from the delta-decoded GPS", async () => {
    const lapS = (2 * Math.PI * 300) / 40;
    const file = new File([buildPdrDeltaMp4({ beaconTimes: [30, 30 + lapS, 30 + 2 * lapS] })], "pdr-c8.mp4");
    const out = await parseTelemetryFile(file);
    expect(out.kind).toBe("pdr");
    expect(out.laps).toHaveLength(2);
    expect(out.needsLine).toBe(false);
    expect(out.gps.length).toBeGreaterThan(100);
    expect(out.bestLapTrace.length).toBeGreaterThan(10);
    expect(out.metrics.topSpeedKph).toBeGreaterThan(140);
  });

  it("sends a beacon-less recording to the line picker on its GPS trace", async () => {
    const file = new File([buildPdrDeltaMp4()], "pdr-c8-nobeacon.mp4");
    const out = await parseTelemetryFile(file);
    expect(out.kind).toBe("pdr");
    expect(out.laps).toEqual([]);
    expect(out.needsLine).toBe(true); // GPS decoded -> picker, not lat+odo recovery
    expect(out.lapRecovery).toBeNull();
    expect(out.gps.length).toBeGreaterThan(100);
  });
});

describe("real-firmware PDR (no GPS stream)", () => {
  const LAP_MS = Math.round(((2 * Math.PI * 300) / 40) * 1000); // 47124

  it("beacon-timed laps are untouched; no GPS trace decodes from one lon fix", async () => {
    const b0 = 30, lapS = LAP_MS / 1000;
    const file = new File([buildPdrRealMp4({ beaconTimes: [b0, b0 + lapS, b0 + 2 * lapS] })], "pdr-real.mp4");
    const out = await parseTelemetryFile(file);
    expect(out.kind).toBe("pdr");
    expect(out.gps).toBeNull();
    expect(out.needsLine).toBe(false);
    expect(out.lapRecovery).toBeNull(); // beacons already produced laps
    const exact = out.laps.filter((l) => !l.estimated);
    expect(exact.length).toBeGreaterThanOrEqual(2);
    for (const lap of exact) expect(Math.abs(lap.timeMs - LAP_MS)).toBeLessThan(50);
  });

  it("recovers laps from latitude + odometer when there are no beacons", async () => {
    const file = new File([buildPdrRealMp4()], "pdr-nobeacon-real.mp4");
    const out = await parseTelemetryFile(file);
    expect(out.kind).toBe("pdr");
    expect(out.gps).toBeNull();
    expect(out.needsLine).toBe(false); // no GPS -> the line picker can't help
    expect(out.lapRecovery).not.toBeNull();
    expect(out.lapRecovery.anchored).toBe(false);
    expect(out.laps).toHaveLength(3); // 3.3 revolutions
    for (const lap of out.laps) {
      expect(lap.estimated).toBe(true);
      expect(Math.abs(lap.timeMs - LAP_MS)).toBeLessThan(300);
    }
  });

  it("finds no laps in paddock footage instead of inventing them", async () => {
    const file = new File([buildPdrRealMp4({ paddock: true })], "pdr-paddock.mp4");
    const out = await parseTelemetryFile(file);
    expect(out.kind).toBe("pdr");
    expect(out.laps).toEqual([]);
    expect(out.lapRecovery).toBeNull();
    expect(out.needsLine).toBe(false);
  });
});

describe("PDR GPS channels", () => {
  it("decodes lat/lon into a degrees trace and cuts the best beacon lap's trace", async () => {
    const points = circleTrace();
    const file = new File([buildPdrMp4({ gpsPoints: points })], "pdr-gps.mp4");
    const out = await parseTelemetryFile(file);
    expect(out.kind).toBe("pdr");
    // beacon laps are untouched by the GPS channels
    expect(out.laps.map((l) => l.timeMs)).toEqual([47120, 47120]);
    expect(out.needsLine).toBe(false);
    expect(out.gps.length).toBeGreaterThan(100);
    expect(out.gps[0].lat).toBeCloseTo(points[0].lat, 6);
    expect(out.gps[0].lon).toBeCloseTo(points[0].lon, 6);
    expect(out.bestLapTrace.length).toBeGreaterThan(10);
  });

  it("falls back to the line picker when a PDR file has no beacons", async () => {
    const file = new File([buildPdrMp4({ beaconTimes: [], gpsPoints: circleTrace() })], "pdr-nobeacon.mp4");
    const out = await parseTelemetryFile(file);
    expect(out.kind).toBe("pdr");
    expect(out.laps).toEqual([]);
    expect(out.needsLine).toBe(true);
    expect(out.gps.length).toBeGreaterThan(100);
  });

  it("keeps the beacon-only behavior when there are no GPS channels", async () => {
    const out = await parseTelemetryFile(new File([buildPdrMp4()], "pdr-beacons.mp4"));
    expect(out.gps).toBeNull();
    expect(out.bestLapTrace).toBeNull();
    expect(out.needsLine).toBe(false);
  });
});
