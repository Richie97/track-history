// Synthetic telemetry fixtures for tests: a circular GPS trace and minimal
// but structurally-valid VBO, GoPro-GPMF MP4 and Corvette-PDR MP4 files
// built from it. Used by unit tests and by the browser verification script.

// --- reference trace ----------------------------------------------------------

export const LAP_S = (radius = 300, speed = 40) => (2 * Math.PI * radius) / speed; // 47.12s

// Counter-clockwise circle. With `revolutions = 3.3` a start/finish line at a
// quarter turn is crossed 4 times -> 3 derived laps.
export function circleTrace({ revolutions = 3.3, radius = 300, speed = 40, hz = 10, lat0 = 36.56, lon0 = -79.2 } = {}) {
  const totalS = (2 * Math.PI * radius * revolutions) / speed;
  const n = Math.floor(totalS * hz);
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / hz;
    const ang = (speed * t) / radius;
    pts.push({
      t,
      lat: lat0 + (radius * Math.sin(ang)) / ky,
      lon: lon0 + (radius * Math.cos(ang)) / kx,
      v: speed,
    });
  }
  return pts;
}

// The point on the circle at `frac` of a revolution (for line placement).
export function circlePointAt(frac, { radius = 300, lat0 = 36.56, lon0 = -79.2, radialOffset = 0 } = {}) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  const r = radius + radialOffset;
  const ang = 2 * Math.PI * frac;
  return { lat: lat0 + (r * Math.sin(ang)) / ky, lon: lon0 + (r * Math.cos(ang)) / kx };
}

// --- VBO -----------------------------------------------------------------------

// Racelogic conventions: coordinates in minutes, longitude west-positive.
const vboLat = (lat) => (lat * 60).toFixed(5);
const vboLon = (lon) => (-lon * 60).toFixed(5);

// `latFirst` writes the [laptiming] endpoints latitude-first, as some
// exporters do (Racelogic's own order is longitude first). `trackPrecision`
// writes the Porsche Track Precision App's layout: an export-time "created
// at" line, one column name per line (names with spaces), car channels, and
// a zeroed column the car didn't report.
// `accelMs2` writes LatAcc_PTPA in m/s², as the 2024 Track Precision
// firmware does; `silentAfterS` has the car stop reporting (every car column
// written as 0) from that time on while the GPS carries on.
export function buildVboText(
  points,
  {
    withLapTiming = false,
    startTod = "091500.00",
    latFirst = false,
    trackPrecision = false,
    lineHalfM = 20,
    accelMs2 = false,
    silentAfterS = null,
  } = {}
) {
  const todBase =
    Number(startTod.slice(0, 2)) * 3600 + Number(startTod.slice(2, 4)) * 60 + Number(startTod.slice(4));
  const rows = points.map((p) => {
    const tod = todBase + p.t;
    const h = String(Math.floor(tod / 3600)).padStart(2, "0");
    const m = String(Math.floor((tod % 3600) / 60)).padStart(2, "0");
    const s = (tod % 60).toFixed(2).padStart(5, "0");
    const base = `008 ${h}${m}${s} ${vboLat(p.lat)} ${vboLon(p.lon)} ${(p.v * 3.6).toFixed(3)}`;
    if (!trackPrecision) return base;
    // Synthetic car: a pedal fraction, brake pressure in bar, 3rd and 4th
    // gear, steering, rpm, G (the scaled `latacc` next to the true
    // LatAcc_PTPA), tyre pressures in bar and an all-zero `yaw`.
    const ph = (2 * Math.PI * p.t) / 10;
    const pedal = (0.5 + 0.5 * Math.sin(ph)).toFixed(2);
    const braking = Math.max(0, -40 * Math.sin(ph)).toFixed(1);
    const latG = 0.9 * Math.cos(ph);
    if (silentAfterS != null && p.t >= silentAfterS) return `${base} 0 0 0.00 0.0 0.00 0.0000 0.000 0.0 3276.8 0`;
    const ptpa = accelMs2 ? latG * 9.81 : latG;
    return `${base} ${Math.sin(ph) > 0 ? 4 : 3} ${(4000 + 2000 * Math.sin(ph)).toFixed(0)} ${pedal} ${braking} ${(30 * Math.cos(ph)).toFixed(2)} ${(ptpa / 9.81).toFixed(4)} ${ptpa.toFixed(3)} 2.1 3276.8 0`;
  });
  let lapTiming = "";
  if (withLapTiming) {
    const a = circlePointAt(0.25, { radialOffset: -lineHalfM });
    const b = circlePointAt(0.25, { radialOffset: lineHalfM });
    const ends = latFirst
      ? `${vboLat(a.lat)} ${vboLon(a.lon)} ${vboLat(b.lat)} ${vboLon(b.lon)}`
      : `${vboLon(a.lon)} ${vboLat(a.lat)} ${vboLon(b.lon)} ${vboLat(b.lat)}`;
    lapTiming = `\n[laptiming]\nStart\t${ends}\n`;
  }
  if (trackPrecision) {
    const names = ["sats", "time", "lat", "long", "velocity", "current gear", "engine", "pedal", "braking",
      "steering wheel angle", "latacc", "LatAcc_PTPA", "tire pressure front left", "tire pressure front right", "yaw"];
    return `File created at 2026-09-22 21:59:37 -0600

[header]
satellites
time
latitude
longitude
velocity kmh
${lapTiming}
[column names]
${names.join("\n")}

[data]
${rows.join("\n")}
`;
  }
  return `File created on 20/06/2026 at 09:15:00

[header]
satellites
time
lat
long
velocity kmh
${lapTiming}
[column names]
sats time lat long velocity

[data]
${rows.join("\n")}
`;
}

// --- Porsche Track Precision CSV ---------------------------------------------------

// The app's CSV export: its 34 camelCase columns (empty where the car sent
// nothing), epoch-ms timestamps, decimal degrees, and its own lap timer
// against a line at a quarter turn of circleTrace — `laptime` is the ms since
// the car last crossed it, 0 before the first crossing, and `lapDistance`
// the metres. Options mirror the firmware differences the parser handles:
//   speedUnit    "kmh" (2024 exports) or "ms" (later)
//   accelMs2     accelerations in m/s² (2024) rather than G
//   spaced       ", " between fields, as newer app versions write
//   zeroAtLine   the first sample of each lap written as laptime 0, as some
//                firmware does, rather than the small value since the line
//   silentAfterS the car stops reporting (car columns 0) from then on
//   radius / speed as circleTrace's, so the line lands on the circle
//   firstCrossT  when the car first crosses the line (see below)
export const CSV_START_TS = 1780000000000; // 2026-05-28T20:26:40Z
export function buildTrackPrecisionCsv(
  points,
  {
    speedUnit = "ms",
    accelMs2 = false,
    spaced = false,
    zeroAtLine = false,
    silentAfterS = null,
    radius = 300,
    speed = 40,
    firstCrossT = null,
  } = {}
) {
  const header = [
    "brakingPressure", "currentGear", "distanceCounter", "electronicStabilityProgram", "engineSpeed",
    "fuelConsumption", "gearSelection", "lapDistance", "laptime", "lateralAcceleration",
    "longitudinalAcceleration", "longitudinalSlipRR", "longitudinalSlipRL", "longitudinalSlipFR",
    "longitudinalSlipFL", "pedalForce", "sectorDistance", "sectorTime", "speed", "steeringWheelAngle",
    "timestamp", "tirePressureFR", "tirePressureFL", "tirePressureRR", "tirePressureRL", "tripDistance",
    "wpoCharismaDamper", "wpoCharismaMotor", "wpoCharismaTransmission", "wpoOversteer", "wpoUndersteer",
    "latitude", "longitude", "yawVelocity",
  ];
  // Crossings of the quarter-turn line in the points' own clock: the first at
  // `firstCrossT` (a quarter lap in for an untrimmed circleTrace; negative
  // for a recording that starts just past the line, whose timer is already
  // running), then one every lap.
  const lapS = (2 * Math.PI * radius) / speed;
  const cross0 = firstCrossT ?? lapS / 4;
  let prevLap = null;
  const rows = points.map((p) => {
    const k = Math.floor((p.t - cross0) / lapS);
    const running = k >= 0;
    const since = p.t - (cross0 + k * lapS);
    const trueLap = running ? Math.round(since * 1000) : 0;
    const lapMs = zeroAtLine && prevLap != null && trueLap < prevLap ? 0 : trueLap;
    prevLap = trueLap;
    const lapM = running ? since * speed : 0;
    const ph = (2 * Math.PI * p.t) / 10;
    const silent = silentAfterS != null && p.t >= silentAfterS;
    const latG = 0.9 * Math.cos(ph);
    const longG = -0.6 * Math.sin(ph);
    const g = accelMs2 ? 9.81 : 1;
    const v = speedUnit === "kmh" ? p.v * 3.6 : p.v;
    const f = {
      brakingPressure: silent ? "0.0" : Math.max(0, -40 * Math.sin(ph)).toFixed(1),
      currentGear: silent ? "0" : String(Math.sin(ph) > 0 ? 4 : 3),
      distanceCounter: (p.t * speed).toFixed(3),
      electronicStabilityProgram: "",
      engineSpeed: silent ? "0" : (4000 + 2000 * Math.sin(ph)).toFixed(0),
      fuelConsumption: "0.0",
      gearSelection: "",
      lapDistance: lapM.toFixed(1),
      laptime: String(lapMs),
      lateralAcceleration: silent ? "0.0" : (latG * g).toFixed(3),
      longitudinalAcceleration: silent ? "0.0" : (longG * g).toFixed(3),
      longitudinalSlipRR: "0.0",
      longitudinalSlipRL: "0.0",
      longitudinalSlipFR: "0.0",
      longitudinalSlipFL: "0.0",
      pedalForce: silent ? "0.0" : (0.5 + 0.5 * Math.sin(ph)).toFixed(2),
      sectorDistance: "",
      sectorTime: "",
      speed: v.toFixed(3),
      steeringWheelAngle: silent ? "0.0" : (30 * Math.cos(ph)).toFixed(2),
      timestamp: String(CSV_START_TS + Math.round(p.t * 1000)),
      tirePressureFR: "3276.8",
      tirePressureFL: silent ? "0.0" : "2.1",
      tirePressureRR: "3276.8",
      tirePressureRL: "3276.8",
      tripDistance: "0",
      wpoCharismaDamper: "",
      wpoCharismaMotor: "",
      wpoCharismaTransmission: "",
      wpoOversteer: "0.0",
      wpoUndersteer: "0.0",
      latitude: p.lat.toFixed(9),
      longitude: p.lon.toFixed(9),
      yawVelocity: "0.0",
    };
    return header.map((h) => f[h]).join(spaced ? ", " : ",");
  });
  return [header.join(spaced ? ", " : ","), ...rows].join("\n") + "\n";
}

// --- shared helpers --------------------------------------------------------------

function concat(arrays) {
  const len = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let p = 0;
  for (const a of arrays) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

// --- MP4 (shared by GPMF and PDR fixtures) --------------------------------------

const te = new TextEncoder();

function box(type, ...parts) {
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(te.encode(type), 4);
  out.set(body, 8);
  return out;
}

const u32 = (...vals) => {
  const out = new Uint8Array(vals.length * 4);
  const dv = new DataView(out.buffer);
  vals.forEach((v, i) => dv.setUint32(i * 4, v));
  return out;
};

// One telemetry-track MP4: ftyp + mdat(payloads) + moov(trak with the given
// handler/sample-format and one sample per chunk). `sampleEntryChildren`
// nests boxes (mrld/mrlv) inside the sample entry, after its standard 8-byte
// reserved/data-reference-index fields.
// `samplesPerChunk` packs consecutive samples into one chunk (the last chunk
// takes whatever is left), which is what a real PDR 2.5 file's 'stsc' does.
function buildTelemetryMp4({ handler, sampleFormat, payloads, timescale = 1000, sampleDelta = 1000, sampleEntryChildren = [], samplesPerChunk = 1 }) {
  const ftyp = box("ftyp", te.encode("mp42"), u32(0));
  const mdatBody = concat(payloads);
  const mdat = box("mdat", mdatBody);

  const offsets = [];
  let off = ftyp.length + 8; // mdat body starts after its own header
  payloads.forEach((p, i) => {
    if (i % samplesPerChunk === 0) offsets.push(off);
    off += p.length;
  });
  const tail = payloads.length % samplesPerChunk;
  const stscRuns = [[1, samplesPerChunk, 1]];
  if (tail && offsets.length > 1) stscRuns.push([offsets.length, tail, 1]);
  else if (tail) stscRuns[0][1] = tail;

  const sampleEntry = sampleEntryChildren.length
    ? box(sampleFormat, new Uint8Array(8), ...sampleEntryChildren)
    : box(sampleFormat);
  const n = payloads.length;
  const stbl = box(
    "stbl",
    box("stsd", u32(0, 1), sampleEntry),
    box("stts", u32(0, 1, n, sampleDelta)),
    box("stsc", u32(0, stscRuns.length, ...stscRuns.flat())),
    box("stsz", u32(0, 0, n, ...payloads.map((p) => p.length))),
    box("stco", u32(0, offsets.length, ...offsets))
  );
  const mdhd = box("mdhd", u32(0, 0, 0, timescale, n * sampleDelta));
  const hdlr = box("hdlr", u32(0, 0), te.encode(handler), u32(0, 0, 0));
  const trak = box("trak", box("mdia", mdhd, hdlr, box("minf", stbl)));
  const moov = box("moov", box("mvhd", u32(0, 0, 0, timescale, 0)), trak);

  return concat([ftyp, mdat, moov]);
}

// --- GoPro GPMF fixture ---------------------------------------------------------

function klv(key, typeChar, structSize, repeat, data) {
  const padded = (data.length + 3) & ~3;
  const out = new Uint8Array(8 + padded);
  out.set(te.encode(key), 0);
  const dv = new DataView(out.buffer);
  dv.setUint8(4, typeChar === 0 ? 0 : typeChar.charCodeAt(0));
  dv.setUint8(5, structSize);
  dv.setUint16(6, repeat);
  out.set(data, 8);
  return out;
}

const i32be = (...vals) => {
  const out = new Uint8Array(vals.length * 4);
  const dv = new DataView(out.buffer);
  vals.forEach((v, i) => dv.setInt32(i * 4, Math.round(v)));
  return out;
};

// Chunk a trace into 1-second GPMF payloads carrying a GPS5 stream.
export function buildGpmfMp4(points, { utc = "260620091500.000" } = {}) {
  const bySecond = new Map();
  for (const p of points) {
    const s = Math.floor(p.t);
    if (!bySecond.has(s)) bySecond.set(s, []);
    bySecond.get(s).push(p);
  }
  const payloads = [...bySecond.keys()].sort((a, b) => a - b).map((s) => {
    const pts = bySecond.get(s);
    const gps5 = i32be(...pts.flatMap((p) => [p.lat * 1e7, p.lon * 1e7, 100 * 1000, (p.v ?? 0) * 1000, (p.v ?? 0) * 100]));
    const strm = klv(
      "STRM",
      0,
      1,
      0, // container: repeat patched below
      concat([
        klv("GPSU", "U", 16, 1, te.encode(utc)),
        klv("GPSF", "L", 4, 1, u32(3)),
        klv("SCAL", "l", 4, 5, i32be(1e7, 1e7, 1000, 1000, 100)),
        klv("GPS5", "l", 20, pts.length, gps5),
      ])
    );
    // containers encode their byte length as structSize=1 * repeat=len
    new DataView(strm.buffer).setUint16(6, strm.length - 8);
    const devc = klv("DEVC", 0, 1, 0, strm);
    new DataView(devc.buffer).setUint16(6, devc.length - 8);
    return devc;
  });
  return buildTelemetryMp4({ handler: "meta", sampleFormat: "gpmd", payloads });
}

// --- Corvette PDR fixture --------------------------------------------------------

// 16-byte PDR full record: [0xe0|tag:u24][value:s32][ticks:u64 in 100ns].
function pdrEvent(tag, value, tSeconds) {
  const out = new Uint8Array(16);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0xe0000000 | tag);
  dv.setInt32(4, value);
  const ticks = BigInt(Math.round(tSeconds * 1e7));
  dv.setUint32(8, Number(ticks >> 32n));
  dv.setUint32(12, Number(ticks & 0xffffffffn));
  return out;
}

// 8-byte PDR delta record: [01|chanDiff:s6][valueDiff:s24][ticksDiff:u32],
// applied to the decoder's running channel/value/timestamp state.
function pdrDelta(chanDiff, valueDiff, ticksDiff) {
  const out = new Uint8Array(8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, ((0x40 | (chanDiff & 0x3f)) << 24) | (valueDiff & 0xffffff));
  dv.setUint32(4, ticksDiff);
  return out;
}

// Encode time-sorted {ch, v, t} events the way real firmware does: a full
// record the first time a channel appears (or when a diff won't fit), delta
// records for everything after.
function pdrStream(events) {
  const out = [];
  const vals = new Map();
  let chan = null, ticks = 0;
  for (const e of events) {
    const tk = Math.round(e.t * 1e7);
    const vd = vals.has(e.ch) ? e.v - vals.get(e.ch) : null;
    const cd = chan === null ? null : e.ch - chan;
    if (cd !== null && cd >= -32 && cd <= 31 && vd !== null && vd >= -0x800000 && vd < 0x800000 && tk >= ticks) {
      out.push(pdrDelta(cd, vd, tk - ticks));
    } else {
      out.push(pdrEvent(e.ch, e.v, e.t));
    }
    chan = e.ch;
    ticks = tk;
    vals.set(e.ch, e.v);
  }
  return out;
}

// 448-byte 'mrld' channel dictionary entry: id at +0, units at +12, min/max
// s32 at +88/+92, multiplier/offset f64 at +112/+120, name at +128.
function mrldEntry({ id, name, units = "", min = 0, max = 0, mult = 1, off = 0 }) {
  const e = new Uint8Array(448);
  const dv = new DataView(e.buffer);
  dv.setUint32(0, id);
  e.set(te.encode(units), 12);
  dv.setInt32(88, min);
  dv.setInt32(92, max);
  dv.setFloat64(112, mult);
  dv.setFloat64(120, off);
  e.set(te.encode(name), 128);
  return e;
}

// 'mrlv' metadata box carrying the session's local date/time.
function mrlvBox(date = "2026-06-20", time = "09-15-00") {
  const field = (tag, fmt, value, len) => {
    const out = new Uint8Array(8 + len);
    out.set(te.encode(tag), 0);
    out.set(te.encode(fmt), 4);
    out.set(te.encode(value), 8);
    return out;
  };
  return box("mrlv", field("ldat", "date", date, 32), field("ltim", "time", time, 32));
}

// PDR file (default tag ids, no mrld/mrlv, full records only): beacon
// crossings at the given times with sequential crossing numbers -> exact laps
// between them, plus optional Latitude/Longitude channel events from a GPS
// trace. `gpsEncoding` picks how degrees land in the event's s32: scaled
// integer (deg * 1e7) or IEEE float32 bits — the heuristic decoders used when
// a file carries no channel dictionary. Real firmware delta-encodes and
// carries a dictionary: that shape is buildPdrDeltaMp4 below.
export function buildPdrMp4({
  beaconTimes = [100, 147.12, 194.24],
  firstCrossing = 5,
  gpsPoints = null,
  gpsEncoding = "i32",
} = {}) {
  const events = beaconTimes.map((t, i) => pdrEvent(0x36, firstCrossing + i, t));
  if (gpsPoints) {
    const f32 = new DataView(new ArrayBuffer(4));
    const raw = (deg) => {
      if (gpsEncoding !== "f32") return Math.round(deg * 1e7);
      f32.setFloat32(0, deg);
      return f32.getInt32(0);
    };
    for (const p of gpsPoints) {
      events.push(pdrEvent(0x31, raw(p.lat), p.t));
      events.push(pdrEvent(0x32, raw(p.lon), p.t));
    }
  }
  return buildTelemetryMp4({ handler: "ctbx", sampleFormat: "marl", payloads: [concat(events)] });
}

// PDR file with a delta-encoded telemetry stream and a channel dictionary —
// the shape of real firmware (each channel gets one full record, then streams
// 8-byte diffs; lat/lon are stored as radians scaled by the dictionary
// multiplier). The car drives the reference circle at `speed` m/s modulated
// by ±5%, with RPM swinging 3000–6000. Events are split across several
// samples so decoder state must persist between them.
export function buildPdrDeltaMp4({
  beaconTimes = [],
  firstCrossing = 5,
  revolutions = 3.3,
  radius = 300,
  speed = 40,
  lat0 = 36.56,
  lon0 = -79.2,
} = {}) {
  const CH = {
    speed: 40, rpm: 41, latAcc: 42, throttle: 43, brake: 44, steering: 45,
    longAcc: 46, yaw: 47, gear: 48, lat: 49, lon: 50, boost: 51,
    wsLN: 52, wsRN: 53, beacon: 54, wsLD: 55, wsRD: 56,
    abs: 57, tc: 58, vsc: 59,
    oilC: 60, oilKpa: 61, coolantC: 62, transC: 63, fuelPct: 64, battV: 65, odo: 66,
    tyreKpaLF: 67, tyreKpaRF: 68, tyreKpaLR: 69, tyreKpaRR: 70,
    tyreCLF: 71, tyreCRF: 72, tyreCLR: 73, tyreCRR: 74,
    ambientC: 75, intakeC: 76, altitude: 77, carOdo: 78,
  };
  const RAD = Math.PI / 180;
  const kx = 111320 * Math.cos(lat0 * RAD);
  const ky = 110540;
  const totalS = (2 * Math.PI * radius * revolutions) / speed;
  const events = beaconTimes.map((t, i) => ({ ch: CH.beacon, v: firstCrossing + i, t }));
  for (let t = 0.1; t <= totalS; t += 0.5) {
    const ang = (speed * t) / radius;
    events.push({ ch: CH.lat, v: Math.round((lat0 + (radius * Math.sin(ang)) / ky) * RAD * 1e9), t });
    events.push({ ch: CH.lon, v: Math.round((lon0 + (radius * Math.cos(ang)) / kx) * RAD * 1e9), t });
    const v = speed * (1 + 0.05 * Math.sin(t / 20)); // m/s
    events.push({ ch: CH.speed, v: Math.round(v * 100), t });
    events.push({ ch: CH.rpm, v: Math.round(4500 + 1500 * Math.sin(t / 10)), t });
    events.push({ ch: CH.latAcc, v: Math.round(((v * v) / radius) * 1000), t });
    // pedals as raw 0-255 (dict mult 1/255 -> fraction, "%" units -> 0-100),
    // alternating so both see their full-ish range; steering in milliradians
    // with an EMPTY units string, the real-firmware shape pdr.js must convert
    // to degrees itself.
    const pedal = Math.sin(t / 8);
    events.push({ ch: CH.throttle, v: Math.round(Math.max(0, pedal) * 255), t });
    events.push({ ch: CH.brake, v: Math.round(Math.max(0, -pedal) * 255), t });
    events.push({ ch: CH.steering, v: Math.round(500 * Math.sin(t / 6)), t });
    // longitudinal accel in m/s² (the "G" dict unit is SI); yaw rate is v/r
    // in rad/s, which "°/sec" converts to degrees.
    events.push({ ch: CH.longAcc, v: Math.round(8 * Math.sin(t / 7) * 1000), t });
    events.push({ ch: CH.yaw, v: Math.round((v / radius) * 1000), t });
    // an enum, cycling 1-5 with the 13 = "in transition" state the parser
    // must map to 0 rather than plot as a thirteenth gear
    events.push({ ch: CH.gear, v: t % 60 < 3 ? 13 : 1 + (Math.floor(t / 7) % 5), t });
    // raw 0-255 against mult 1000 / off -128000 -> Pascals gauge, which the
    // "kPa" unit divides down: ±128 kPa
    events.push({ ch: CH.boost, v: Math.round(128 + 60 * Math.sin(t / 9)), t });
    // driven wheels turn ~2% faster than non-driven under power -> wheelSlip
    events.push({ ch: CH.wsLN, v: Math.round(v * 100), t });
    events.push({ ch: CH.wsRN, v: Math.round(v * 100), t });
    events.push({ ch: CH.wsLD, v: Math.round(v * 1.02 * 100), t });
    events.push({ ch: CH.wsRD, v: Math.round(v * 1.02 * 100), t });
    // ABS fires in short bursts — narrower than the 20 m grid spacing, so a
    // point sample would miss them and only the window sampler sees them
    events.push({ ch: CH.abs, v: Math.sin(t / 7) < -0.98 ? 1 : 0, t });
    events.push({ ch: CH.tc, v: 0, t });
    events.push({ ch: CH.vsc, v: 0, t });
  }
  // Slow housekeeping at 0.5Hz — too sparse for the distance grid, so these
  // become per-lap scalars. Raw values here are what real firmware stores:
  // Kelvin behind the channel's own offset, Pascals behind "kPa".
  // Raw values and spans here are the ones a real C7 PDR writes (measured off
  // a VIR session), so a test can assert the display-unit range and be
  // asserting something true about the format.
  for (let t = 0; t <= totalS; t += 2) {
    const warm = Math.min(1, t / 120); // saturates inside the fixture's length
    events.push({ ch: CH.oilC, v: Math.round(83 + 87 * warm), t });          // 43 -> 130°C
    events.push({ ch: CH.oilKpa, v: Math.round(70 + 14 * Math.sin(t / 11)), t }); // 224-336 kPa
    events.push({ ch: CH.coolantC, v: Math.round(110 + 35 * warm), t });     // 70 -> 105°C
    events.push({ ch: CH.transC, v: Math.round(59 + 79 * warm), t });        // 19 -> 98°C
    events.push({ ch: CH.fuelPct, v: Math.round(248 - 61 * warm), t });      // 97 -> 73%
    events.push({ ch: CH.battV, v: Math.round(140 + 12 * Math.sin(t / 13)), t }); // 12.8-15.2V
    for (const [ch, base] of [[CH.tyreKpaLF, 36], [CH.tyreKpaRF, 37], [CH.tyreKpaLR, 38], [CH.tyreKpaRR, 39]]) {
      events.push({ ch, v: Math.round(base + 19 * warm), t });               // 144 -> 220 kPa
    }
    for (const [ch, base] of [[CH.tyreCLF, 37], [CH.tyreCRF, 38], [CH.tyreCLR, 39], [CH.tyreCRR, 40]]) {
      events.push({ ch, v: Math.round(base + 57 * warm), t });               // 17 -> 74°C
    }
    events.push({ ch: CH.ambientC, v: 55, t });                              // 15°C
    events.push({ ch: CH.intakeC, v: 57, t });                               // 17°C
    events.push({ ch: CH.altitude, v: Math.round(11260 + 3800 * Math.abs(Math.sin(t / 40))), t });
    events.push({ ch: CH.carOdo, v: Math.round(4549603 + (speed * t) / 15.625), t });
  }
  for (let t = 0; t <= totalS; t += 0.15) {
    events.push({ ch: CH.odo, v: Math.round(speed * t), t });
  }
  events.sort((a, b) => a.t - b.t);

  const records = pdrStream(events);
  const payloads = [];
  for (let i = 0; i < records.length; i += 250) payloads.push(concat(records.slice(i, i + 250)));

  const mrld = box(
    "mrld",
    mrldEntry({ id: CH.speed, name: "Speed", units: "kph", mult: 0.01 }),
    mrldEntry({ id: CH.rpm, name: "RPM", units: "rpm", mult: 0.1 }),
    mrldEntry({ id: CH.latAcc, name: "Lateral Acceleration", units: "G", mult: 0.001 }),
    mrldEntry({ id: CH.throttle, name: "Accel Pos", units: "%", min: 0, max: 255, mult: 1 / 255 }),
    mrldEntry({ id: CH.brake, name: "Brake Pos", units: "%", min: 0, max: 255, mult: 1 / 255 }),
    mrldEntry({ id: CH.steering, name: "Steering Angle", min: -1000, max: 1000, mult: 0.001 }),
    mrldEntry({ id: CH.lat, name: "Latitude", units: "°", mult: 1e-9, min: -1571000000, max: 1571000000 }),
    mrldEntry({ id: CH.lon, name: "Longitude", units: "°", mult: 1e-9, min: -2000000000, max: 2000000000 }),
    mrldEntry({ id: CH.beacon, name: "Beacon" }),
    mrldEntry({ id: CH.odo, name: "Recording Event Odometer", units: "km" }),
    mrldEntry({ id: CH.longAcc, name: "Longitudinal Acceleration", units: "G", mult: 0.001 }),
    mrldEntry({ id: CH.yaw, name: "Yaw Rate", units: "°/sec", mult: 0.001 }),
    mrldEntry({ id: CH.gear, name: "Gear", min: 0, max: 15, mult: 1 }),
    mrldEntry({ id: CH.boost, name: "Intake Boost Pressure", units: "kPa", min: 0, max: 255, mult: 1000, off: -128000 }),
    mrldEntry({ id: CH.wsLN, name: "Wheelspeed Left Non-Driven", units: "kph", mult: 0.01 }),
    mrldEntry({ id: CH.wsRN, name: "Wheelspeed Right Non-Driven", units: "kph", mult: 0.01 }),
    mrldEntry({ id: CH.wsLD, name: "Wheelspeed Left Driven", units: "kph", mult: 0.01 }),
    mrldEntry({ id: CH.wsRD, name: "Wheelspeed Right Driven", units: "kph", mult: 0.01 }),
    mrldEntry({ id: CH.abs, name: "ABS Active", min: 0, max: 1, mult: 1 }),
    mrldEntry({ id: CH.tc, name: "Traction Control Active", min: 0, max: 1, mult: 1 }),
    mrldEntry({ id: CH.vsc, name: "Vehicle Stability Active", min: 0, max: 1, mult: 1 }),
    // "°C" channels hold Kelvin, with the K->C offset baked into the
    // channel's own `off` — the shape that needs an additive unit conversion.
    mrldEntry({ id: CH.oilC, name: "Oil Temp", units: "°C", min: 0, max: 255, mult: 1, off: 233.15 }),
    mrldEntry({ id: CH.oilKpa, name: "Oil Pressure", units: "kPa", min: 0, max: 255, mult: 4000 }),
    mrldEntry({ id: CH.coolantC, name: "Coolant Temp", units: "°C", min: 0, max: 255, mult: 1, off: 233.15 }),
    mrldEntry({ id: CH.transC, name: "Trans Oil Temp", units: "°C", min: 0, max: 255, mult: 1, off: 233.15 }),
    mrldEntry({ id: CH.fuelPct, name: "Fuel Level", units: "%", min: 0, max: 255, mult: 1 / 255 }),
    mrldEntry({ id: CH.battV, name: "Battery Voltage", units: "V", min: 0, max: 255, mult: 0.1 }),
    mrldEntry({ id: CH.tyreKpaLF, name: "LF Tyre Pressure", units: "kPa", min: 0, max: 255, mult: 4000 }),
    mrldEntry({ id: CH.tyreKpaRF, name: "RF Tyre Pressure", units: "kPa", min: 0, max: 255, mult: 4000 }),
    mrldEntry({ id: CH.tyreKpaLR, name: "LR Tyre Pressure", units: "kPa", min: 0, max: 255, mult: 4000 }),
    mrldEntry({ id: CH.tyreKpaRR, name: "RR Tyre Pressure", units: "kPa", min: 0, max: 255, mult: 4000 }),
    mrldEntry({ id: CH.tyreCLF, name: "LF Tyre Temp", units: "°C", min: 0, max: 255, mult: 1, off: 253.15 }),
    mrldEntry({ id: CH.tyreCRF, name: "RF Tyre Temp", units: "°C", min: 0, max: 255, mult: 1, off: 253.15 }),
    mrldEntry({ id: CH.tyreCLR, name: "LR Tyre Temp", units: "°C", min: 0, max: 255, mult: 1, off: 253.15 }),
    mrldEntry({ id: CH.tyreCRR, name: "RR Tyre Temp", units: "°C", min: 0, max: 255, mult: 1, off: 253.15 }),
    mrldEntry({ id: CH.ambientC, name: "Outside Air Temperature", units: "°C", min: 0, max: 255, mult: 1, off: 233.15 }),
    mrldEntry({ id: CH.intakeC, name: "Intake Air Temperature", units: "°C", min: 0, max: 255, mult: 1, off: 233.15 }),
    mrldEntry({ id: CH.altitude, name: "Altitude", units: "m", min: -3000000, max: 3000000, mult: 0.01 }),
    // the car's lifetime odometer: "km" holding metres
    mrldEntry({ id: CH.carOdo, name: "Distance", units: "km", min: 0, max: 2147483647, mult: 15.625 })
  );
  return buildTelemetryMp4({
    handler: "ctbx",
    sampleFormat: "marl",
    payloads,
    sampleEntryChildren: [mrld, mrlvBox()],
  });
}

// PDR file matching what full records alone show ("Marlin PDR 1.0" as seen
// before delta decoding): a single Longitude event at recording start,
// Latitude at ~2Hz, cumulative odometer at ~7Hz — no decodable GPS trace.
// Still the shape of any recording whose GPS can't be decoded, and what
// exercises the lat+odometer lap recovery. The car drives the reference
// circle (counter-clockwise, constant speed), optionally starting at
// `startAngle` so two fixtures of the same "track" can begin at different
// pit-out points. `paddock: true` produces slow, non-lapping driving instead.
export function buildPdrRealMp4({
  beaconTimes = [],
  firstCrossing = 5,
  revolutions = 3.3,
  radius = 300,
  speed = 40,
  startAngle = 0,
  lat0 = 36.56,
  lon0 = -79.2,
  paddock = false,
} = {}) {
  const events = beaconTimes.map((t, i) => pdrEvent(0x36, firstCrossing + i, t));
  const totalS = paddock ? 600 : (2 * Math.PI * radius * revolutions) / speed;
  const ky = 110540;
  events.push(pdrEvent(0x32, Math.round(lon0 * 1e7), 0.1)); // the one lon fix
  for (let t = 0.1; t <= totalS; t += 0.5) {
    const lat = paddock
      ? lat0 + (8 * Math.sin(t / 45)) / ky // wandering the paddock
      : lat0 + (radius * Math.sin(startAngle + (speed * t) / radius)) / ky;
    events.push(pdrEvent(0x31, Math.round(lat * 1e7), t));
  }
  for (let t = 0; t <= totalS; t += 0.15) {
    const d = paddock ? t * 1.2 : speed * t; // crawling vs at pace
    events.push(pdrEvent(0x42, Math.round(d), t));
  }
  return buildTelemetryMp4({ handler: "ctbx", sampleFormat: "marl", payloads: [concat(events)] });
}

// --- AliveDrive PDR 2.5 fixture (2025-on GM: Cadillac Blackwing) --------------------

// The newer Cosworth recorder: handler 'adrv', sample entry 'adco' describing
// its own channels and record schedule, and a sample stream of untagged
// fixed-layout records (see public/js/import/pdr25.js). Laid out exactly as
// the Blackwing files are, at lower rates so the committed file stays small:
// a 20 Hz group, a 10 Hz group with the GPS, a 5 Hz group and a 1 Hz group.
// Channel ids, scalings and enum tables are the real firmware's; a few
// channels the parser doesn't read ride along in each group — an s8, a u32
// enum with several fields, a reversed active/inactive enum — so a port that
// mis-sizes a field it skips misreads everything after it.
const p25str = (s) => te.encode(`${s}\0`);
const p25u16 = (v) => new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
const P25_WIDTH = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 9: 4 };
function p25stored(code, v) {
  const out = new Uint8Array(P25_WIDTH[code]);
  const dv = new DataView(out.buffer);
  if (code === 1) dv.setInt8(0, v);
  else if (code === 2) dv.setUint8(0, v);
  else if (code === 3) dv.setInt16(0, v);
  else if (code === 4) dv.setUint16(0, v);
  else if (code === 5) dv.setInt32(0, v);
  else if (code === 6) dv.setUint32(0, v);
  else dv.setFloat32(0, v);
  return out;
}
const p25f64 = (...vals) => {
  const out = new Uint8Array(vals.length * 8);
  const dv = new DataView(out.buffer);
  vals.forEach((v, i) => dv.setFloat64(i * 8, v));
  return out;
};

const P25_RAD = Math.PI / 180;
// id, name, unit, storage code, and either {mult, off, min, max} or an enum's
// fields [{name, mask, def: [label, value], labels: [[label, value]...]}].
const P25_CHANNELS = [
  { id: 0, name: "speed", unit: 4, code: 4, fmt: 9, mult: 1 / 230.4, min: 0, max: 0x7fff },
  { id: 1, name: "location.latitude", unit: 0, code: 5, fmt: 10, mult: P25_RAD * 1e-7, min: -900000000, max: 900000000 },
  { id: 2, name: "location.longitude", unit: 0, code: 5, fmt: 10, mult: P25_RAD * 1e-7, min: -1800000000, max: 1800000000 },
  { id: 3, name: "location.altitude", unit: 2, code: 5, fmt: 10, mult: 0.001, min: -0x80000000, max: 0x7fffffff },
  { id: 4, name: "location.heading", unit: 0, code: 5, fmt: 10, mult: P25_RAD * 1e-5, min: 0, max: 35999999 },
  { id: 5, name: "location.fixquality", unit: 6, code: 2, fmt: 2, mult: 1, min: 0, max: 3 },
  { id: 7, name: "stability.antilockbrakingsystem", unit: 6, code: 2,
    fields: [{ name: "status", mask: 3, def: ["unknown", 3], labels: [["inactive", 0], ["active", 1]] }] },
  { id: 11, name: "accelerometer.vehicle.x", unit: 7, code: 9, fmt: 9, mult: 9.80665, min: -8, max: 8 },
  { id: 12, name: "accelerometer.vehicle.y", unit: 7, code: 9, fmt: 9, mult: 9.80665, min: -8, max: 8 },
  { id: 14, name: "throttle.position", unit: 8, code: 2, fmt: 9, mult: 1 / 255, min: 0, max: 255 },
  { id: 15, name: "propulsion.electricmotor.powerlevel", unit: 8, code: 1, fmt: 9, mult: 0.01, min: -128, max: 127 },
  { id: 16, name: "brake.position", unit: 8, code: 2, fmt: 9, mult: 1 / 255, min: 0, max: 255 },
  { id: 17, name: "gear", unit: 6, code: 2,
    fields: [{ name: "current", mask: 15, def: ["notsupported", 0], labels: [
      ["first", 1], ["second", 2], ["third", 3], ["fourth", 4], ["fifth", 5], ["sixth", 6], ["seventh", 7],
      ["eighth", 8], ["ninth", 9], ["tenth", 10], ["unused", 11], ["cvtforward", 12], ["neutral", 13],
      ["reverse", 14], ["park", 15],
    ] }] },
  { id: 19, name: "driveperformancemode", unit: 6, code: 6,
    fields: [
      { name: "tour", mask: 1, def: ["inactive", 0], labels: [["active", 1]] },
      { name: "track", mask: 2, def: ["inactive", 0], labels: [["active", 2]] },
    ] },
  { id: 23, name: "engine.temperature.coolant", unit: 3, code: 2, fmt: 9, mult: 1, off: 233.15, min: 0, max: 255 },
  { id: 24, name: "engine.pressure.airintake.boost", unit: 5, code: 4, fmt: 5, mult: 1000, off: -110000, min: 0, max: 0x1ff },
  { id: 25, name: "engine.temperature.airintake", unit: 3, code: 2, fmt: 9, mult: 1, off: 233.15, min: 0, max: 255 },
  { id: 26, name: "engine.pressure.oil", unit: 5, code: 2, fmt: 6, mult: 4000, min: 0, max: 255 },
  { id: 27, name: "engine.temperature.oil", unit: 3, code: 2, fmt: 9, mult: 1, off: 233.15, min: 0, max: 255 },
  { id: 29, name: "enginespeed", unit: 9, code: 4, fmt: 9, mult: Math.PI / 120, min: 0, max: 0xffff },
  { id: 32, name: "temperature.outsideair", unit: 3, code: 2, fmt: 9, mult: 0.5, off: 233.15, min: 0, max: 255 },
  { id: 33, name: "stability.electronicstabilitycontrol", unit: 6, code: 2,
    fields: [{ name: "status", mask: 3, def: ["unknown", 3], labels: [["inactive", 0], ["active", 1]] }] },
  { id: 34, name: "engine.level.fuel", unit: 8, code: 2, fmt: 9, mult: 0.003921, min: 0, max: 255 },
  { id: 38, name: "odometer.distance", unit: 2, code: 6, fmt: 9, mult: 15.625, min: 0, max: 0x0fffffff },
  { id: 42, name: "steeringangle", unit: 0, code: 3, fmt: 9, mult: P25_RAD / 16, min: -0x4000, max: 0x3fff },
  { id: 43, name: "stability.tractioncontrolsystem", unit: 6, code: 2,
    fields: [{ name: "status", mask: 3, def: ["unknown", 3], labels: [["inactive", 0], ["active", 1]] }] },
  { id: 44, name: "transmission.oil.temperature", unit: 3, code: 2, fmt: 9, mult: 1, off: 233.15, min: 0, max: 255 },
  { id: 45, name: "tire.pressure.front.left", unit: 5, code: 2, fmt: 6, mult: 4000, min: 0, max: 255 },
  { id: 46, name: "tire.pressure.front.right", unit: 5, code: 2, fmt: 6, mult: 4000, min: 0, max: 255 },
  { id: 47, name: "tire.pressure.rear.left", unit: 5, code: 2, fmt: 6, mult: 4000, min: 0, max: 255 },
  { id: 48, name: "tire.pressure.rear.right", unit: 5, code: 2, fmt: 6, mult: 4000, min: 0, max: 255 },
  { id: 49, name: "tire.temperature.front.left", unit: 3, code: 2, fmt: 9, mult: 1, off: 253.15, min: 0, max: 127 },
  { id: 50, name: "tire.temperature.front.right", unit: 3, code: 2, fmt: 9, mult: 1, off: 253.15, min: 0, max: 127 },
  { id: 51, name: "tire.temperature.rear.left", unit: 3, code: 2, fmt: 9, mult: 1, off: 253.15, min: 0, max: 127 },
  { id: 52, name: "tire.temperature.rear.right", unit: 3, code: 2, fmt: 9, mult: 1, off: 253.15, min: 0, max: 127 },
  // active is 0 and inactive 1 here, the reverse of every other status
  { id: 53, name: "stability.vehiclestabilityenhancement", unit: 6, code: 2,
    fields: [{ name: "status", mask: 3, def: ["unknown", 3], labels: [["active", 0], ["inactive", 1]] }] },
  { id: 54, name: "wheel.speed.front.left", unit: 4, code: 9, fmt: 9, mult: 1, min: 0, max: 253.54 },
  { id: 55, name: "wheel.speed.front.right", unit: 4, code: 9, fmt: 9, mult: 1, min: 0, max: 253.54 },
  { id: 56, name: "wheel.speed.rear.left", unit: 4, code: 9, fmt: 9, mult: 1, min: 0, max: 253.54 },
  { id: 57, name: "wheel.speed.rear.right", unit: 4, code: 9, fmt: 9, mult: 1, min: 0, max: 253.54 },
  { id: 58, name: "gyro.vehicle.yaw", unit: 9, code: 3, fmt: 9, mult: 0.024 * P25_RAD, min: -0x1000, max: 0x0fff },
];

const P25_GROUPS = [
  { period: 500000, ids: [16, 29, 42, 58] }, // 20 Hz
  { period: 1000000, ids: [0, 1, 2, 3, 4, 5, 7, 14, 24, 15, 11, 12] }, // 10 Hz
  { period: 2000000, ids: [17, 33, 43, 54, 55, 56, 57] }, // 5 Hz
  { period: 10000000, ids: [26, 19, 23, 25, 27, 32, 34, 38, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53] }, // 1 Hz
];

const P25_EVENTS = [
  "lap.start", "lap.end", "performance.0-60mph.start", "performance.0-60mph.end",
];

function p25ChannelEntry(c) {
  const head = [p25u16(c.id), p25str(`com.cosworth.channel.${c.name}`), p25u16(c.unit)];
  if (!c.fields) {
    return concat([...head, new Uint8Array([1, c.fmt]), p25f64(c.mult, c.off ?? 0), p25stored(c.code, c.min), p25stored(c.code, c.max)]);
  }
  const parts = [...head, new Uint8Array([2, c.code, c.fields.length])];
  for (const f of c.fields) {
    parts.push(p25str(f.name), p25stored(c.code, f.mask), p25str(f.def[0]), p25stored(c.code, f.def[1]), new Uint8Array([f.labels.length]));
    for (const [label, v] of f.labels) parts.push(p25str(label), p25stored(c.code, v));
  }
  return concat(parts);
}

// Outing properties as the recorder writes them: name\0, a type, a value.
function p25Properties(stamp) {
  const prop = (name, type, value) => concat([te.encode(`com.cosworth.outingproperty.${name}\0${type}`), value]);
  return box(
    "adop",
    prop("source.tag", "strn", p25str("com.cosworth.outing.source.pdr2_5")),
    prop("timestamp", "dtim", te.encode(`${stamp}+00:00`)),
    prop("vehicle.make", "strn", p25str("Cadillac")),
    prop("stat.fastestlaptime", "siva", concat([p25u16(1), new Uint8Array([10]), p25f64(0)])),
  );
}

export function buildPdr25Mp4({
  lapCrossings = [],
  revolutions = 2.7,
  radius = 300,
  speed = 40,
  lat0 = 36.56,
  lon0 = -79.2,
  stamp = "2026-07-17T11:22:47",
} = {}) {
  const byId = new Map(P25_CHANNELS.map((c) => [c.id, c]));
  const kx = 111320 * Math.cos(lat0 * P25_RAD);
  const ky = 110540;
  const totalS = (2 * Math.PI * radius * revolutions) / speed;

  // The car on the reference circle — the same shapes buildPdrDeltaMp4 drives,
  // written as each channel's raw stored value.
  const raw = (c, t) => {
    const ang = (speed * t) / radius;
    const v = speed * (1 + 0.05 * Math.sin(t / 20)); // m/s
    const pedal = Math.sin(t / 8);
    const warm = Math.min(1, t / 120);
    switch (c.name) {
      case "speed": return Math.round(v * 230.4);
      case "location.latitude": return Math.round((lat0 + (radius * Math.sin(ang)) / ky) * 1e7);
      case "location.longitude": return Math.round((lon0 + (radius * Math.cos(ang)) / kx) * 1e7);
      case "location.altitude": return Math.round(112600 + 38000 * Math.abs(Math.sin(t / 40)));
      case "location.heading": return Math.round((((ang * 180) / Math.PI + 180) % 360) * 1e5);
      case "location.fixquality": return t < 2 ? 0 : 3; // no position for the first two seconds
      case "stability.antilockbrakingsystem": return Math.sin(t / 7) < -0.98 ? 1 : 0;
      // lateral is x, longitudinal y with braking positive (in g)
      case "accelerometer.vehicle.x": return (v * v) / radius / 9.80665;
      case "accelerometer.vehicle.y": return -0.8 * Math.sin(t / 7);
      case "throttle.position": return Math.round(Math.max(0, pedal) * 255);
      case "propulsion.electricmotor.powerlevel": return -100;
      case "brake.position": return Math.round(Math.max(0, -pedal) * 255);
      case "gear": return t % 60 < 3 ? 13 : 1 + (Math.floor(t / 7) % 5); // 13 = neutral
      case "driveperformancemode": return 2; // track
      case "engine.temperature.coolant": return Math.round(110 + 35 * warm);
      case "engine.pressure.airintake.boost": return Math.round(110 + 60 * Math.sin(t / 9));
      case "engine.temperature.airintake": return 57;
      case "engine.pressure.oil": return Math.round(70 + 14 * Math.sin(t / 11));
      case "engine.temperature.oil": return Math.round(83 + 87 * warm);
      case "enginespeed": return Math.round((4500 + 1500 * Math.sin(t / 10)) * 4);
      case "temperature.outsideair": return 110; // 288.15 K, 15 °C
      case "stability.electronicstabilitycontrol": return Math.sin(t / 5) > 0.97 ? 1 : 0;
      case "engine.level.fuel": return Math.round(248 - 61 * warm);
      case "odometer.distance": return Math.round(4549603 + (speed * t) / 15.625);
      case "steeringangle": return Math.round(30 * Math.sin(t / 6) * 16);
      case "stability.tractioncontrolsystem": return Math.sin(t / 5) > 0.99 ? 1 : 0;
      case "transmission.oil.temperature": return Math.round(59 + 79 * warm);
      case "tire.pressure.front.left": return Math.round(36 + 19 * warm);
      case "tire.pressure.front.right": return Math.round(37 + 19 * warm);
      case "tire.pressure.rear.left": return Math.round(38 + 19 * warm);
      case "tire.pressure.rear.right": return Math.round(39 + 19 * warm);
      case "tire.temperature.front.left": return Math.round(37 + 57 * warm);
      case "tire.temperature.front.right": return Math.round(38 + 57 * warm);
      case "tire.temperature.rear.left": return Math.round(39 + 57 * warm);
      case "tire.temperature.rear.right": return Math.round(40 + 57 * warm);
      case "stability.vehiclestabilityenhancement": return 1; // inactive
      case "wheel.speed.front.left":
      case "wheel.speed.front.right": return v;
      case "wheel.speed.rear.left":
      case "wheel.speed.rear.right": return v * 1.02; // rear-drive wheelspin
      case "gyro.vehicle.yaw": return Math.round(((v / radius) * 180) / Math.PI / 0.024);
      default: return 0;
    }
  };

  // Events, 100 ns ticks: lap.end before lap.start at a shared crossing, and
  // a 0-60 timer that the parser must step past.
  const events = [{ tk: Math.round(5.7e7), id: 2 }, { tk: Math.round(9.1e7), id: 3 }];
  lapCrossings.forEach((t, i) => {
    const tk = Math.round(t * 1e7);
    if (i > 0) events.push({ tk, id: 1 });
    events.push({ tk, id: 0 });
  });
  const eventBlock = (e) => {
    const out = new Uint8Array(11);
    const dv = new DataView(out.buffer);
    dv.setBigUint64(0, BigInt(e.tk));
    dv.setUint8(8, 2);
    dv.setUint16(9, e.id);
    return out;
  };
  const dataBlock = (tk, payload) => {
    const out = new Uint8Array(14 + payload.length);
    const dv = new DataView(out.buffer);
    dv.setBigUint64(0, BigInt(tk));
    dv.setUint8(8, 1);
    dv.setUint32(10, payload.length);
    out.set(payload, 14);
    return out;
  };

  // One sample per second: the data block, then the events inside that
  // second — after an empty block at 0, as the recorder opens its stream.
  const tick = Math.min(...P25_GROUPS.map((g) => g.period));
  const samples = [dataBlock(0, new Uint8Array(0))];
  for (let sec = 0; sec <= Math.floor(totalS); sec++) {
    const records = [];
    for (let k = 0; k * tick < 1e7; k++) {
      const t = sec + (k * tick) / 1e7;
      if (t > totalS) break;
      for (const g of P25_GROUPS) {
        if ((k * tick) % g.period) continue;
        for (const id of g.ids) {
          const c = byId.get(id);
          records.push(p25stored(c.code, raw(c, t)));
        }
      }
    }
    const inSecond = events.filter((e) => e.tk >= sec * 1e7 && e.tk < (sec + 1) * 1e7).map(eventBlock);
    samples.push(concat([dataBlock(sec * 1e7, concat(records)), ...inSecond]));
  }

  const adcr = box(
    "adcr",
    new Uint8Array([1]),
    p25u16(P25_GROUPS.length),
    ...P25_GROUPS.map((g) => {
      const period = new Uint8Array(8);
      new DataView(period.buffer).setBigUint64(0, BigInt(g.period));
      return concat([period, p25u16(g.ids.length), ...g.ids.map((id) => concat([p25u16(id), new Uint8Array([byId.get(id).code])]))]);
    }),
  );
  const adco = [
    box("advi", new Uint8Array([0, 5, 0, 0, 0, 2]), p25str("com.cosworth.outing.source.pdr2_5")),
    p25Properties(stamp),
    box("adcp", ...P25_CHANNELS.map(p25ChannelEntry)),
    adcr,
    box("adud", p25u16(4), p25str("com.cosworth.unit.velocity.si")),
    box("adeg", ...P25_EVENTS.map((n, i) => concat([p25u16(i), p25str(`com.cosworth.event.${n}`)]))),
  ];
  return buildTelemetryMp4({
    handler: "adrv",
    sampleFormat: "adco",
    payloads: samples,
    sampleEntryChildren: adco,
    samplesPerChunk: 4,
  });
}
