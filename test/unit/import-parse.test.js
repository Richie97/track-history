import { describe, expect, it } from "vitest";
import { parseTelemetryFile } from "../../public/js/import/parse.js";
import { buildFitLaps, buildGpmfMp4, buildPdrMp4, buildVboText, circleTrace } from "../fixtures/build.mjs";
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

  it("dispatches .vbo and .fit by extension", async () => {
    const vbo = await parseTelemetryFile(new File([buildVboText(circleTrace())], "session.VBO"));
    expect(vbo.kind).toBe("vbo");
    const fit = await parseTelemetryFile(new File([buildFitLaps()], "catalyst.fit"));
    expect(fit.kind).toBe("fit");
    expect(fit.laps).toHaveLength(3);
  });

  it("reports a combined error for MP4s with neither telemetry flavour", async () => {
    await expect(parseTelemetryFile(new File([emptyMp4()], "dashcam.mp4"))).rejects.toThrow(
      /No PDR or GoPro telemetry/
    );
  });
});
