import { describe, expect, it } from "vitest";
import { boxes } from "../../public/pdr.js";
import { parseChannelTable, parsePdr25File, parseSchedule } from "../../public/js/import/pdr25.js";
import { parseTelemetryFile } from "../../public/js/import/parse.js";
import { LAP_S, buildPdr25Mp4, buildPdrDeltaMp4 } from "../fixtures/build.mjs";

const lapS = LAP_S();
const crossings = [30, 30 + lapS, 30 + 2 * lapS];
const file = (bytes, name = "ADV_0001.mp4") => new File([bytes], name);
const range = (arr) => [Math.min(...arr.map((p) => p.v)), Math.max(...arr.map((p) => p.v))];

// The 'adco' sample entry's child boxes, for the table-level tests.
function adcoParts(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const find = (list, type) => list.find((b) => b.type === type);
  const kids = (b) => boxes(dv, b.body, b.start + b.size);
  const moov = find(boxes(dv, 0, dv.byteLength), "moov");
  const stsd = find(kids(find(kids(find(kids(find(kids(find(kids(moov), "trak")), "mdia")), "minf")), "stbl")), "stsd");
  const adco = boxes(dv, stsd.body + 8, stsd.start + stsd.size)[0];
  return { dv, parts: boxes(dv, adco.body + 8, adco.start + adco.size) };
}

describe("PDR 2.5 (AliveDrive) self-description", () => {
  const { dv, parts } = adcoParts(buildPdr25Mp4());
  const part = (t) => parts.find((b) => b.type === t);

  it("reads every channel entry, numeric scalings and enum labels alike", () => {
    const b = part("adcp");
    const chans = parseChannelTable(dv, b.body, b.start + b.size);
    const byName = new Map([...chans.values()].map((c) => [c.name, c]));
    expect(byName.get("speed")).toMatchObject({ kind: 1, mult: 1 / 230.4, off: 0 });
    expect(byName.get("engine.temperature.oil").off).toBeCloseTo(233.15, 9);
    expect(byName.get("gear").labels).toMatchObject({ notsupported: 0, first: 1, tenth: 10, neutral: 13 });
    // the reversed status: read by label, never assumed
    expect(byName.get("stability.vehiclestabilityenhancement").labels).toEqual({ unknown: 3, active: 0, inactive: 1 });
    expect([...chans.keys()]).toContain(58);
  });

  it("reads the record schedule with each group's byte size", () => {
    const b = part("adcr");
    const groups = parseSchedule(dv, b.body, b.start + b.size);
    expect(groups.map((g) => g.period)).toEqual([500000, 1000000, 2000000, 10000000]);
    // brake u8 + rpm u16 + steering s16 + yaw s16
    expect(groups[0].bytes).toBe(7);
  });
});

describe("parsePdr25File", () => {
  it("times laps from lap.start / lap.end events, exactly", async () => {
    const out = await parsePdr25File(file(buildPdr25Mp4({ lapCrossings: crossings })));
    expect(out.laps.map((l) => l.timeMs)).toEqual([Math.round(lapS * 1000), Math.round(lapS * 1000)]);
    expect(out.laps.every((l) => !l.estimated)).toBe(true);
    expect(out.laps.map((l) => l.lapNumber)).toEqual([1, 2]);
    expect(out.laps[0].startT).toBeCloseTo(30, 6);
    // three crossings; the lap opened at the last one never closes
    expect(out.beaconCount).toBe(3);
  });

  it("takes the recorder's +00:00 timestamp as local wall-clock time", async () => {
    const out = await parsePdr25File(file(buildPdr25Mp4({ stamp: "2026-07-17T15:49:31" })));
    expect([out.date, out.time]).toEqual(["2026-07-17", "15:49:31"]);
  });

  it("converts every car channel to parsePdrFile's display units", async () => {
    const { carChannels: c, metrics } = await parsePdr25File(file(buildPdr25Mp4()));
    // 40 m/s +-5% -> km/h; rpm from rad/s
    expect(range(c.speed)[0]).toBeCloseTo(136.8, 0);
    expect(range(c.speed)[1]).toBeCloseTo(151.2, 0);
    expect(range(c.rpm)[0]).toBeCloseTo(3000, 6);
    expect(range(c.rpm)[1]).toBeCloseTo(6000, 6);
    // the axis swap: lateral from vehicle.x (v²/r), longitudinal from -vehicle.y
    expect(range(c.latG)[1]).toBeCloseTo((42 * 42) / 300 / 9.80665, 2);
    expect(range(c.longG)[0]).toBeCloseTo(-0.8, 3);
    expect(metrics.maxBrakeG).toBeCloseTo(0.8, 3);
    expect(range(c.throttle)).toEqual([0, 100]);
    expect(range(c.steering)[1]).toBeCloseTo(30, 1);
    expect(range(c.yaw)[0]).toBeGreaterThan(7);
    expect(range(c.boost)).toEqual([-60, 60]);
    // rear wheels 2% over the fronts
    expect(range(c.wheelSlip)[0]).toBeCloseTo(2, 3);
  });

  it("reads gears and the stability flags by label", async () => {
    const { carChannels: c } = await parsePdr25File(file(buildPdr25Mp4()));
    // neutral (13) is the no-gear state, never a thirteenth gear
    expect([...new Set(c.gear.map((p) => p.v))].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    const bits = c.flags.reduce((m, p) => m | p.v, 0);
    expect(bits & 1).toBe(1); // ABS
    expect(bits & 2).toBe(2); // traction control
    expect(bits & 4).toBe(4); // stability control
  });

  it("reduces the slow channels to per-lap scalars and session context", async () => {
    const out = await parsePdr25File(file(buildPdr25Mp4()));
    const s = out.lapScalarChannels;
    expect(range(s.oilC)).toEqual([43, 130]);
    expect(range(s.oilKpa)).toEqual([224, 336]);
    expect(range(s.tyreKpaLF)).toEqual([144, 220]);
    expect(range(s.tyreCRR)[1]).toBeCloseTo(77, 6);
    expect(s.battV).toBeNull(); // the recorder has no battery channel
    expect(out.sessionMeta.ambientC).toBeCloseTo(15, 6);
    expect(out.sessionMeta.odometerKm).toBeGreaterThan(71000);
    expect(out.channels).toBeNull();
  });

  it("keeps only GPS fixes that have a position", async () => {
    const { gps } = await parsePdr25File(file(buildPdr25Mp4()));
    expect(gps[0].t).toBeGreaterThanOrEqual(2);
    expect(gps[0].lat).toBeCloseTo(36.56, 2);
    expect(gps[0].v).toBeCloseTo(40, 0); // m/s, like a PDR trace
  });

  it("refuses a file without the 'adrv' track as not its own", async () => {
    await expect(parsePdr25File(file(buildPdrDeltaMp4()))).rejects.toThrow(/No .* telemetry track/);
  });
});

describe("PDR 2.5 through the import dispatch", () => {
  it("arrives as a PDR session with exact laps, a best-lap trace and per-lap channels", async () => {
    const out = await parseTelemetryFile(file(buildPdr25Mp4({ lapCrossings: crossings })));
    expect(out.kind).toBe("pdr");
    expect(out.needsLine).toBe(false);
    expect(out.bestLapTrace.length).toBeGreaterThan(50);
    expect(out.lapChannels.laps).toHaveLength(2);
    expect(out.lapChannels.laps[0].gear.length).toBeGreaterThan(50);
  });

  it("sends a recording with no lap events to the line picker", async () => {
    const out = await parseTelemetryFile(file(buildPdr25Mp4()));
    expect(out.laps).toEqual([]);
    expect(out.needsLine).toBe(true);
    expect(out.lapRecovery).toBeNull();
  });

  it("still parses a Corvette PDR as the Marlin format", async () => {
    const out = await parseTelemetryFile(file(buildPdrDeltaMp4({ beaconTimes: crossings })));
    expect(out.kind).toBe("pdr");
    expect(out.channels.odoPts.length).toBeGreaterThan(50);
  });
});
