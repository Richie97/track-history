import { describe, expect, it } from "vitest";
import { parseVboText } from "../../public/js/import/vbo.js";
import { buildGate, deriveLaps, projectTrace } from "../../public/js/import/geo.js";
import { LAP_S, buildVboText, circleTrace } from "../fixtures/build.mjs";

const LAP_MS = Math.round(LAP_S() * 1000);

describe("parseVboText", () => {
  it("parses the created date, GPS points and duration", () => {
    const points = circleTrace();
    const out = parseVboText(buildVboText(points));
    expect(out.kind).toBe("vbo");
    expect(out.date).toBe("2026-06-20");
    expect(out.time).toBe("09:15:00");
    expect(out.gps.length).toBe(points.length);
    expect(out.durationS).toBeCloseTo(points[points.length - 1].t, 1);
    // minutes -> degrees, and the file's own sign convention is preserved
    expect(out.gps[0].lat).toBeCloseTo(points[0].lat, 4);
    expect(Math.abs(out.gps[0].lon)).toBeCloseTo(Math.abs(points[0].lon), 4);
  });

  it("computes laps from a [laptiming] start line", () => {
    const out = parseVboText(buildVboText(circleTrace(), { withLapTiming: true }));
    expect(out.needsLine).toBe(false);
    expect(out.laps).toHaveLength(3);
    for (const lap of out.laps) {
      expect(Math.abs(lap.timeMs - LAP_MS)).toBeLessThan(200);
      expect(lap.estimated).toBe(true);
    }
  });

  it("asks for a line when there is no [laptiming] section", () => {
    const out = parseVboText(buildVboText(circleTrace()));
    expect(out.needsLine).toBe(true);
    expect(out.laps).toEqual([]);
    // ...and the user-picked line then yields the laps
    const trace = projectTrace(out.gps, out.gps[0]);
    const gate = buildGate(trace, Math.round(0.25 * LAP_S() * 10));
    expect(deriveLaps(trace, gate)).toHaveLength(3);
  });

  it("rejects files without the expected structure", () => {
    expect(() => parseVboText("not a vbo")).toThrow(/column names/);
    expect(() =>
      parseVboText("[column names]\nsats time lat long\n[data]\n008 091500.00 2193.6 4752.0")
    ).toThrow(/no usable GPS/);
  });
});
