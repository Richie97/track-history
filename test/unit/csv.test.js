import { describe, expect, it } from "vitest";
import { lapsFromLaptime, parseTrackPrecisionCsv, speedToMs } from "../../public/js/import/csv.js";
import { attachLapChannels } from "../../public/js/import/channels.js";
import { parseTelemetryFile } from "../../public/js/import/parse.js";
import { projectTrace } from "../../public/js/import/geo.js";
import { LAP_S, buildTrackPrecisionCsv, circleTrace } from "../fixtures/build.mjs";

const LAP_MS = Math.round(LAP_S() * 1000);
const NAME = "recording-2026-06-06-09-53-45.csv";

describe("parseTrackPrecisionCsv", () => {
  it("reads the GPS trace in decimal degrees, east-positive, on the timestamp clock", () => {
    const points = circleTrace();
    const out = parseTrackPrecisionCsv(buildTrackPrecisionCsv(points), NAME);
    expect(out.kind).toBe("trackprecision");
    expect(out.gps.length).toBe(points.length);
    expect(out.gps[0].lat).toBeCloseTo(points[0].lat, 8);
    expect(out.gps[0].lon).toBeCloseTo(points[0].lon, 8);
    expect(out.durationS).toBeCloseTo(points[points.length - 1].t, 2);
  });

  it("takes the date and wall-clock time from the file name", () => {
    const out = parseTrackPrecisionCsv(buildTrackPrecisionCsv(circleTrace()), NAME);
    expect(out.date).toBe("2026-06-06");
    expect(out.time).toBe("09:53:45");
  });

  it("falls back to the UTC timestamp when the name has no date", () => {
    const out = parseTrackPrecisionCsv(buildTrackPrecisionCsv(circleTrace()), "session.csv");
    expect(out.date).toBe("2026-05-28");
    expect(out.time).toBe("20:26:40");
  });

  it("times laps from the app's own lap timer, exactly", () => {
    const out = parseTrackPrecisionCsv(buildTrackPrecisionCsv(circleTrace()), NAME);
    expect(out.needsLine).toBe(false);
    // 3.3 revolutions, line at a quarter turn: crossings at 0.25, 1.25, 2.25,
    // 3.25 — three whole laps
    expect(out.laps).toHaveLength(3);
    for (const lap of out.laps) {
      expect(Math.abs(lap.timeMs - LAP_MS)).toBeLessThanOrEqual(1);
      expect(lap.estimated).toBe(false);
    }
    expect(out.bestLapTrace.length).toBeGreaterThan(10);
  });

  it("reads a timer that writes 0 on the first sample of a lap", () => {
    const out = parseTrackPrecisionCsv(buildTrackPrecisionCsv(circleTrace(), { zeroAtLine: true }), NAME);
    expect(out.laps).toHaveLength(3);
    for (const lap of out.laps) expect(Math.abs(lap.timeMs - LAP_MS)).toBeLessThanOrEqual(1);
  });

  it("reads the newer ', ' separators", () => {
    const out = parseTrackPrecisionCsv(buildTrackPrecisionCsv(circleTrace(), { spaced: true }), NAME);
    expect(out.laps).toHaveLength(3);
    expect(Object.keys(out.carChannels)).toContain("rpm");
  });

  it("times the last lap of a recording stopped just short of the line", () => {
    // Recording starts 0.3 s past the line and stops 0.3 s short of it: the
    // timer never resets for the last lap, which is extrapolated and marked.
    const q = LAP_S() / 4;
    const kept = circleTrace({ revolutions: 4 }).filter((p) => p.t > q + 0.3 && p.t < q + 3 * LAP_S() - 0.3);
    const t0 = kept[0].t;
    const shifted = kept.map((p) => ({ ...p, t: p.t - t0 }));
    const out = parseTrackPrecisionCsv(buildTrackPrecisionCsv(shifted, { firstCrossT: q - t0 }), NAME);
    expect(out.laps).toHaveLength(3);
    expect(out.laps.map((l) => l.estimated)).toEqual([false, false, true]);
    for (const lap of out.laps) expect(Math.abs(lap.timeMs - LAP_MS)).toBeLessThan(150);
  });

  it("detects the speed column's unit against the GPS trace", () => {
    for (const speedUnit of ["kmh", "ms"]) {
      const out = parseTrackPrecisionCsv(buildTrackPrecisionCsv(circleTrace(), { speedUnit }), NAME);
      expect(out.gps[10].v).toBeCloseTo(40, 2);
    }
  });

  it("stores accelerations in G whichever unit the firmware wrote", () => {
    for (const accelMs2 of [false, true]) {
      const out = parseTrackPrecisionCsv(buildTrackPrecisionCsv(circleTrace(), { accelMs2 }), NAME);
      expect(Math.max(...out.carChannels.latG.map((p) => p.v))).toBeCloseTo(0.9, 2);
      expect(Math.min(...out.carChannels.longG.map((p) => p.v))).toBeCloseTo(-0.6, 2);
    }
  });

  it("maps the car channels as the .vbo does", () => {
    const out = parseTrackPrecisionCsv(buildTrackPrecisionCsv(circleTrace()), NAME);
    const ch = out.carChannels;
    // yawVelocity is always 0, so it isn't a channel
    expect(Object.keys(ch).sort()).toEqual(["brake", "gear", "latG", "longG", "rpm", "steering", "throttle"]);
    expect(Math.max(...ch.throttle.map((p) => p.v))).toBeCloseTo(100, 0);
    expect(Math.max(...ch.brake.map((p) => p.v))).toBeCloseTo(100, 5);
    expect(new Set(ch.gear.map((p) => p.v))).toEqual(new Set([3, 4]));
    // bar -> kPa; the 3276.8 sentinel columns are dropped
    expect(out.lapScalarChannels.tyreKpaLF[0].v).toBeCloseTo(210, 5);
    expect(out.lapScalarChannels.tyreKpaRF).toBeUndefined();
  });

  it("drops the car channels once the car stops reporting", () => {
    const out = parseTrackPrecisionCsv(buildTrackPrecisionCsv(circleTrace(), { silentAfterS: 60 }), NAME);
    for (const pts of Object.values(out.carChannels)) expect(pts[pts.length - 1].t).toBeLessThan(60);
    // ...so the laps after the dropout carry speed alone
    attachLapChannels(out);
    const last = out.lapChannels.laps[out.lapChannels.laps.length - 1];
    expect(last.speed).toBeDefined();
    expect(last.rpm).toBeUndefined();
  });

  it("asks for a line when the timer never completes a lap", () => {
    const text = buildTrackPrecisionCsv(circleTrace())
      .split("\n")
      .map((l, i) => (i === 0 || !l ? l : l.replace(/^((?:[^,]*,){8})[^,]*/, "$10")))
      .join("\n");
    const out = parseTrackPrecisionCsv(text, NAME);
    expect(out.needsLine).toBe(true);
    expect(out.laps).toEqual([]);
  });

  it("is reached through parseTelemetryFile, and its channels fit the stored shape", async () => {
    const text = buildTrackPrecisionCsv(circleTrace());
    const out = await parseTelemetryFile(new File([text], NAME));
    expect(out.kind).toBe("trackprecision");
    expect(out.lapChannels.laps).toHaveLength(3);
    expect(out.lapChannels.laps[0].rpm.length).toBe(out.lapChannels.laps[0].speed.length);
  });

  it("rejects a CSV that isn't Track Precision's", () => {
    expect(() => parseTrackPrecisionCsv("a,b,c\n1,2,3\n", "x.csv")).toThrow(/Track Precision/);
    const header = buildTrackPrecisionCsv(circleTrace()).split("\n")[0];
    expect(() => parseTrackPrecisionCsv(`${header}\n`, NAME)).toThrow(/no usable GPS/);
  });
});

describe("lapsFromLaptime", () => {
  // Samples at 10 Hz of a timer started at `t0`, running laps of the given
  // lengths (s) back to back round an 1800 m circuit, each at its own steady
  // speed; `until` cuts the recording short.
  const timer = (laps, { t0 = 0.05, from = 0, until = Infinity } = {}) => {
    const out = [];
    let start = t0;
    for (const len of laps) {
      for (let i = Math.ceil(Math.max(start, from) * 10); i / 10 < start + len && i / 10 < until; i++) {
        const t = i / 10;
        out.push({ t, lapMs: Math.round((t - start) * 1000), lapM: ((t - start) / len) * 1800, v: 1800 / len });
      }
      start += len;
    }
    return out;
  };

  it("keeps each lap between two resets and drops a trailing part-lap", () => {
    expect(lapsFromLaptime(timer([40, 45, 46, 20])).map((l) => l.timeMs)).toEqual([40000, 45000, 46000]);
  });

  it("places each crossing at timestamp minus the timer, finer than the rows", () => {
    const laps = lapsFromLaptime(timer([40.013, 45.027, 1]));
    expect(laps.map((l) => l.timeMs)).toEqual([40013, 45027]);
    expect(laps[0].startT).toBeCloseTo(0.05, 9);
  });

  it("starts timing at the first sample once a stopped timer runs", () => {
    const idle = Array.from({ length: 50 }, (_, i) => ({ t: i / 10, lapMs: 0, lapM: 0, v: 0 }));
    const laps = lapsFromLaptime([...idle, ...timer([40, 45, 1], { t0: 5.05 })]);
    expect(laps.map((l) => l.timeMs)).toEqual([40000, 45000]);
  });

  it("drops a lap the timer stopped during (a pit stop)", () => {
    const run = timer([40, 45, 46, 1]);
    // the timer sits at 0 from 60 s until the car leaves the pit at 180 s,
    // then carries on from where the lap had got to — the lap's length no
    // longer matches what its counter says
    const stopped = run.map((x) => (x.t >= 60 && x.t < 85.05 ? { ...x, lapMs: 0 } : x));
    expect(lapsFromLaptime(stopped).map((l) => l.timeMs)).toEqual([40000, 46000]);
  });

  it("extrapolates a last lap that ends within EDGE_M of the line", () => {
    // stopped 0.3 s (12 m) short of completing the 46 s lap
    const laps = lapsFromLaptime(timer([40, 45, 46], { until: 131.05 - 0.3 }));
    expect(laps.map((l) => l.timeMs)).toEqual([40000, 45000, 46000]);
    expect(laps[2].estimated).toBe(true);
  });

  it("leaves a last lap short of EDGE_M untimed", () => {
    // stopped 1 s (39 m) short
    const laps = lapsFromLaptime(timer([40, 45, 46], { until: 131.05 - 1 }));
    expect(laps.map((l) => l.timeMs)).toEqual([40000, 45000]);
  });
});

describe("speedToMs", () => {
  it("picks the unit nearest the GPS distance", () => {
    const pts = circleTrace();
    const trace = projectTrace(pts, pts[0]);
    expect(speedToMs(trace, pts.map(() => 40))).toBe(1);
    expect(speedToMs(trace, pts.map(() => 144))).toBeCloseTo(1 / 3.6, 10);
    expect(speedToMs(trace, pts.map(() => 89.477))).toBeCloseTo(1 / 2.2369362920544, 10);
    // nothing to go on: km/h
    expect(speedToMs(trace, pts.map(() => null))).toBeCloseTo(1 / 3.6, 10);
  });
});
