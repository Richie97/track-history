import { describe, expect, it } from "vitest";
import { parseGpmfFile } from "../../public/js/import/gpmf.js";
import { buildGate, deriveLaps, projectTrace } from "../../public/js/import/geo.js";
import { LAP_S, buildGpmfMp4, circleTrace } from "../fixtures/build.mjs";

const LAP_MS = Math.round(LAP_S() * 1000);

// A structurally-valid MP4 with an ftyp and an empty moov, no tracks.
export function emptyMp4() {
  const bytes = new Uint8Array(32);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 16);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4); // ftyp
  dv.setUint32(16, 16);
  bytes.set([0x6d, 0x6f, 0x6f, 0x76], 20); // moov with 8 zero bytes of body
  return bytes;
}

describe("parseGpmfFile", () => {
  it("extracts the GPS trace and UTC date from the gpmd track", async () => {
    const points = circleTrace();
    const out = await parseGpmfFile(new Blob([buildGpmfMp4(points)]));
    expect(out.kind).toBe("gopro");
    expect(out.needsLine).toBe(true);
    expect(out.laps).toEqual([]);
    expect(out.date).toBe("2026-06-20");
    expect(out.time).toBe("09:15:00");
    expect(out.gps.length).toBeGreaterThan(points.length * 0.95);
    expect(out.gps[0].lat).toBeCloseTo(36.56, 4);
    expect(out.gps[0].v).toBeCloseTo(40, 1);
  });

  it("supports line picking end-to-end", async () => {
    const out = await parseGpmfFile(new Blob([buildGpmfMp4(circleTrace())]));
    const trace = projectTrace(out.gps, out.gps[0]);
    // pick the trace point nearest a quarter revolution
    const target = trace[Math.round(0.25 * LAP_S() * 10)];
    const gate = buildGate(trace, trace.indexOf(target));
    const laps = deriveLaps(trace, gate);
    expect(laps).toHaveLength(3);
    for (const lap of laps) expect(Math.abs(lap.timeMs - LAP_MS)).toBeLessThan(300);
  });

  it("rejects MP4s without a GPMF track", async () => {
    await expect(parseGpmfFile(new Blob([emptyMp4()]))).rejects.toThrow(/telemetry track/);
  });
});
