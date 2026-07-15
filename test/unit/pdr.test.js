import { describe, expect, it } from "vitest";
import { boxes, gpsFromChannels, parsePdrFile, series } from "../../public/pdr.js";
import { LAP_S, buildPdrDeltaMp4 } from "../fixtures/build.mjs";

describe("series", () => {
  const s = series([
    { t: 0, v: 0 },
    { t: 10, v: 100 },
    { t: 20, v: 300 },
  ]);

  it("interpolates values at a time", () => {
    expect(s.at(5)).toBe(50);
    expect(s.at(15)).toBe(200);
    expect(s.at(10)).toBe(100);
  });

  it("inverts monotonic series with timeAt", () => {
    expect(s.timeAt(50)).toBe(5);
    expect(s.timeAt(200)).toBe(15);
  });

  it("computes a central-difference rate", () => {
    // between t=10 and t=20 the slope is 20 v/t
    expect(s.rate(15, 2)).toBe(20);
  });

  it("exposes first/last and length", () => {
    expect(s.n).toBe(3);
    expect(s.first).toEqual({ t: 0, v: 0 });
    expect(s.last).toEqual({ t: 20, v: 300 });
  });
});

describe("gpsFromChannels", () => {
  const t = (i) => i * 0.15;
  const chan = (n, deg) => Array.from({ length: n }, (_, i) => ({ t: t(i), v: Math.round(deg(i) * 1e7) }));

  it("decodes deg*1e7 lat/lon channels into a degrees trace", () => {
    const lat = chan(40, (i) => 36.56 + i * 1e-4);
    const lon = chan(40, (i) => -79.2 + i * 1e-4);
    const gps = gpsFromChannels(lat, lon);
    expect(gps).toHaveLength(40);
    expect(gps[10].lat).toBeCloseTo(36.561, 6);
    expect(gps[10].lon).toBeCloseTo(-79.199, 6);
    expect(gps[10].v).toBeUndefined();
  });

  it("takes speed from the odometer series when given", () => {
    const lat = chan(40, (i) => 36.56 + i * 1e-4);
    const lon = chan(40, (i) => -79.2 + i * 1e-4);
    const odo = series(Array.from({ length: 40 }, (_, i) => ({ t: t(i), v: i * 6 }))); // 40 m/s
    const gps = gpsFromChannels(lat, lon, odo);
    expect(gps[20].v).toBeCloseTo(40, 6);
  });

  it("decodes float32-bit lat/lon channels via the fallback interpretation", () => {
    const f32 = new DataView(new ArrayBuffer(4));
    const asBits = (deg) => {
      f32.setFloat32(0, deg);
      return f32.getInt32(0);
    };
    const lat = Array.from({ length: 40 }, (_, i) => ({ t: t(i), v: asBits(36.56 + i * 1e-4) }));
    const lon = Array.from({ length: 40 }, (_, i) => ({ t: t(i), v: asBits(-79.2 + i * 1e-4) }));
    const gps = gpsFromChannels(lat, lon);
    expect(gps[10].lat).toBeCloseTo(36.561, 4);
    expect(gps[10].lon).toBeCloseTo(-79.199, 4);
  });

  it("returns null rather than a garbage trace", () => {
    // parked car: zero extent
    const stuck = Array.from({ length: 40 }, (_, i) => ({ t: t(i), v: 365600000 }));
    expect(gpsFromChannels(stuck, stuck)).toBeNull();
    // values plausible under neither interpretation
    const noise = Array.from({ length: 40 }, (_, i) => ({ t: t(i), v: 2000000000 - i * 55555555 }));
    expect(gpsFromChannels(noise, noise)).toBeNull();
    // too few samples
    expect(gpsFromChannels([], [])).toBeNull();
  });
});

describe("parsePdrFile with a delta-encoded stream (real firmware shape)", () => {
  const lapS = LAP_S(); // 47.12s
  const parse = (opts) => parsePdrFile(new Blob([buildPdrDeltaMp4(opts)]));

  it("decodes the delta-encoded GPS channels into a dictionary-scaled trace", async () => {
    const out = await parse();
    expect(out.gps).not.toBeNull();
    expect(out.gps.length).toBeGreaterThan(100);
    // ~2Hz stream around the reference circle at lat0/lon0
    const lats = out.gps.map((p) => p.lat);
    const lons = out.gps.map((p) => p.lon);
    expect(Math.min(...lats)).toBeGreaterThan(36.5545);
    expect(Math.max(...lats)).toBeLessThan(36.5655);
    expect((Math.min(...lons) + Math.max(...lons)) / 2).toBeCloseTo(-79.2, 2);
    // racing-line speed comes from the Speed channel (m/s), modulated ±5% around 40
    const vs = out.gps.map((p) => p.v);
    expect(Math.max(...vs)).toBeGreaterThan(40);
    expect(Math.max(...vs)).toBeLessThan(42.5);
  });

  it("keeps decoder state across sample boundaries", async () => {
    // the fixture splits records into 250-record samples; a state reset would
    // orphan every delta at a sample start and thin or corrupt the trace
    const out = await parse();
    const dt = out.gps.slice(1).map((p, i) => p.t - out.gps[i].t);
    expect(Math.max(...dt)).toBeLessThan(1.5); // no holes
    expect(out.durationS).toBeGreaterThan(150);
  });

  it("times laps from delta-stream beacons and reads mrlv date/time", async () => {
    const out = await parse({ beaconTimes: [30, 30 + lapS, 30 + 2 * lapS] });
    const ms = Math.round(lapS * 1000); // 47124
    expect(out.laps.map((l) => l.timeMs)).toEqual([ms, ms]);
    expect(out.laps.every((l) => !l.estimated)).toBe(true);
    expect(out.date).toBe("2026-06-20");
    expect(out.time).toBe("09:15:00");
  });

  it("reports top speed, max RPM and max lateral G from the car channels", async () => {
    const out = await parse();
    // speed peaks at 42 m/s = 151.2 km/h; rpm at 6000; latAcc at v²/r ≈ 0.6 G
    expect(out.metrics.topSpeedKph).toBeGreaterThan(148);
    expect(out.metrics.topSpeedKph).toBeLessThan(152);
    expect(out.metrics.maxRpm).toBeGreaterThan(5900);
    expect(out.metrics.maxRpm).toBeLessThanOrEqual(6000);
    expect(out.metrics.maxLatG).toBeGreaterThan(0.5);
    expect(out.metrics.maxLatG).toBeLessThan(0.65);
  });
});

describe("boxes", () => {
  // Build a buffer holding two MP4 boxes: "ftyp" (12 bytes) and "free" (8 bytes).
  function buildBoxes() {
    const buf = new ArrayBuffer(20);
    const dv = new DataView(buf);
    const put = (off, size, type) => {
      dv.setUint32(off, size);
      [...type].forEach((ch, i) => dv.setUint8(off + 4 + i, ch.charCodeAt(0)));
    };
    put(0, 12, "ftyp");
    put(12, 8, "free");
    return dv;
  }

  it("parses consecutive box headers", () => {
    const dv = buildBoxes();
    const out = boxes(dv, 0, 20);
    expect(out).toEqual([
      { type: "ftyp", start: 0, body: 8, size: 12 },
      { type: "free", start: 12, body: 20, size: 8 },
    ]);
  });

  it("stops at garbage instead of running away", () => {
    const dv = buildBoxes();
    dv.setUint32(12, 3); // invalid size < 8
    expect(boxes(dv, 0, 20)).toHaveLength(1);
  });
});
