// Cosworth "AliveDrive PDR 2.5" video telemetry parser — the recorder in
// 2025-on GM performance cars (first seen on a Cadillac CT5-V Blackwing; GM
// changed the Corvette's PDR telemetry for 2026 too). Like public/pdr.js it
// reads only the MP4 index and the telemetry samples via Blob.slice, so the
// video is never read or uploaded, and it resolves to exactly the shape
// parsePdrFile does — same `kind`, same car channels in the same display
// units — so everything after the parser (channels.js, the review, the
// stored session) is unchanged.
//
// It is a different format from the Corvette's Marlin `ctbx` track, not a
// new revision of it: nothing is delta-encoded, and the file describes
// itself completely. Reverse-engineered from three Blackwing recordings
// (2026-10); every lap matched the recorder's own stored fastest lap to the
// millisecond.
//
// The telemetry track has handler 'adrv' ("AliveDrive PDR 2.5") and sample
// entry 'adco', whose child boxes are:
//   advi  header (opaque)
//   adop  outing properties: name\0 + 4cc type + value. `timestamp` (dtim) is
//         a fixed 25-character "YYYY-MM-DDTHH:MM:SS+00:00" that is LOCAL
//         wall-clock time despite the +00:00 — the recorder titles its own
//         clips "Morning Drive" / "Afternoon Drive" by the same clock.
//   adcp  channel table, one entry per channel:
//           [u16 id] com.cosworth.channel.<name>\0 [u16 unit][u8 kind][u8 fmt]
//         kind 1 (numeric): f64 mult, f64 off, then min and max in the field's
//         storage width — raw*mult+off is SI (m/s, rad, rad/s, Pa, K, m, 0-1).
//         kind 2 (enum): `fmt` is the storage code, then u8 nFields and per
//         field name\0, mask, defaultLabel\0, defaultValue, u8 count and
//         count x (label\0, value) — values and masks in the storage width.
//   adcr  record schedule: u8 version, u16 nGroups, then per group u64 period
//         (100 ns ticks), u16 n and n x [u16 channel id, u8 storage code].
//   adud  unit names, adeg  event names ([u16 id] com.cosworth.event.<name>\0).
// Storage codes: 1 s8, 2 u8, 3 s16, 4 u16, 5 s32, 6 u32, 9 f32.
//
// The samples are one stream of blocks, all big-endian:
//   [u64 ts, 100 ns][u8 type] ...
//   type 1, data:  [u8 0][u32 length] + `length` bytes of UNTAGGED records.
//     A block covers one second. At every tick of the fastest group, each
//     group whose period divides the tick's offset into the block writes one
//     record — its fields in order, groups in adcr order — so nothing in the
//     payload says which group a record belongs to: the schedule does. The
//     last block of a recording stops short.
//   type 2, event: [u16 event id] — 11 bytes. Laps are `lap.start` /
//     `lap.end` events, exact; the recorder also logs its 0-60 timers.
// A block of any other type can't be framed, so decoding stops there.
//
// Channel traps:
//   - `accelerometer.vehicle.x` is LATERAL and `vehicle.y` is LONGITUDINAL
//     with braking POSITIVE — measured, not named (r = 0.99 against
//     speed x yaw rate, r = -0.93 against dv/dt). latG = |x|, longG = -y.
//   - Enums are read by label, never by number: the stability-enhancement
//     channel numbers active as 0 and inactive as 1, the reverse of ABS.
//   - Wheel speeds are front/rear, not driven/non-driven; wheel slip is rear
//     over front, the driven axle on every car this format has been seen on.
//   - There is no battery-voltage channel, and no recording odometer — so no
//     raw latitude/odometer series for pdr-laps.js; the GPS is always there.

import { boxes, series } from "../../pdr.js";

const td = new TextDecoder("latin1");

async function bufAt(blob, offset, length) {
  const ab = await blob.slice(offset, Math.min(offset + length, blob.size)).arrayBuffer();
  return new DataView(ab);
}

const fourcc = (dv, off) => td.decode(new Uint8Array(dv.buffer, dv.byteOffset + off, 4));
const child = (dv, box, type) => boxes(dv, box.body, box.start + box.size).find((b) => b.type === type);

// Storage code -> byte width. Anything else can't be framed.
export const STORAGE_WIDTH = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 9: 4 };

export function readStored(dv, off, code) {
  switch (code) {
    case 1: return dv.getInt8(off);
    case 2: return dv.getUint8(off);
    case 3: return dv.getInt16(off);
    case 4: return dv.getUint16(off);
    case 5: return dv.getInt32(off);
    case 6: return dv.getUint32(off);
    case 9: return dv.getFloat32(off);
    default: return NaN;
  }
}

const RAD = 180 / Math.PI;
const G = 9.80665;
const K = -273.15;

// Cosworth channel name -> [the key this parser knows it by, factor, offset]:
// the SI value (raw*mult+off) times the factor plus the offset is the display
// unit parsePdrFile hands on (km/h, rpm, G, %, deg, deg/s, kPa, °C, km).
// Enum channels carry no conversion; they are read by label.
export const CHANNELS_25 = {
  "speed": ["speed", 3.6, 0],
  "location.latitude": ["latitude", RAD, 0],
  "location.longitude": ["longitude", RAD, 0],
  "location.altitude": ["altitude", 1, 0],
  "location.fixquality": ["fix", 1, 0],
  "enginespeed": ["rpm", 60 / (2 * Math.PI), 0],
  // the axis swap — see the header
  "accelerometer.vehicle.x": ["latAcc", 1 / G, 0],
  "accelerometer.vehicle.y": ["longAcc", -1 / G, 0],
  "throttle.position": ["throttle", 100, 0],
  "brake.position": ["brake", 100, 0],
  "steeringangle": ["steering", RAD, 0],
  "gyro.vehicle.yaw": ["yaw", RAD, 0],
  "gear": ["gear", 1, 0],
  "engine.pressure.airintake.boost": ["boost", 0.001, 0],
  "wheel.speed.front.left": ["wsFL", 3.6, 0],
  "wheel.speed.front.right": ["wsFR", 3.6, 0],
  "wheel.speed.rear.left": ["wsRL", 3.6, 0],
  "wheel.speed.rear.right": ["wsRR", 3.6, 0],
  "stability.antilockbrakingsystem": ["absActive", 1, 0],
  "stability.tractioncontrolsystem": ["tcActive", 1, 0],
  "stability.electronicstabilitycontrol": ["vscActive", 1, 0],
  "engine.temperature.oil": ["oilC", 1, K],
  "engine.pressure.oil": ["oilKpa", 0.001, 0],
  "engine.temperature.coolant": ["coolantC", 1, K],
  "transmission.oil.temperature": ["transC", 1, K],
  "engine.level.fuel": ["fuelPct", 100, 0],
  "tire.pressure.front.left": ["tyreKpaLF", 0.001, 0],
  "tire.pressure.front.right": ["tyreKpaRF", 0.001, 0],
  "tire.pressure.rear.left": ["tyreKpaLR", 0.001, 0],
  "tire.pressure.rear.right": ["tyreKpaRR", 0.001, 0],
  "tire.temperature.front.left": ["tyreCLF", 1, K],
  "tire.temperature.front.right": ["tyreCRF", 1, K],
  "tire.temperature.rear.left": ["tyreCLR", 1, K],
  "tire.temperature.rear.right": ["tyreCRR", 1, K],
  "temperature.outsideair": ["ambientC", 1, K],
  "engine.temperature.airintake": ["intakeC", 1, K],
  "odometer.distance": ["carOdo", 0.001, 0], // the car's lifetime odometer
};

// The per-lap scalars, in public/pdr.js's SCALAR_CHANNEL_KEYS order. Battery
// voltage is among them there and absent here.
const SCALAR_KEYS = [
  "oilC", "oilKpa", "coolantC", "transC", "fuelPct", "battV",
  "tyreKpaLF", "tyreKpaRF", "tyreKpaLR", "tyreKpaRR",
  "tyreCLF", "tyreCRF", "tyreCLR", "tyreCRR",
];

const GEAR_LABELS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

const CHANNEL_PREFIX = "com.cosworth.channel.";
const EVENT_PREFIX = "com.cosworth.event.";
const MAX_TICKS = 864000000000; // 24h in 100 ns units: anything above is corrupt

// A NUL-terminated latin-1 string at `p`, and where the byte after its NUL is.
function cstr(dv, p, end) {
  let e = p;
  while (e < end && dv.getUint8(e) !== 0) e++;
  return { s: td.decode(new Uint8Array(dv.buffer, dv.byteOffset + p, e - p)), next: e + 1 };
}

// The channel table. Entries can't be walked end to end without every enum's
// grammar, so this finds each one by its name instead — the id sits in the two
// bytes before it — and reads only what follows. Exported for unit tests.
export function parseChannelTable(dv, start, end) {
  const out = new Map(); // id -> {name, kind, mult, off, labels}
  const text = td.decode(new Uint8Array(dv.buffer, dv.byteOffset + start, end - start));
  let i = text.indexOf(CHANNEL_PREFIX);
  while (i >= 0) {
    const at = start + i;
    const { s, next: p } = cstr(dv, at, end);
    if (at - 2 >= start && p + 4 <= end) {
      const id = dv.getUint16(at - 2);
      const kind = dv.getUint8(p + 2);
      const fmt = dv.getUint8(p + 3);
      const ch = { name: s.slice(CHANNEL_PREFIX.length), kind, mult: 1, off: 0, labels: null };
      if (kind === 1 && p + 20 <= end) {
        ch.mult = dv.getFloat64(p + 4);
        ch.off = dv.getFloat64(p + 12);
      } else if (kind === 2) {
        ch.labels = enumLabels(dv, p + 4, end, fmt);
      }
      out.set(id, ch);
    }
    i = text.indexOf(CHANNEL_PREFIX, i + CHANNEL_PREFIX.length);
  }
  return out;
}

// The first field of an enum entry as {label: value}, default label included;
// null when its storage width is unknown or the entry runs out.
function enumLabels(dv, p, end, code) {
  const w = STORAGE_WIDTH[code];
  if (!w || p + 1 > end) return null;
  const labels = {};
  p += 1; // nFields: every enum this reads has one
  p = cstr(dv, p, end).next; // the field's name
  p += w; // its mask
  const def = cstr(dv, p, end);
  p = def.next;
  if (p + w + 1 > end) return null;
  labels[def.s] = readStored(dv, p, code);
  p += w;
  const count = dv.getUint8(p);
  p += 1;
  for (let k = 0; k < count; k++) {
    const l = cstr(dv, p, end);
    p = l.next;
    if (p + w > end) return null;
    labels[l.s] = readStored(dv, p, code);
    p += w;
  }
  return labels;
}

// The record schedule. Exported for unit tests.
export function parseSchedule(dv, start, end) {
  const groups = [];
  let p = start + 1; // version
  if (p + 2 > end) return groups;
  const n = dv.getUint16(p);
  p += 2;
  for (let g = 0; g < n && p + 10 <= end; g++) {
    const period = dv.getUint32(p) * 4294967296 + dv.getUint32(p + 4);
    const count = dv.getUint16(p + 8);
    p += 10;
    const fields = [];
    let bytes = 0;
    for (let k = 0; k < count && p + 3 <= end; k++) {
      const code = dv.getUint8(p + 2);
      fields.push({ id: dv.getUint16(p), code });
      bytes += STORAGE_WIDTH[code] ?? NaN;
      p += 3;
    }
    groups.push({ period, fields, bytes });
  }
  return groups;
}

function parseEvents(dv, start, end) {
  const out = new Map();
  let p = start;
  while (p + 2 < end) {
    const id = dv.getUint16(p);
    const { s, next } = cstr(dv, p + 2, end);
    if (s.startsWith(EVENT_PREFIX)) out.set(id, s.slice(EVENT_PREFIX.length));
    p = next;
  }
  return out;
}

export async function parsePdr25File(fileBlob) {
  // 1. Locate moov among top-level boxes (usually at file end).
  let pos = 0, moovLoc = null;
  while (pos + 16 <= fileBlob.size) {
    const hdr = await bufAt(fileBlob, pos, 16);
    let size = hdr.getUint32(0);
    const type = fourcc(hdr, 4);
    if (size === 1) size = Number(hdr.getBigUint64(8));
    if (size === 0) size = fileBlob.size - pos;
    if (size < 8) throw new Error("Not a valid MP4 file");
    if (type === "moov") { moovLoc = { pos, size }; break; }
    pos += size;
  }
  if (!moovLoc) throw new Error("No moov box found — is this an MP4?");
  const moov = await bufAt(fileBlob, moovLoc.pos, moovLoc.size);

  // 2. Find the telemetry track (handler 'adrv').
  let stbl = null;
  for (const trak of boxes(moov, 8, moovLoc.size).filter((b) => b.type === "trak")) {
    const mdia = child(moov, trak, "mdia");
    if (!mdia) continue;
    const hdlr = child(moov, mdia, "hdlr");
    if (!hdlr || fourcc(moov, hdlr.body + 8) !== "adrv") continue;
    const minf = child(moov, mdia, "minf");
    stbl = minf && child(moov, minf, "stbl");
  }
  if (!stbl) throw new Error("No PDR 2.5 telemetry track in this video");

  const stco = child(moov, stbl, "stco") || child(moov, stbl, "co64");
  const stsz = child(moov, stbl, "stsz");
  const stsc = child(moov, stbl, "stsc");
  const stsd = child(moov, stbl, "stsd");
  if (!stco || !stsz || !stsc || !stsd) throw new Error("Telemetry track is missing sample tables");

  // 3. The self-description inside the 'adco' sample entry.
  const entry = boxes(moov, stsd.body + 8, stsd.start + stsd.size)[0];
  const parts = entry ? boxes(moov, entry.body + 8, entry.start + entry.size) : [];
  const part = (type) => parts.find((b) => b.type === type);
  const adop = part("adop"), adcp = part("adcp"), adcr = part("adcr"), adeg = part("adeg");
  if (!adcp || !adcr) throw new Error("PDR 2.5 telemetry is missing its channel table");
  const chans = parseChannelTable(moov, adcp.body, adcp.start + adcp.size);
  const groups = parseSchedule(moov, adcr.body, adcr.start + adcr.size).filter((g) => g.fields.length);
  if (!groups.length || groups.some((g) => !Number.isFinite(g.bytes) || !(g.period > 0))) {
    throw new Error("This PDR 2.5 recording uses a record layout this importer can't read");
  }
  const eventNames = adeg ? parseEvents(moov, adeg.body, adeg.start + adeg.size) : new Map();

  let date = null, time = null;
  if (adop) {
    const raw = td.decode(new Uint8Array(moov.buffer, moov.byteOffset + adop.body, adop.size - 8));
    const m = /outingproperty\.timestamp\0dtim(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(raw);
    if (m) [date, time] = [m[1], m[2]];
  }

  // 4. Decode the samples. One bucket per channel this parser reads, in
  // display units; every other field is stepped over by its width.
  const pts = {};
  const sinks = new Map(); // channel id -> {arr, f, add, mult, off}
  for (const [id, ch] of chans) {
    const spec = CHANNELS_25[ch.name];
    if (!spec) continue;
    const [key, f, add] = spec;
    sinks.set(id, { arr: (pts[key] = []), f, add, mult: ch.mult, off: ch.off });
  }
  const tick = Math.min(...groups.map((g) => g.period));
  const events = [];
  let lastT = 0;

  // Chunks hold whole samples and samples hold whole blocks, but nothing
  // promises a block never straddles a sample, so the stream is read whole.
  const is64 = stco.type === "co64";
  const nChunks = moov.getUint32(stco.body + 4);
  const fixedSize = moov.getUint32(stsz.body + 4);
  const nSamples = moov.getUint32(stsz.body + 8);
  const sizeAt = (i) => (fixedSize ? fixedSize : moov.getUint32(stsz.body + 12 + i * 4));
  const nRuns = moov.getUint32(stsc.body + 4);
  const runFirst = (r) => moov.getUint32(stsc.body + 8 + r * 12); // 1-based chunk
  const runPer = (r) => moov.getUint32(stsc.body + 12 + r * 12);
  const pieces = [];
  let sample = 0, total = 0;
  for (let c = 0, r = 0; c < nChunks && sample < nSamples; c++) {
    while (r + 1 < nRuns && runFirst(r + 1) <= c + 1) r++;
    const off = is64 ? Number(moov.getBigUint64(stco.body + 8 + c * 8)) : moov.getUint32(stco.body + 8 + c * 4);
    let len = 0;
    for (let k = 0; k < runPer(r) && sample < nSamples; k++) len += sizeAt(sample++);
    const piece = new Uint8Array((await bufAt(fileBlob, off, len)).buffer);
    pieces.push(piece);
    total += piece.length;
  }
  const bytes = new Uint8Array(total);
  for (let i = 0, w = 0; i < pieces.length; w += pieces[i].length, i++) bytes.set(pieces[i], w);
  const s = new DataView(bytes.buffer);

  let q = 0;
  while (q + 9 <= s.byteLength) {
    const ts = s.getUint32(q) * 4294967296 + s.getUint32(q + 4);
    const type = s.getUint8(q + 8);
    if (type === 2) {
      if (q + 11 > s.byteLength) break;
      const name = eventNames.get(s.getUint16(q + 9));
      if (ts <= MAX_TICKS && name) events.push({ t: ts / 1e7, name });
      q += 11;
      continue;
    }
    if (type !== 1 || q + 14 > s.byteLength) break; // a block that can't be framed
    const end = Math.min(q + 14 + s.getUint32(q + 10), s.byteLength);
    let p = q + 14;
    if (ts <= MAX_TICKS) {
      for (let k = 0; p < end; k++) {
        const at = k * tick;
        for (const g of groups) {
          if (at % g.period) continue;
          if (p + g.bytes > end) { p = end; break; }
          const t = (ts + at) / 1e7;
          for (const fl of g.fields) {
            const sink = sinks.get(fl.id);
            if (sink) {
              const raw = readStored(s, p, fl.code);
              sink.arr.push({ t, v: (raw * sink.mult + sink.off) * sink.f + sink.add });
            }
            p += STORAGE_WIDTH[fl.code];
          }
          if (t > lastT) lastT = t;
        }
      }
    }
    q = end;
  }
  for (const e of events) if (e.t > lastT) lastT = e.t;

  const got = (key) => pts[key] ?? [];
  const labelsOf = (key) => {
    for (const ch of chans.values()) if (CHANNELS_25[ch.name]?.[0] === key) return ch.labels;
    return null;
  };

  // Scale and derive the car channels, exactly as public/pdr.js does.
  const speed = got("speed"); // km/h
  const rpm = got("rpm");
  const latAcc = got("latAcc"); // G
  const throttle = got("throttle"); // %
  const brake = got("brake"); // %
  const longAcc = got("longAcc"); // G, signed: negative under braking
  const yaw = got("yaw"); // deg/s, signed
  const boost = got("boost"); // kPa gauge
  const steering = got("steering"); // deg, signed

  // Gear by label: first..tenth are gears, anything else (neutral, park,
  // "notsupported", a CVT) is stored as 0, the no-gear state.
  const gearLabels = labelsOf("gear");
  const gearOf = new Map();
  if (gearLabels) GEAR_LABELS.forEach((l, i) => { if (l in gearLabels) gearOf.set(gearLabels[l], i + 1); });
  const gear = gearOf.size ? got("gear").map((p) => ({ t: p.t, v: gearOf.get(p.v) ?? 0 })) : [];

  // Wheel slip, rear over front, as one channel — the formula public/pdr.js
  // uses for driven over non-driven.
  const wheel = ["wsFL", "wsFR", "wsRL", "wsRR"].map(got);
  const wheelSlip =
    wheel.every((w) => w.length > 10)
      ? (() => {
          const [fl, fr, rl, rr] = wheel.map(series);
          return wheel[0].map((p) => {
            const nd = (fl.at(p.t) + fr.at(p.t)) / 2;
            const dr = (rl.at(p.t) + rr.at(p.t)) / 2;
            const v = nd < 5 ? 0 : ((dr - nd) / nd) * 100;
            return { t: p.t, v: Math.max(-100, Math.min(100, v)) };
          });
        })()
      : [];

  // ABS / traction control / stability control as public/pdr.js packs them,
  // each 1 while its enum reads "active".
  const active = (key) => {
    const v = labelsOf(key)?.active;
    return v === undefined ? [] : got(key).map((p) => ({ t: p.t, v: p.v === v ? 1 : 0 }));
  };
  const absPts = active("absActive");
  const tcS = active("tcActive"), vscS = active("vscActive");
  const flags = absPts.length > 10
    ? (() => {
        const tc = tcS.length > 10 ? series(tcS) : null;
        const vsc = vscS.length > 10 ? series(vscS) : null;
        return absPts.map((p) => ({
          t: p.t,
          v: (p.v > 0.5 ? 1 : 0) | (tc && tc.at(p.t) > 0.5 ? 2 : 0) | (vsc && vsc.at(p.t) > 0.5 ? 4 : 0),
        }));
      })()
    : [];

  const lapScalarChannels = {};
  for (const key of SCALAR_KEYS) lapScalarChannels[key] = got(key).length ? got(key) : null;

  const maxOf = (arr, cap) => {
    let m = -Infinity;
    for (const p of arr) if (p.v > m) m = p.v;
    return m > 0 && m < cap ? m : null;
  };
  const absSeries = (arr) => arr.map((p) => ({ t: p.t, v: Math.abs(p.v) }));
  const metrics = {
    topSpeedKph: maxOf(speed, 500),
    maxRpm: maxOf(rpm, 20000),
    maxLatG: maxOf(absSeries(latAcc), 5),
    maxBrakeG: maxOf(longAcc.map((p) => ({ t: p.t, v: -p.v })), 5),
    maxBoostKpa: maxOf(boost, 400),
    maxOilC: maxOf(got("oilC"), 250),
  };

  // GPS: latitude, longitude, altitude, fix quality and speed share one
  // record group, so the samples line up by index; fixes without a position
  // (quality 0, or exactly 0,0) are dropped.
  const lat = got("latitude"), lon = got("longitude"), alt = got("altitude"), fix = got("fix");
  const gps = [];
  const fixedAlt = [];
  for (let i = 0; i < lat.length; i++) {
    const t = lat[i].t;
    if (lon[i]?.t !== t || fix[i]?.t !== t || !(fix[i].v > 0)) continue;
    const la = lat[i].v, lo = lon[i].v;
    if (!(Math.abs(la) <= 90 && Math.abs(lo) <= 180) || (la === 0 && lo === 0)) continue;
    const pt = { t, lat: la, lon: lo };
    if (speed[i]?.t === t) pt.v = speed[i].v / 3.6;
    gps.push(pt);
    if (alt[i]?.t === t) fixedAlt.push(alt[i]);
  }

  const median = (arr) => {
    if (arr.length < 3) return null;
    const v = arr.map((p) => p.v).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const carOdo = got("carOdo");
  const sessionMeta = {
    ambientC: median(got("ambientC")),
    intakeC: median(got("intakeC")),
    elevationM:
      fixedAlt.length > 10
        ? Math.max(...fixedAlt.map((p) => p.v)) - Math.min(...fixedAlt.map((p) => p.v))
        : null,
    odometerKm: carOdo.length ? Math.max(...carOdo.map((p) => p.v)) : null,
  };

  // 5. Laps between a lap.start and the next lap.end. At a crossing the
  // recorder writes both at one timestamp; ends sort first so the closing lap
  // isn't read as a zero-length one. A start with no end (the in-lap) is not
  // a lap.
  const order = (n) => (n === "lap.end" ? 0 : 1);
  const lapEvents = events
    .filter((e) => e.name === "lap.start" || e.name === "lap.end")
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => a.t - b.t || order(a.name) - order(b.name) || a.i - b.i);
  const laps = [];
  let open = null;
  for (const e of lapEvents) {
    if (e.name === "lap.end") {
      if (open !== null && e.t > open) {
        laps.push({ lapNumber: laps.length + 1, timeMs: Math.round((e.t - open) * 1000), estimated: false, startT: open, endT: e.t });
      }
      open = null;
    } else {
      open = e.t;
    }
  }

  const dense = (arr) => (arr.length > 10 ? arr : null);

  return {
    date,
    time,
    durationS: lastT,
    beaconCount: new Set(lapEvents.map((e) => e.t)).size,
    laps,
    gps: gps.length > 10 ? gps : null,
    metrics,
    sessionMeta,
    channels: null, // no recording odometer, so nothing for pdr-laps.js
    lapScalarChannels,
    carChannels: {
      speed: dense(speed),
      rpm: dense(rpm),
      latG: dense(absSeries(latAcc)),
      throttle: dense(throttle),
      brake: dense(brake),
      steering: dense(steering),
      longG: dense(longAcc),
      yaw: dense(yaw),
      gear: dense(gear),
      wheelSlip: dense(wheelSlip),
      boost: dense(boost),
      flags: dense(flags),
    },
  };
}
