import { describe, expect, it } from "vitest";
import {
  LAP_CLOCK_TOLERANCE_MS,
  NO_VALUE,
  RECORD_BYTES,
  ecefToGeodetic,
  lapsFromCounter,
  parseAimMeta,
  parseSmartyCamFile,
  plausibleChannels,
  readRecord,
} from "../../public/js/import/smartycam.js";
import { parseTelemetryFile } from "../../public/js/import/parse.js";
import { clipCandidate } from "../../public/js/import/clip.js";
import { importSessionBody } from "../../public/js/import/ui.js";
import { sanitizeChannels } from "../../src/lib/validate.ts";
import { LAP_S, SMARTYCAM_FPS, buildGpmfMp4, buildSmartyCamMov, circleTrace } from "../fixtures/build.mjs";

const LAP_MS = Math.round(LAP_S() * 100) * 10; // the logger reports to 10 ms
const mov = (opts) => new File([buildSmartyCamMov(opts)], "SCHD0001.MOV");

describe("ecefToGeodetic", () => {
  it("lands on the equator, the pole and a known point", () => {
    expect(ecefToGeodetic(6378137, 0, 0)).toEqual({ lat: 0, lon: 0 });
    expect(ecefToGeodetic(0, 0, 6356752.314245).lat).toBeCloseTo(90, 9);
    // VIR's start/finish, from a real record: X 960562.82 m, Y -5037961.28 m, Z 3779118.22 m
    const p = ecefToGeodetic(960562.82, -5037961.28, 3779118.22);
    expect(p.lat).toBeCloseTo(36.5688, 3);
    expect(p.lon).toBeCloseTo(-79.2051, 3);
  });
});

describe("readRecord", () => {
  const record = (fill) => {
    const dv = new DataView(new ArrayBuffer(RECORD_BYTES));
    fill(dv);
    return readRecord(dv);
  };
  const withFix = (dv) => {
    dv.setInt32(60, 96056282, true);
    dv.setInt32(64, -503796128, true);
    dv.setInt32(68, 377911822, true);
  };

  it("reads the fields little-endian", () => {
    const r = record((dv) => {
      dv.setUint32(0, 135, true);
      dv.setInt32(8, 204329, true);
      dv.setInt32(32, 4, true);
      dv.setInt32(40, 198330, true);
      withFix(dv);
      dv.setInt32(76, 2489, true);
      dv.setInt32(80, 485, true);
      dv.setInt32(84, 18, true);
      dv.setInt32(104, 5544, true);
      dv.setInt32(108, 17, true);
      dv.setInt32(120, 2, true);
    });
    expect(r).toMatchObject({ frame: 135, tsMs: 204329, lapCount: 4, lapMs: 198330, rpm: 5544, throttle: 17, gear: 2 });
    expect(r.ecef).toEqual({ x: 960562.82, y: -5037961.28, z: 3779118.22 });
    expect(r.speedMs).toBeCloseTo(25.36, 2);
  });

  it("turns NO_VALUE into null and never into a reading", () => {
    const r = record((dv) => {
      withFix(dv);
      for (const o of [32, 40, 104, 108, 120]) dv.setInt32(o, NO_VALUE, true);
    });
    expect([r.lapCount, r.lapMs, r.rpm, r.throttle, r.gear]).toEqual([null, null, null, null, null]);
  });

  it("has no position without a fix", () => {
    expect(record(() => {}).ecef).toBeNull(); // all zero
    expect(record((dv) => [60, 64, 68].forEach((o) => dv.setInt32(o, -1, true))).ecef).toBeNull();
    expect(record(() => {}).speedMs).toBeNull();
  });
});

describe("lapsFromCounter", () => {
  // Records 1 s apart on both clocks unless `ts` says otherwise.
  const recs = (counts, { lapMs = {}, ts = (i) => i * 1000 } = {}) =>
    counts.map((c, i) => ({ t: i, tsMs: ts(i), lapCount: c, lapMs: lapMs[i] ?? null }));

  it("needs two consecutive steps, and puts each boundary one record before its step", () => {
    const laps = lapsFromCounter(recs([0, 0, 1, 1, 1, 1, 2, 2, 3], { lapMs: { 2: 99000, 6: 4000, 8: 2000 } }));
    expect(laps).toEqual([
      { lapNumber: 1, timeMs: 4000, estimated: false, startT: 1, endT: 5 },
      { lapNumber: 2, timeMs: 2000, estimated: false, startT: 5, endT: 7 },
    ]);
  });

  it("drops the first lap a file closes: it began before the video did", () => {
    expect(lapsFromCounter(recs([3, 3, 4, 4], { lapMs: { 2: 120000 } }))).toEqual([]);
  });

  it("opens nothing across a jump, a reset or a missing counter", () => {
    expect(lapsFromCounter(recs([0, 1, 1, 3, 3], { lapMs: { 1: 5000, 3: 2000 } }))).toEqual([]);
    expect(lapsFromCounter(recs([4, 5, 5, 0, 0, 1], { lapMs: { 1: 5000, 5: 4000 } }))).toEqual([]);
    expect(lapsFromCounter(recs([0, 1, 1, null, 1, 2], { lapMs: { 1: 5000, 5: 4000 } }))).toEqual([]);
  });

  it("refuses a lap whose logger clock disagrees with its reported time", () => {
    const at = (ms) => recs([0, 1, 1, 1, 1, 2], { lapMs: { 1: 9000, 5: ms } });
    expect(lapsFromCounter(at(4000 + LAP_CLOCK_TOLERANCE_MS))).toHaveLength(1);
    expect(lapsFromCounter(at(4000 + LAP_CLOCK_TOLERANCE_MS + 10))).toEqual([]);
  });

  it("takes the lap time from the logger, not from the video clock", () => {
    // 4 s of video, 4.5 s on the logger: frames were dropped.
    const laps = lapsFromCounter(recs([0, 1, 1, 1, 1, 2], { lapMs: { 1: 9000, 5: 4500 }, ts: (i) => i * 1125 }));
    expect(laps).toEqual([{ lapNumber: 1, timeMs: 4500, estimated: false, startT: 0, endT: 4 }]);
  });
});

describe("plausibleChannels", () => {
  const recs = (f) => Array.from({ length: 40 }, (_, i) => ({ rpm: 3000 + i * 100, throttle: i * 2, gear: 2 + (i % 4), ...f(i) }));

  it("keeps fields that look like what they claim", () => {
    expect(plausibleChannels(recs(() => ({})))).toEqual({ rpm: true, throttle: true, gear: true });
  });

  it("drops each field on its own", () => {
    expect(plausibleChannels(recs(() => ({ rpm: 40 })))).toMatchObject({ rpm: false, throttle: true, gear: true });
    expect(plausibleChannels(recs(() => ({ throttle: 20 })))).toMatchObject({ throttle: false }); // never moves
    expect(plausibleChannels(recs((i) => ({ throttle: i * 5 })))).toMatchObject({ throttle: false }); // past 100
    expect(plausibleChannels(recs((i) => ({ gear: i })))).toMatchObject({ gear: false, rpm: true });
    expect(plausibleChannels(recs(() => ({ rpm: null, throttle: null, gear: null })))).toEqual({ rpm: false, throttle: false, gear: false });
  });
});

describe("parseAimMeta", () => {
  it("reads the date and the time and nothing else", () => {
    const xml = `<p n="racer_name">Somebody</p><p n="date">21/11/2026</p><p n="hour">08:58.16</p><p n="nlap">4</p>`;
    expect(parseAimMeta(xml)).toEqual({ date: "2026-11-21", time: "08:58:16" });
  });

  it("answers nulls for a file without the block", () => {
    expect(parseAimMeta("")).toEqual({ date: null, time: null });
    expect(parseAimMeta(`<p n="date">2026-11-21</p>`)).toEqual({ date: null, time: null });
  });
});

describe("parseSmartyCamFile", () => {
  it("reads the logger's laps, the trace and the car channels", async () => {
    const out = await parseSmartyCamFile(mov());
    expect(out.kind).toBe("smartycam");
    expect(out.needsLine).toBe(false);
    expect(out.date).toBe("2026-06-20");
    expect(out.time).toBe("09:15:00");
    // Four steps of the counter: the first closes the out-lap, three laps follow.
    expect(out.laps.map((l) => l.timeMs)).toEqual([LAP_MS, LAP_MS, LAP_MS]);
    expect(out.laps.every((l) => l.estimated === false)).toBe(true);
    expect(Object.keys(out.carChannels)).toEqual(["rpm", "throttle", "gear"]);
    expect(Math.abs(out.metrics.topSpeedKph - 144)).toBeLessThan(1);
    expect(out.metrics.maxRpm).toBeGreaterThan(6900);
    expect(out.bestLapTrace.length).toBeGreaterThan(100);
    expect(out.traceGeo.lat).toBeCloseTo(36.56, 2);
  });

  it("runs on video time: a lap that lost frames is shorter in the file than on the clock", async () => {
    const out = await parseSmartyCamFile(mov());
    const videoS = out.laps.map((l) => l.endT - l.startT);
    // The second lap (58.9 s → 106.0 s) holds the 12 s stretch that lost a third of its frames.
    expect(videoS[0]).toBeCloseTo(LAP_MS / 1000, 0);
    expect(videoS[1]).toBeCloseTo(LAP_MS / 1000 - 4, 0);
    expect(out.laps[1].timeMs).toBe(LAP_MS);
    // Every record is five frames on from the last, whatever the clock did.
    const dt = out.gps[101].t - out.gps[100].t;
    expect(dt).toBeCloseTo(5 / SMARTYCAM_FPS, 9);
    expect(out.durationS).toBeCloseTo(out.gps.length / 6, 1);
  });

  it("takes position from the ECEF fix, not the stale ×1e7 pair", async () => {
    const out = await parseSmartyCamFile(mov());
    // The circle's centre is (36.56, -79.2) and the car starts due east of it.
    expect(out.gps[0].lat).toBeCloseTo(36.56, 6);
    // Speed is the ECEF velocity's magnitude, real however many frames were lost
    // (the fixture's circle is laid out with flat-earth constants, hence the slack).
    expect(out.gps.every((p) => Math.abs(p.v - 40) < 0.3)).toBe(true);
  });

  it("skips NO_VALUE readings instead of charting them", async () => {
    const out = await parseSmartyCamFile(mov());
    expect(out.carChannels.rpm.length).toBeLessThan(out.gps.length);
    expect(out.carChannels.rpm.every((p) => p.v > 0)).toBe(true);
  });

  it("starts mid-session, survives a counter reset, and drops an implausible gear", async () => {
    const out = await parseSmartyCamFile(mov({ startCount: 3, resetAtS: 80, badGear: true, dropped: [], meta: null }));
    expect(out.laps.map((l) => l.timeMs)).toEqual([LAP_MS, LAP_MS]);
    expect(Object.keys(out.carChannels)).toEqual(["rpm", "throttle"]);
    // No XML: the date falls back to the file's own creation time (UTC).
    expect(out.date).toBe("2026-06-20");
    expect(out.time).toBe("13:15:00");
  });

  it("is not fooled by somebody else's video", async () => {
    await expect(parseSmartyCamFile(new Blob([buildGpmfMp4(circleTrace())]))).rejects.toThrow(/No SmartyCam telemetry track/);
  });
});

describe("parseTelemetryFile with a SmartyCam .MOV", () => {
  it("dispatches it and cuts per-lap channels on the distance grid", async () => {
    const out = await parseTelemetryFile(mov());
    expect(out.kind).toBe("smartycam");
    expect(out.lapChannels.laps).toHaveLength(3);
    const lap = out.lapChannels.laps[1];
    expect(Object.keys(lap)).toEqual(expect.arrayContaining(["speed", "rpm", "throttle", "gear"]));
    // The lap that lost frames still measures a full lap of distance and speed.
    expect(Math.abs(lap.speed.length - out.lapChannels.laps[0].speed.length)).toBeLessThanOrEqual(1);
    expect(lap.speed.every((v) => Math.abs(v - 144) < 1.5)).toBe(true);
  });

  it("builds a session the server accepts", async () => {
    const parsed = await parseTelemetryFile(mov());
    const body = importSessionBody({ file: "SCHD0001.MOV", parsed }, "", "imperial");
    expect(body.laps).toEqual([LAP_MS, LAP_MS, LAP_MS]);
    expect(body.notes).toBe("Imported from SCHD0001.MOV");
    expect(body.notes).not.toMatch(/Test Driver|Test Car/);
    expect(body.trace_geo).toEqual(parsed.traceGeo);
    expect(sanitizeChannels(body.channels)).toBeTruthy(); // undefined is the server's 400
  });

  it("still reads a GoPro file renamed .mov", async () => {
    const out = await parseTelemetryFile(new File([buildGpmfMp4(circleTrace())], "GX010042.MOV"));
    expect(out.kind).toBe("gopro");
  });

  it("says so when the camera never finished the file", async () => {
    const bytes = buildSmartyCamMov();
    const noIndex = bytes.slice(0, 5000); // ftyp and the start of mdat, no moov
    await expect(parseTelemetryFile(new File([noIndex], "SCHD0157.MOV"))).rejects.toThrow(/wasn't finished by the camera/);
  });

  it("offers no clip yet: the cutters' rule for these files is a later ticket", async () => {
    expect(clipCandidate(await parseTelemetryFile(mov()))).toBeNull();
  });
});
