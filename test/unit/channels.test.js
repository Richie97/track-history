import { describe, expect, it } from "vitest";
import {
  CHANNEL_NAMES,
  MAX_TOTAL_VALUES,
  buildLapChannels,
  channelDataFor,
  distFromTrace,
  traceChannelData,
} from "../../public/js/import/channels.js";
import { parseTelemetryFile } from "../../public/js/import/parse.js";
import { applyGate } from "../../public/js/import/ui.js";
import { buildGate, projectTrace } from "../../public/js/import/geo.js";
import { LAP_S, buildPdrDeltaMp4, buildPdrMp4, buildVboText, circleTrace } from "../fixtures/build.mjs";

// Constant 40 m/s: distance is 40t, one 47.12s lap covers 1884.8m.
const dist = Array.from({ length: 400 }, (_, i) => ({ t: i * 0.5, v: i * 20 }));
const speed = Array.from({ length: 400 }, (_, i) => ({ t: i * 0.5, v: 144 })); // km/h
const rpm = Array.from({ length: 400 }, (_, i) => ({ t: i * 0.5, v: 5000 + (i % 10) }));

describe("buildLapChannels", () => {
  it("cuts channel arrays on the distance grid for windowed laps", () => {
    const laps = [
      { lapNumber: 3, timeMs: 47120, startT: 10, endT: 57.12 },
      { timeMs: 47120 }, // no window: skipped
    ];
    const out = buildLapChannels(laps, dist, { speed, rpm });
    expect(out.dStepM).toBe(20);
    expect(out.laps).toHaveLength(1);
    const lap = out.laps[0];
    expect(lap.n).toBe(3);
    // 47.12s at 40 m/s = 1884.8m -> 95 grid points (0..1880m)
    expect(lap.speed).toHaveLength(95);
    expect(lap.rpm).toHaveLength(95);
    expect(lap.speed[0]).toBe(144);
    expect(lap.rpm[50]).toBeGreaterThanOrEqual(5000);
  });

  it("synthesizes speed from the distance slope when no speed channel exists", () => {
    const laps = [{ timeMs: 47120, startT: 10, endT: 57.12 }];
    const out = buildLapChannels(laps, dist, {});
    expect(out.laps[0].speed).toHaveLength(95);
    // 40 m/s = 144 km/h from the odometer slope
    expect(out.laps[0].speed[40]).toBeCloseTo(144, 0);
    expect(out.laps[0].rpm).toBeUndefined();
  });

  it("returns null when there is nothing to cut", () => {
    expect(buildLapChannels([], dist, { speed })).toBeNull();
    expect(buildLapChannels([{ timeMs: 1000 }], dist, { speed })).toBeNull();
    expect(buildLapChannels([{ timeMs: 47120, startT: 10, endT: 57.12 }], dist.slice(0, 5), { speed })).toBeNull();
    // degenerate lap: shorter than 10 grid points
    expect(buildLapChannels([{ timeMs: 4000, startT: 10, endT: 14 }], dist, { speed })).toBeNull();
  });
});

describe("trace-derived channel data", () => {
  it("integrates distance from a projected trace", () => {
    const trace = circleTrace();
    const d = distFromTrace(projectTrace(trace));
    // 3.3 revolutions of a 300m-radius circle ≈ 6220m
    expect(d[d.length - 1].v).toBeGreaterThan(6100);
    expect(d[d.length - 1].v).toBeLessThan(6350);
  });

  it("uses the source's own speed when present", () => {
    const trace = circleTrace(); // v = 40 m/s on every point
    const { series: s } = traceChannelData(trace, projectTrace(trace));
    expect(s.speed[10].v).toBeCloseTo(144, 5); // km/h
  });
});

describe("end-to-end lapChannels on parsed imports", () => {
  it("attaches full car channels to a beacon-timed delta PDR file", async () => {
    const lapS = LAP_S();
    const file = new File([buildPdrDeltaMp4({ beaconTimes: [30, 30 + lapS, 30 + 2 * lapS] })], "pdr.mp4");
    const out = await parseTelemetryFile(file);
    expect(out.lapChannels).not.toBeNull();
    expect(out.lapChannels.laps).toHaveLength(2);
    const lap = out.lapChannels.laps[0];
    expect(lap.speed.length).toBeGreaterThan(80);
    expect(lap.rpm.length).toBe(lap.speed.length);
    expect(lap.latG.length).toBe(lap.speed.length);
    expect(lap.throttle.length).toBe(lap.speed.length);
    expect(lap.brake.length).toBe(lap.speed.length);
    expect(lap.steering.length).toBe(lap.speed.length);
    expect(Math.max(...lap.speed)).toBeLessThan(160); // ~151 km/h peak
    expect(Math.max(...lap.rpm)).toBeLessThanOrEqual(6000);
    // pedals within 0-100%, steering signed degrees (±28.6° in the fixture)
    expect(Math.min(...lap.throttle)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...lap.throttle)).toBeLessThanOrEqual(100);
    expect(Math.max(...lap.brake)).toBeLessThanOrEqual(100);
    expect(Math.min(...lap.steering)).toBeLessThan(-20);
    expect(Math.max(...lap.steering)).toBeLessThan(29.2);
  });

  it("channelDataFor picks the odometer for PDR and the trace for GPS sources", async () => {
    const pdr = await parseTelemetryFile(new File([buildPdrDeltaMp4()], "pdr.mp4"));
    expect(channelDataFor(pdr).dist).toBe(pdr.channels.odoPts);
    const gopro = { kind: "gopro", gps: circleTrace() };
    const data = channelDataFor(gopro);
    expect(data.dist.length).toBe(gopro.gps.length);
  });

  it("stores plausible km/h speeds for a VBO [laptiming] import", async () => {
    // Regression: VBO's velocity column is km/h while every other source's
    // gps.v is m/s — without normalization the stored speeds are 3.6x high
    // and a fast lap trips sanitizeChannels' 500 km/h cap (whole POST 400s).
    const file = new File([buildVboText(circleTrace(), { withLapTiming: true })], "session.vbo");
    const out = await parseTelemetryFile(file);
    expect(out.lapChannels.laps).toHaveLength(3);
    const speeds = out.lapChannels.laps.flatMap((l) => l.speed);
    expect(Math.max(...speeds)).toBeLessThan(150); // 40 m/s = 144 km/h
    expect(Math.min(...speeds)).toBeGreaterThan(130);
  });

  it("line-picked laps get speed channels via applyGate", async () => {
    const file = new File([buildPdrMp4({ beaconTimes: [], gpsPoints: circleTrace() })], "pdr-nobeacon.mp4");
    const parsed = await parseTelemetryFile(file);
    expect(parsed.lapChannels).toBeNull(); // no laps yet
    const state = { results: [{ file: "x.mp4", parsed }], origin: parsed.gps[0], gate: null };
    state.gate = buildGate(projectTrace(parsed.gps, state.origin), Math.round(0.25 * LAP_S() * 10));
    applyGate(state);
    expect(parsed.laps).toHaveLength(3);
    expect(parsed.lapChannels.laps).toHaveLength(3);
    expect(parsed.lapChannels.laps[0].speed.length).toBeGreaterThan(80);
  });
});

describe("state channels are sampled by rule, not interpolated", () => {
  // 400 grid points of distance, one lap covering the lot
  const laps = [{ lapNumber: 1, timeMs: 47120, startT: 0, endT: 100 }];

  it("holds the last gear rather than interpolating a fractional one", () => {
    // gear steps 3 -> 4 halfway; interpolation would emit 3.5 in between
    const gear = Array.from({ length: 400 }, (_, i) => ({ t: i * 0.5, v: i < 100 ? 3 : 4 }));
    const out = buildLapChannels(laps, dist, { speed, gear });
    const vals = new Set(out.laps[0].gear);
    expect(vals).toEqual(new Set([3, 4]));
  });

  it("catches a flag event narrower than the grid spacing", () => {
    // ABS on for a single 0.5s sample — between two 20m grid points at 40 m/s,
    // so a point sample sees it only by luck and the OR-over-the-window
    // sampler always does
    const flags = Array.from({ length: 400 }, (_, i) => ({ t: i * 0.5, v: i === 61 ? 1 : 0 }));
    const out = buildLapChannels(laps, dist, { speed, flags });
    expect(out.laps[0].flags.some((v) => v === 1)).toBe(true);
    expect(new Set(out.laps[0].flags)).toEqual(new Set([0, 1]));
  });
});

describe("per-lap scalars and session meta", () => {
  const laps = [
    { lapNumber: 1, timeMs: 47120, startT: 0, endT: 47.12 },
    { lapNumber: 2, timeMs: 47120, startT: 47.12, endT: 94.24 },
  ];
  // 0.5Hz, rising steadily — one sample every 80m at 40 m/s
  const slow = (f) => Array.from({ length: 60 }, (_, i) => ({ t: i * 2, v: f(i * 2) }));

  it("reduces each scalar by its own rule", () => {
    const out = buildLapChannels(laps, dist, { speed }, 20, {
      scalars: {
        oilC: slow((t) => 40 + t),       // max over the lap
        oilKpa: slow((t) => 300 - t),    // min over the lap
        fuelPct: slow((t) => 100 - t),   // value at the lap's end
      },
    });
    const [a, b] = out.laps;
    expect(a.oilC).toBeCloseTo(86, 0);   // last sample at or before 47.12s
    expect(b.oilC).toBeCloseTo(134, 0);
    expect(a.oilKpa).toBeCloseTo(254, 0);
    expect(b.oilKpa).toBeCloseTo(206, 0);
    expect(a.fuelPct).toBeCloseTo(52.9, 0); // interpolated at the finish
    expect(b.fuelPct).toBeLessThan(a.fuelPct);
  });

  it("stores session meta only when the source had some", () => {
    const withMeta = buildLapChannels(laps, dist, { speed }, 20, {
      meta: { ambientC: 15.04, odometerKm: 71087.6, elevationM: null },
    });
    expect(withMeta.meta).toEqual({ ambientC: 15, odometerKm: 71088 });
    expect(buildLapChannels(laps, dist, { speed }).meta).toBeUndefined();
  });
});

describe("storage budget", () => {
  it("drops the lowest-priority channels rather than storing nothing", () => {
    // 40 laps of a 14km circuit x 12 channels x ~700 points is ~336k values,
    // nearly three times the cap
    const longDist = Array.from({ length: 2000 }, (_, i) => ({ t: i * 7, v: i * 280 }));
    const chans = {};
    for (const [name] of CHANNEL_NAMES) {
      chans[name] = Array.from({ length: 2000 }, (_, i) => ({ t: i * 7, v: 1 }));
    }
    const laps = Array.from({ length: 40 }, (_, i) => ({
      lapNumber: i + 1,
      timeMs: 349000,
      startT: i * 349,
      endT: (i + 1) * 349,
    }));
    const out = buildLapChannels(laps, longDist, chans);
    expect(out).not.toBeNull();
    const total = out.laps.reduce(
      (s, e) => s + CHANNEL_NAMES.reduce((c, [k]) => c + (e[k]?.length ?? 0), 0),
      0
    );
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_VALUES);
    // speed survives; the tail of CHANNEL_NAMES is what went
    expect(out.laps[0].speed).toBeDefined();
    expect(out.laps[0].flags).toBeUndefined();
  });
});
