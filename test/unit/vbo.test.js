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
    // minutes -> degrees, and Racelogic's west-positive longitude comes back
    // east-positive like every other source, so the racing line isn't mirrored
    expect(out.gps[0].lat).toBeCloseTo(points[0].lat, 4);
    expect(out.gps[0].lon).toBeCloseTo(points[0].lon, 4);
  });

  it("normalizes the km/h velocity column to m/s", () => {
    // circleTrace speed is 40 m/s; the fixture writes it as 144 km/h with a
    // "velocity kmh" header line. gps.v must come back in m/s — the per-lap
    // channel data (channels.js) converts m/s -> km/h and would otherwise
    // store speeds 3.6x too high.
    const out = parseVboText(buildVboText(circleTrace()));
    expect(out.gps[10].v).toBeCloseTo(40, 2);
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

  it("reads a latitude-first [laptiming] line too", () => {
    const out = parseVboText(buildVboText(circleTrace(), { withLapTiming: true, latFirst: true }));
    expect(out.laps).toHaveLength(3);
  });

  it("times laps driven just past the end of a short start line", () => {
    // Track Precision's line is ~15 m and sits to one side; a lap driven a
    // few metres wide of its end must still be timed. A 14 m line spans
    // radius 293-307 m; drive the circle at 310 m.
    const LAP = (2 * Math.PI * 310) / 40;
    const out = parseVboText(buildVboText(circleTrace({ radius: 310 }), { withLapTiming: true, lineHalfM: 7 }));
    expect(out.laps).toHaveLength(3);
    for (const lap of out.laps) expect(Math.abs(lap.timeMs - LAP * 1000)).toBeLessThan(200);
  });

  it("takes the gate direction from the trace, so a clockwise session times too", () => {
    // The same circle driven clockwise crosses the line the other way.
    const cw = circleTrace().map((p, i, all) => ({ ...all[all.length - 1 - i], t: p.t }));
    const out = parseVboText(buildVboText(cw, { withLapTiming: true }));
    expect(out.laps).toHaveLength(3);
  });

  it("times the first and last laps of a recording started and stopped at the line", () => {
    // Track Precision starts recording just past the line and stops just
    // short of it, so neither end is ever seen crossed. The fixture's line is
    // at a quarter turn; keep three laps starting 0.3 s (12 m) after it.
    const q = LAP_S() / 4;
    const kept = circleTrace({ revolutions: 4 }).filter((p) => p.t > q + 0.3 && p.t < q + 3 * LAP_S() - 0.3);
    const t0 = kept[0].t;
    const out = parseVboText(buildVboText(kept.map((p) => ({ ...p, t: p.t - t0 })), { withLapTiming: true }));
    expect(out.laps).toHaveLength(3);
    for (const lap of out.laps) expect(Math.abs(lap.timeMs - LAP_MS)).toBeLessThan(200);
  });

  it("parses the Porsche Track Precision layout and its car channels", () => {
    const points = circleTrace();
    const out = parseVboText(
      buildVboText(points, { withLapTiming: true, trackPrecision: true }),
      "recording-2026-06-06-09-53-45.vbo"
    );
    // one column name per line, names with spaces
    expect(out.laps).toHaveLength(3);
    // the date is the file name's — "created at" is the export time
    expect(out.date).toBe("2026-06-06");
    expect(out.time).toBe("09:15:00");
    const ch = out.carChannels;
    expect(Object.keys(ch).sort()).toEqual(["brake", "gear", "latG", "rpm", "steering", "throttle"]);
    // the pedal fraction becomes a percentage
    expect(Math.max(...ch.throttle.map((p) => p.v))).toBeCloseTo(100, 0);
    // brake pressure becomes a percentage of the file's peak
    expect(Math.max(...ch.brake.map((p) => p.v))).toBeCloseTo(100, 5);
    expect(Math.min(...ch.brake.map((p) => p.v))).toBe(0);
    // true G (LatAcc_PTPA) over the /9.81 `latacc` column, as a magnitude
    expect(Math.max(...ch.latG.map((p) => p.v))).toBeCloseTo(0.9, 2);
    expect(new Set(ch.gear.map((p) => p.v))).toEqual(new Set([3, 4]));
    // bar -> kPa; the 3276.8 "no reading" sentinel is dropped
    expect(out.lapScalarChannels.tyreKpaLF[0].v).toBeCloseTo(210, 5);
    expect(out.lapScalarChannels.tyreKpaRF).toBeUndefined();
  });

  it("falls back to the export date when the name has none", () => {
    const out = parseVboText(buildVboText(circleTrace(), { trackPrecision: true }), "session.vbo");
    expect(out.date).toBe("2026-09-22");
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
