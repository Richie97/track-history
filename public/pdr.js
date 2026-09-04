// Corvette PDR (Cosworth "Marlin PDR") video telemetry parser.
//
// PDR MP4s carry a third track (handler 'ctbx', sample format 'marl') holding
// telemetry. This parser reads only the MP4 index and the ~5MB of telemetry
// samples via Blob.slice — the video itself is never read or uploaded.
//
// Lap extraction (reverse-engineered and validated against Cosworth Toolbox
// lap times from real sessions):
//   - "Beacon" events mark start/finish crossings with millisecond-exact
//     timestamps and an absolute crossing number — but the recorder drops some.
//   - "Recording Event Odometer" is cumulative distance (meters, ~7Hz).
//     Beacon-to-beacon distance / crossing count = lap length, so missing
//     crossings are recovered at the time distance passes D0 + k*lapLength
//     (validated accuracy: ~50-150ms; flagged `estimated`).
//   - Crossings before the first / after the last beacon are extrapolated by
//     distance and accepted only if GPS latitude matches the beacon-calibrated
//     start/finish latitude.
//
// Record framing inside a telemetry sample (this matches ExifTool's GM.pm,
// the reference decoder for the Marlin format — see
// https://exiftool.org/forum/index.php?topic=11335):
//   - 16-byte full record:  hi 2 bits of first byte = 11 (hi byte 0xff ends
//     the sample): [flags:u4|chan:u28][value:s32][ts:u64 100ns]
//   - 8-byte delta record:  hi 2 bits = 01:
//     [chanDiff:s6][valueDiff:s24][tsDiff:u32 100ns]
//     applied to the running channel/value/timestamp state, which persists
//     across samples. Any other record is skipped 8 bytes at a time.
// Most of the stream is delta records: a channel gets one full record and then
// streams diffs. (An earlier version of this parser read only full records,
// which made it look like GPS wasn't recorded — longitude gets exactly one
// full record at recording start, with everything after arriving as deltas.
// Decoding deltas yields ~11Hz lat/lon plus Speed, RPM, accelerations, etc.)
//
// Channel definitions live in the 'mrld' table (448-byte entries: id u32 at
// +0, units chars at +12, min/max s32 at +88/+92, multiplier/offset f64 at
// +112/+120, name chars at +128). raw*multiplier+offset gives SI units
// (radians for lat/lon, m/s for speed); a per-unit factor converts to display
// units. Session local date/time is in 'mrlv'.
//
// The raw latitude/odometer channels are returned so recordings whose GPS
// can't be decoded can still have laps recovered from lat-vs-distance
// periodicity (js/import/pdr-laps.js).

const td = new TextDecoder("latin1");

async function bufAt(blob, offset, length) {
  const ab = await blob.slice(offset, Math.min(offset + length, blob.size)).arrayBuffer();
  return new DataView(ab);
}

const fourcc = (dv, off) => td.decode(new Uint8Array(dv.buffer, dv.byteOffset + off, 4));

// Exported for unit tests.
export function boxes(dv, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = fourcc(dv, p + 4);
    let hdr = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(p + 8));
      hdr = 16;
    }
    if (size === 0) size = end - p;
    if (size < 8 || p + size > end || !/^[\x20-\x7e]{4}$/.test(type)) break;
    out.push({ type, start: p, body: p + hdr, size });
    p += size;
  }
  return out;
}

const child = (dv, box, type) => boxes(dv, box.body, box.start + box.size).find((b) => b.type === type);

// Decode raw Latitude/Longitude channel samples ({t, v: s32}) into a GPS trace
// in decimal degrees. When the file's channel dictionary supplies lat/lon
// multipliers, that conversion (radians -> degrees) is tried first; then the
// heuristics — degrees * 1e7 in the s32, or IEEE float degrees in the same 4
// bytes. Every interpretation is accepted only when the result actually looks
// like a car on a track (coordinates in range, extent between ~1 m and ~1
// degree). Returns [{t, lat, lon, v?}] or null; never garbage.
// `speedS` (optional Speed-channel series, m/s) or `odo` (optional odometer
// series) supplies speed in m/s for the racing line.
// Exported for unit tests.
export function gpsFromChannels(latPts, lonPts, odo = null, { dictConv = null, speedS = null } = {}) {
  if (latPts.length < 10 || lonPts.length < 10) return null;

  const f32 = new DataView(new ArrayBuffer(4));
  const shared = [
    (v) => v / 1e7,
    (v) => {
      f32.setInt32(0, v);
      return f32.getFloat32(0);
    },
  ];
  // Lat and lon must decode under the same interpretation — a device doesn't
  // mix encodings, and float bits of one channel can masquerade as plausible
  // scaled integers of the other. The dictionary conversion counts as one
  // interpretation (each channel has its own multiplier).
  const decoders = shared.map((conv) => ({ lat: conv, lon: conv }));
  if (dictConv) decoders.unshift(dictConv);

  const decode = (pts, conv, limit) => {
    let min = Infinity, max = -Infinity;
    const out = pts.map((p) => {
      const deg = conv(p.v);
      if (deg < min) min = deg;
      if (deg > max) max = deg;
      return { t: p.t, v: deg };
    });
    const span = max - min;
    if (!Number.isFinite(span) || Math.max(Math.abs(min), Math.abs(max)) > limit) return null;
    return span > 1e-5 && span < 1 ? out : null;
  };

  for (const conv of decoders) {
    const lat = decode(latPts, conv.lat, 90);
    const lon = decode(lonPts, conv.lon, 180);
    if (!lat || !lon) continue;
    const lonS = series(lon);
    const t0 = Math.max(lat[0].t, lon[0].t);
    const t1 = Math.min(lat[lat.length - 1].t, lon[lon.length - 1].t);
    const gps = lat
      .filter((p) => p.t >= t0 && p.t <= t1)
      .map((p) => ({
        t: p.t,
        lat: p.v,
        lon: lonS.at(p.t),
        v: speedS ? Math.max(0, speedS.at(p.t)) : odo ? Math.max(0, odo.rate(p.t)) : undefined,
      }));
    return gps.length >= 10 ? gps : null;
  }
  return null;
}

// Conversions from the SI value (raw * multiplier + offset) to the unit named
// in the channel dictionary, as [factor, offset] — mirrors ExifTool GM.pm's
// conversions for the units this app surfaces (lat/lon in radians -> degrees,
// m/s -> km/h, m/s² -> G, and Cosworth's factor-of-10 rpm).
//
// Three of these are units the dictionary *labels* in display terms while
// storing SI, and getting them wrong is silent rather than obvious:
//   - "°C" channels are Kelvin (the channel's own `off` carries 233.15/253.15),
//     so the conversion is additive — which is why this table holds an offset
//     and not just a factor. Ship a temperature without it and 130°C oil
//     reports as 403°C.
//   - "kPa" channels hold Pascals.
//   - "km" channels hold metres. Note the odometer is deliberately *not* run
//     through this table: `odoPts` stays raw because it is the driven-distance
//     axis (js/import/channels.js), not a displayed value.
const UNIT_CONV = {
  "deg": [180 / Math.PI, 0],
  "deg/sec": [180 / Math.PI, 0],
  "kph": [3.6, 0],
  "G": [1 / 9.80665, 0],
  "rpm": [10, 0],
  "%": [100, 0],
  "degC": [1, -273.15],
  "kPa": [0.001, 0],
  "km": [0.001, 0],
};
const normUnits = (u) =>
  u === "°" ? "deg" : u === "°/sec" ? "deg/sec" : u === "°C" ? "degC" : u;

// Channel-dictionary name -> the key this parser knows it by. Every entry
// here becomes a `tags.<key>` id and a raw sample bucket; what happens to the
// bucket afterwards is decided below (gridded trace, per-lap scalar, or a
// session-level number). The names are the strings real firmware writes into
// the 'mrld' table — a file that spells one differently simply yields no
// samples for it, which every consumer already treats as "the file lacks it".
//
// Channels deliberately left out: the recorder's own CPU/disk housekeeping,
// values that are constant across a session (Corner Exit Setting, Engine Speed
// Request, GPS Fix), Boost Pressure Ind (redundant with Intake Boost
// Pressure), Vertical Acceleration, Heading (derivable from the trace),
// Engine Torque Req (a request, not measured output), and the four suspension
// displacements plus Clutch Pos, which are real data whose scaling needs a
// second car to validate before it is worth storing.
const CHANNEL_TAGS = {
  "Beacon": "beacon",
  "Recording Event Odometer": "odometer",
  "Latitude": "latitude",
  "Longitude": "longitude",
  // gridded traces
  "Speed": "speed",
  "RPM": "rpm",
  "Lateral Acceleration": "latAcc",
  "Accel Pos": "throttle",
  "Brake Pos": "brake",
  "Steering Angle": "steering",
  "Longitudinal Acceleration": "longAcc",
  "Yaw Rate": "yaw",
  "Gear": "gear",
  "Intake Boost Pressure": "boost",
  "Wheelspeed Left Non-Driven": "wsLN",
  "Wheelspeed Right Non-Driven": "wsRN",
  "Wheelspeed Left Driven": "wsLD",
  "Wheelspeed Right Driven": "wsRD",
  "ABS Active": "absActive",
  "Traction Control Active": "tcActive",
  "Vehicle Stability Active": "vscActive",
  // per-lap scalars
  "Oil Temp": "oilC",
  "Oil Pressure": "oilKpa",
  "Coolant Temp": "coolantC",
  "Trans Oil Temp": "transC",
  "Fuel Level": "fuelPct",
  "Battery Voltage": "battV",
  "LF Tyre Pressure": "tyreKpaLF",
  "RF Tyre Pressure": "tyreKpaRF",
  "LR Tyre Pressure": "tyreKpaLR",
  "RR Tyre Pressure": "tyreKpaRR",
  "LF Tyre Temp": "tyreCLF",
  "RF Tyre Temp": "tyreCRF",
  "LR Tyre Temp": "tyreCLR",
  "RR Tyre Temp": "tyreCRR",
  // session-level
  "Outside Air Temperature": "ambientC",
  "Intake Air Temperature": "intakeC",
  "Altitude": "altitude",
  "Distance": "carOdo", // the car's lifetime odometer, not the recording's
};

// The CHANNEL_TAGS keys that become one value per lap rather than a trace.
// The reduction (max / min / value at lap end) belongs to the lap window, so
// it lives in js/import/channels.js — this parser only hands over the series.
export const SCALAR_CHANNEL_KEYS = [
  "oilC",
  "oilKpa",
  "coolantC",
  "transC",
  "fuelPct",
  "battV",
  "tyreKpaLF",
  "tyreKpaRF",
  "tyreKpaLR",
  "tyreKpaRR",
  "tyreCLF",
  "tyreCRF",
  "tyreCLR",
  "tyreCRR",
];

// Interpolating accessor over a sorted [{t, v}] series. Exported for unit tests.
export function series(arr) {
  const idx = (key, get) => {
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      get(arr[m]) < key ? (lo = m + 1) : (hi = m);
    }
    return Math.max(1, lo);
  };
  return {
    n: arr.length,
    first: arr[0],
    last: arr[arr.length - 1],
    at(t) {
      const i = idx(t, (p) => p.t);
      const a = arr[i - 1], b = arr[i];
      return b.t === a.t ? a.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
    },
    timeAt(v) {
      // assumes v monotonically non-decreasing (odometer)
      const i = idx(v, (p) => p.v);
      const a = arr[i - 1], b = arr[i];
      return b.v === a.v ? a.t : a.t + ((b.t - a.t) * (v - a.v)) / (b.v - a.v);
    },
    rate(t, w = 2) {
      const a = this.at(t - w), b = this.at(t + w);
      return (b - a) / (2 * w);
    },
  };
}

export async function parsePdrFile(fileBlob) {
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
  const root = { type: "moov", start: 0, body: 8, size: moovLoc.size };

  // 2. Find the telemetry track (handler 'ctbx').
  let stbl = null;
  for (const trak of boxes(moov, root.body, moovLoc.size).filter((b) => b.type === "trak")) {
    const mdia = child(moov, trak, "mdia");
    if (!mdia) continue;
    const hdlr = child(moov, mdia, "hdlr");
    if (!hdlr || fourcc(moov, hdlr.body + 8) !== "ctbx") continue;
    const minf = child(moov, mdia, "minf");
    stbl = minf && child(moov, minf, "stbl");
  }
  if (!stbl) throw new Error("No PDR telemetry track in this video");

  const stco = child(moov, stbl, "stco") || child(moov, stbl, "co64");
  const stsz = child(moov, stbl, "stsz");
  const stsd = child(moov, stbl, "stsd");
  if (!stco || !stsz || !stsd) throw new Error("Telemetry track is missing sample tables");

  const is64 = stco.type === "co64";
  const nChunks = moov.getUint32(stco.body + 4);
  const offsets = [];
  for (let i = 0; i < nChunks; i++) {
    offsets.push(is64 ? Number(moov.getBigUint64(stco.body + 8 + i * 8)) : moov.getUint32(stco.body + 8 + i * 4));
  }
  const fixedSize = moov.getUint32(stsz.body + 4);
  const sizeAt = (i) => (fixedSize ? fixedSize : moov.getUint32(stsz.body + 12 + i * 4));

  // 3. Channel table (mrld) -> event tag ids; session metadata (mrlv).
  const subs = boxes(moov, stsd.body + 8 + 16, stsd.start + stsd.size);
  const mrld = subs.find((b) => b.type === "mrld");
  const mrlv = subs.find((b) => b.type === "mrlv");

  const tags = { beacon: 0x36, odometer: 0x42, latitude: 0x31, longitude: 0x32 }; // observed defaults
  const dict = new Map(); // channel id -> {name, units, min, max, mult, off}
  if (mrld) {
    const STRIDE = 448, UNITS_OFF = 12, NAME_OFF = 128;
    const utf8 = new TextDecoder();
    const str = (base, len) => {
      let end = base;
      while (end < base + len && moov.getUint8(end)) end++;
      return utf8.decode(new Uint8Array(moov.buffer, moov.byteOffset + base, end - base));
    };
    for (let e = mrld.body; e + STRIDE <= mrld.start + mrld.size; e += STRIDE) {
      const name = str(e + NAME_OFF, 63).replace(/[^\x20-\x7e].*$/, "");
      const ch = {
        name,
        units: normUnits(str(e + UNITS_OFF, 63)),
        min: moov.getInt32(e + 88),
        max: moov.getInt32(e + 92),
        mult: moov.getFloat64(e + 112),
        off: moov.getFloat64(e + 120),
      };
      const tagId = moov.getUint32(e);
      dict.set(tagId, ch);
      const key = CHANNEL_TAGS[name];
      if (key) tags[key] = tagId;
    }
  }
  // raw -> display units (deg, km/h, rpm, G) via the dictionary entry.
  const scaler = (tagId) => {
    const ch = dict.get(tagId);
    if (!ch || !Number.isFinite(ch.mult) || ch.mult === 0) return null;
    const [f, add] = UNIT_CONV[ch.units] ?? [1, 0];
    return (v) => (v * ch.mult + ch.off) * f + add;
  };

  let date = null, time = null;
  if (mrlv) {
    const raw = td.decode(new Uint8Array(moov.buffer, moov.byteOffset + mrlv.body, mrlv.size - 8));
    const ldat = /ldatdate(\d{4}-\d{2}-\d{2})/.exec(raw) || /datedate(\d{4}-\d{2}-\d{2})/.exec(raw);
    const ltim = /ltimtime(\d{2}-\d{2}-\d{2})/.exec(raw);
    if (ldat) date = ldat[1];
    if (ltim) time = ltim[1].replace(/-/g, ":");
  }

  // 4. Decode the telemetry samples. Full records carry an absolute channel /
  // value / timestamp; delta records adjust the running state (which persists
  // across samples). Values accumulate in raw (pre-multiplier) units.
  // One raw sample bucket per known channel, keyed by the name CHANNEL_TAGS
  // gave it. Beacons are the exception: they are events, not a series.
  const beacons = [];
  const pts = {};
  const buckets = new Map();
  for (const [key, tagId] of Object.entries(tags)) {
    if (key === "beacon") continue;
    buckets.set(tagId, (pts[key] = []));
  }
  const odoPts = pts.odometer, latPts = pts.latitude, lonPts = pts.longitude;

  const MAX_TICKS = 864000000000; // 24h in 100ns units: anything above is corrupt
  let lastTicks = 0;
  const vals = new Map(); // running raw value per channel
  let chan = null, ticks = -1;
  const emit = (ch, v, tk) => {
    if (tk < 0 || tk > MAX_TICKS) return;
    if (tk > lastTicks) lastTicks = tk;
    const t = tk / 1e7;
    if (ch === tags.beacon) beacons.push({ v, t });
    else buckets.get(ch)?.push({ t, v });
  };
  for (let i = 0; i < nChunks; i++) {
    const s = await bufAt(fileBlob, offsets[i], sizeAt(i));
    const n = s.byteLength;
    let q = 0;
    while (q + 8 <= n) {
      const a0 = s.getUint32(q);
      const hi = a0 >>> 24;
      if ((hi & 0xc0) === 0xc0) {
        // full record
        if (hi === 0xff) break; // empty record: end of this sample
        if (q + 16 > n) break;
        chan = a0 & 0x0fffffff;
        const v = s.getInt32(q + 4);
        vals.set(chan, v);
        const tk = s.getUint32(q + 8) * 4294967296 + s.getUint32(q + 12);
        q += 16;
        if (tk > MAX_TICKS) continue; // corrupt timestamp: keep the value, skip the point
        ticks = tk;
        emit(chan, v, ticks);
      } else if ((hi & 0xc0) === 0x40 && chan !== null) {
        // delta record
        ticks += s.getUint32(q + 4);
        chan += (hi & 0x3f) - (hi & 0x20 ? 0x40 : 0);
        q += 8;
        if (!vals.has(chan)) {
          const ch = dict.get(chan);
          if (!ch) continue; // no full record and no dictionary entry to seed from
          vals.set(chan, Math.trunc((ch.min + ch.max) / 2));
        }
        const d = a0 & 0xffffff;
        const v = vals.get(chan) + (d - (a0 & 0x800000 ? 0x1000000 : 0));
        vals.set(chan, v);
        emit(chan, v, ticks);
      } else {
        q += 8;
      }
    }
  }
  beacons.sort((a, b) => a.t - b.t);
  for (const arr of buckets.values()) arr.sort((a, b) => a.t - b.t);

  // Scale the car channels to display units and take session maxima.
  const scaleAll = (arr, conv) => (conv ? arr.map((p) => ({ t: p.t, v: conv(p.v) })) : []);
  // `scaled("speed")` -> that channel's samples in display units, [] when the
  // file lacks it (no dictionary entry, or no samples).
  const scaled = (key) => scaleAll(pts[key] ?? [], scaler(tags[key]));
  const speed = scaled("speed"); // km/h
  const rpm = scaled("rpm");
  const latAcc = scaled("latAcc"); // G
  const throttle = scaled("throttle"); // % (dict units "%" -> x100)
  const brake = scaled("brake"); // %
  const longAcc = scaled("longAcc"); // G, signed: negative under braking
  const yaw = scaled("yaw"); // deg/s, signed
  const boost = scaled("boost"); // kPa gauge (dict units "kPa" -> Pascals /1000)
  // Real firmware stores steering wheel angle in radians with an *empty* units
  // string, so UNIT_CONV's deg conversion never fires — apply it here unless
  // the dictionary already declared degrees.
  const steeringRad = dict.get(tags.steering)?.units !== "deg";
  const steering = scaled("steering").map((p) => ({
    t: p.t,
    v: steeringRad ? (p.v * 180) / Math.PI : p.v,
  })); // deg, signed

  // Gear is an enum, not a measurement: 1-8 are gears, and every other value
  // (13 on a real C7 — 653 samples spread across every speed, with the clutch
  // pedal down) means "in transition / no gear". Stored as 0 rather than
  // dropped, so the array stays on the grid with its neighbours.
  const gear = scaled("gear").map((p) => ({ t: p.t, v: p.v >= 1 && p.v <= 8 ? Math.round(p.v) : 0 }));

  // Wheel slip from the four wheelspeeds, as one channel rather than four:
  // (driven - non-driven) / non-driven, positive under wheelspin and negative
  // under lockup. Below 5 km/h the ratio is noise over a near-zero divisor.
  const wheel = ["wsLN", "wsRN", "wsLD", "wsRD"].map(scaled);
  const wheelSlip =
    wheel.every((w) => w.length > 10)
      ? (() => {
          const [ln, rn, ld, rd] = wheel.map(series);
          return wheel[0].map((p) => {
            const nd = (ln.at(p.t) + rn.at(p.t)) / 2;
            const dr = (ld.at(p.t) + rd.at(p.t)) / 2;
            const v = nd < 5 ? 0 : ((dr - nd) / nd) * 100;
            return { t: p.t, v: Math.max(-100, Math.min(100, v)) };
          });
        })()
      : [];

  // ABS / traction control / stability control packed into one bitfield
  // (bit 0 / 1 / 2), since three near-always-zero channels are not worth three
  // slots in the storage budget. Anchored on ABS's timestamps: the three ship
  // together at the same rate, and ABS is the one that fires on a track.
  const absPts = scaled("absActive");
  const tcS = scaled("tcActive"), vscS = scaled("vscActive");
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
  // Slow housekeeping channels (0.5-1.4 Hz). At one real sample every 40-90 m
  // these cannot fill a 20 m distance grid, so they are reduced to one value
  // per lap instead (js/import/channels.js SCALAR_NAMES).
  const lapScalarChannels = {};
  for (const key of SCALAR_CHANNEL_KEYS) {
    const arr = scaled(key);
    lapScalarChannels[key] = arr.length ? arr : null;
  }
  const oilC = lapScalarChannels.oilC ?? [];

  const maxOf = (pts, cap) => {
    let m = -Infinity;
    for (const p of pts) if (p.v > m) m = p.v;
    return m > 0 && m < cap ? m : null;
  };
  const odoS = odoPts.length > 10 ? series(odoPts) : null;
  let topSpeedKph = maxOf(speed, 500);
  if (topSpeedKph == null && odoS) {
    // no Speed channel: top speed from the odometer slope (m/s -> km/h).
    // Below 30 km/h it's paddock crawling, not a session top speed.
    let m = 0;
    for (let t = odoS.first.t + 2; t <= odoS.last.t - 2; t += 1) m = Math.max(m, odoS.rate(t));
    topSpeedKph = m * 3.6 >= 30 && m * 3.6 < 500 ? m * 3.6 : null;
  }
  const absSeries = (arr) => arr.map((p) => ({ t: p.t, v: Math.abs(p.v) }));
  const metrics = {
    topSpeedKph,
    maxRpm: maxOf(rpm, 20000),
    maxLatG: maxOf(absSeries(latAcc), 5),
    // Braking is the negative half of longitudinal G; reported positive, the
    // way a driver talks about it.
    maxBrakeG: maxOf(longAcc.map((p) => ({ t: p.t, v: -p.v })), 5),
    maxBoostKpa: maxOf(boost, 400),
    maxOilC: maxOf(oilC, 250),
  };

  // Session-level numbers: one value each for the whole recording. Stored
  // inside the channels blob's `meta` (js/import/channels.js) rather than in
  // their own columns — they are context for the graphs, not queryable facts.
  const median = (arr) => {
    if (arr.length < 3) return null;
    const v = arr.map((p) => p.v).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const altitude = scaled("altitude");
  const carOdo = scaled("carOdo"); // km, the car's lifetime odometer
  const sessionMeta = {
    ambientC: median(scaled("ambientC")),
    intakeC: median(scaled("intakeC")),
    elevationM:
      altitude.length > 10
        ? Math.max(...altitude.map((p) => p.v)) - Math.min(...altitude.map((p) => p.v))
        : null,
    odometerKm: carOdo.length ? Math.max(...carOdo.map((p) => p.v)) : null,
  };

  // GPS trace: dictionary conversion first (radians -> degrees), then the
  // heuristic decoders. Speed channel (km/h -> m/s) beats odometer slope for
  // the racing-line speeds.
  const latConv = scaler(tags.latitude), lonConv = scaler(tags.longitude);
  const gps = gpsFromChannels(latPts, lonPts, odoS, {
    dictConv: latConv && lonConv ? { lat: latConv, lon: lonConv } : null,
    speedS: speed.length > 10 ? series(speed.map((p) => ({ t: p.t, v: p.v / 3.6 }))) : null,
  });

  // A channel is worth handing on only when it actually has a series behind
  // it; ten samples is the same floor buildLapChannels applies.
  const dense = (arr) => (arr.length > 10 ? arr : null);

  // 5. Build the full crossing list.
  const crossings = beacons.map((b) => ({ v: b.v, t: b.t, exact: true }));

  if (beacons.length >= 2 && odoPts.length > 10) {
    const odo = series(odoPts);
    const lat = latPts.length > 10 ? series(latPts) : null;
    const d = beacons.map((b) => odo.at(b.t));
    const first = beacons[0], last = beacons[beacons.length - 1];
    const lapLen = (d[d.length - 1] - d[0]) / (last.v - first.v);

    // beacon-calibrated line signature for validating extrapolated crossings
    const latAtLine = lat ? beacons.reduce((s, b) => s + lat.at(b.t), 0) / beacons.length : null;
    const latSpan = lat ? Math.max(...latPts.map((p) => p.v)) - Math.min(...latPts.map((p) => p.v)) : 0;
    const odoRateAtLine = beacons.reduce((s, b) => s + odo.rate(b.t), 0) / beacons.length;

    // fill gaps between known beacons using per-gap lap length
    for (let i = 1; i < beacons.length; i++) {
      const a = beacons[i - 1], b = beacons[i];
      const gap = b.v - a.v;
      if (gap <= 1) continue;
      const da = odo.at(a.t), Lg = (odo.at(b.t) - da) / gap;
      for (let k = 1; k < gap; k++) {
        crossings.push({ v: a.v + k, t: odo.timeAt(da + k * Lg), exact: false });
      }
    }

    // extrapolate before first / after last beacon while the car is still lapping
    const tryExtrapolate = (v, dTarget) => {
      if (dTarget < odo.first.v + lapLen * 0.02 || dTarget > odo.last.v - lapLen * 0.02) return null;
      const t = odo.timeAt(dTarget);
      // car must be at pace (not in pits/paddock)
      if (odo.rate(t) < 0.4 * odoRateAtLine) return null;
      // GPS latitude must match the line (within 4% of the track's lat extent)
      if (lat && Math.abs(lat.at(t) - latAtLine) > 0.04 * latSpan) return null;
      return { v, t, exact: false };
    };
    for (let v = first.v - 1, k = 1; v >= 0; v--, k++) {
      const c = tryExtrapolate(v, d[0] - k * lapLen);
      if (!c) break;
      crossings.push(c);
    }
    for (let v = last.v + 1, k = 1; ; v++, k++) {
      const c = tryExtrapolate(v, d[d.length - 1] + k * lapLen);
      if (!c) break;
      crossings.push(c);
    }
  }
  crossings.sort((a, b) => a.t - b.t);

  // 6. Laps = deltas between consecutive crossings. startT/endT are on the
  // telemetry clock (seconds), same clock as the gps trace's t.
  const laps = [];
  for (let i = 1; i < crossings.length; i++) {
    laps.push({
      lapNumber: crossings[i].v,
      timeMs: Math.round((crossings[i].t - crossings[i - 1].t) * 1000),
      estimated: !(crossings[i].exact && crossings[i - 1].exact),
      startT: crossings[i - 1].t,
      endT: crossings[i].t,
    });
  }

  return {
    date,                       // "2025-10-27" (local) or null
    time,                       // "09:23:26" (local) or null
    durationS: lastTicks / 1e7,
    beaconCount: beacons.length,
    laps,                       // [{lapNumber, timeMs, estimated, startT, endT}]
    gps,                        // [{t, lat, lon, v?}] in degrees, or null
    metrics,                    // session maxima — each null when unavailable
    sessionMeta,                // {ambientC, intakeC, elevationM, odometerKm}
    channels: { latPts, odoPts }, // raw series for lap recovery (pdr-laps.js)
    lapScalarChannels,          // slow series reduced per lap by channels.js
    // scaled car channels ([{t, v}] in km/h / rpm / G / % / deg / kPa) for
    // per-lap channel graphs (js/import/channels.js); each null when the file
    // lacks them. Keys and order match CHANNEL_NAMES there.
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
