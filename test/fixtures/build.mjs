// Synthetic telemetry fixtures for tests: a circular GPS trace and minimal
// but structurally-valid VBO, FIT, GoPro-GPMF MP4 and Corvette-PDR MP4 files
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

export function buildVboText(points, { withLapTiming = false, startTod = "091500.00" } = {}) {
  const todBase =
    Number(startTod.slice(0, 2)) * 3600 + Number(startTod.slice(2, 4)) * 60 + Number(startTod.slice(4));
  const rows = points.map((p) => {
    const tod = todBase + p.t;
    const h = String(Math.floor(tod / 3600)).padStart(2, "0");
    const m = String(Math.floor((tod % 3600) / 60)).padStart(2, "0");
    const s = (tod % 60).toFixed(2).padStart(5, "0");
    return `008 ${h}${m}${s} ${vboLat(p.lat)} ${vboLon(p.lon)} ${(p.v * 3.6).toFixed(3)}`;
  });
  let lapTiming = "";
  if (withLapTiming) {
    const a = circlePointAt(0.25, { radialOffset: -20 });
    const b = circlePointAt(0.25, { radialOffset: 20 });
    lapTiming = `\n[laptiming]\nStart ${vboLat(a.lat)} ${vboLon(a.lon)} ${vboLat(b.lat)} ${vboLon(b.lon)}\n`;
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

// --- FIT -----------------------------------------------------------------------

const FIT_EPOCH_S = 631065600;

function fitFile(records) {
  const body = concat(records);
  const out = new Uint8Array(14 + body.length + 2);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, 14); // header size
  dv.setUint8(1, 0x20); // protocol version
  dv.setUint16(2, 2100, true); // profile version
  dv.setUint32(4, body.length, true);
  out.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
  out.set(body, 14);
  return out; // trailing CRC left as 0 (parsers that read-only don't validate)
}

function fitDef(local, global, fields) {
  const out = new Uint8Array(6 + fields.length * 3);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, 0x40 | local);
  dv.setUint8(2, 0); // little-endian
  dv.setUint16(3, global, true);
  dv.setUint8(5, fields.length);
  fields.forEach(([num, size, baseType], i) => {
    dv.setUint8(6 + i * 3, num);
    dv.setUint8(7 + i * 3, size);
    dv.setUint8(8 + i * 3, baseType);
  });
  return out;
}

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

// A FIT session with explicit lap messages (the Garmin Catalyst shape).
export function buildFitLaps({ lapMs = [47120, 46800, 47500], startUnix = Date.UTC(2026, 5, 20, 13, 15, 0) / 1000 } = {}) {
  const startFit = startUnix - FIT_EPOCH_S;
  const recs = [fitDef(0, 19, [[2, 4, 0x86], [7, 4, 0x86], [253, 4, 0x86]])];
  let t = startFit;
  for (const ms of lapMs) {
    const d = new Uint8Array(13);
    const dv = new DataView(d.buffer);
    dv.setUint8(0, 0x00);
    dv.setUint32(1, t, true); // start_time
    dv.setUint32(5, ms, true); // total_elapsed_time (/1000 s)
    dv.setUint32(9, Math.round(t + ms / 1000), true); // timestamp
    t += Math.round(ms / 1000);
    recs.push(d);
  }
  return fitFile(recs);
}

// A FIT file with only GPS record messages (no laps) -> needs line picking.
export function buildFitRecords(points, { startUnix = Date.UTC(2026, 5, 20, 13, 15, 0) / 1000 } = {}) {
  const startFit = startUnix - FIT_EPOCH_S;
  const SEMI = 2 ** 31 / 180;
  const recs = [fitDef(0, 20, [[0, 4, 0x85], [1, 4, 0x85], [6, 2, 0x84], [253, 4, 0x86]])];
  for (const p of points) {
    const d = new Uint8Array(15);
    const dv = new DataView(d.buffer);
    dv.setUint8(0, 0x00);
    dv.setInt32(1, Math.round(p.lat * SEMI), true);
    dv.setInt32(5, Math.round(p.lon * SEMI), true);
    dv.setUint16(9, Math.round((p.v ?? 0) * 1000), true);
    dv.setUint32(11, startFit + Math.round(p.t), true);
    recs.push(d);
  }
  return fitFile(recs);
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
function buildTelemetryMp4({ handler, sampleFormat, payloads, timescale = 1000, sampleDelta = 1000, sampleEntryChildren = [] }) {
  const ftyp = box("ftyp", te.encode("mp42"), u32(0));
  const mdatBody = concat(payloads);
  const mdat = box("mdat", mdatBody);

  const offsets = [];
  let off = ftyp.length + 8; // mdat body starts after its own header
  for (const p of payloads) {
    offsets.push(off);
    off += p.length;
  }

  const sampleEntry = sampleEntryChildren.length
    ? box(sampleFormat, new Uint8Array(8), ...sampleEntryChildren)
    : box(sampleFormat);
  const n = payloads.length;
  const stbl = box(
    "stbl",
    box("stsd", u32(0, 1), sampleEntry),
    box("stts", u32(0, 1, n, sampleDelta)),
    box("stsc", u32(0, 1, 1, 1, 1)),
    box("stsz", u32(0, 0, n, ...payloads.map((p) => p.length))),
    box("stco", u32(0, n, ...offsets))
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
  const CH = { speed: 40, rpm: 41, latAcc: 42, lat: 49, lon: 50, beacon: 54, odo: 66 };
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
    mrldEntry({ id: CH.lat, name: "Latitude", units: "°", mult: 1e-9, min: -1571000000, max: 1571000000 }),
    mrldEntry({ id: CH.lon, name: "Longitude", units: "°", mult: 1e-9, min: -2000000000, max: 2000000000 }),
    mrldEntry({ id: CH.beacon, name: "Beacon" }),
    mrldEntry({ id: CH.odo, name: "Recording Event Odometer", units: "km" })
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
