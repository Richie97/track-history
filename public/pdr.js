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

// Factors from the SI value (raw * multiplier + offset) to the unit named in
// the channel dictionary — mirrors ExifTool GM.pm's conversions for the units
// this app surfaces (lat/lon in radians -> degrees, m/s -> km/h, m/s² -> G,
// and Cosworth's factor-of-10 rpm).
const UNIT_SCALE = {
  "deg": 180 / Math.PI,
  "deg/sec": 180 / Math.PI,
  "kph": 3.6,
  "G": 1 / 9.80665,
  "rpm": 10,
  "%": 100,
};
const normUnits = (u) => (u === "°" ? "deg" : u === "°/sec" ? "deg/sec" : u);

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
      if (name === "Beacon") tags.beacon = tagId;
      else if (name === "Recording Event Odometer") tags.odometer = tagId;
      else if (name === "Latitude") tags.latitude = tagId;
      else if (name === "Longitude") tags.longitude = tagId;
      else if (name === "Speed") tags.speed = tagId;
      else if (name === "RPM") tags.rpm = tagId;
      else if (name === "Lateral Acceleration") tags.latAcc = tagId;
    }
  }
  // raw -> display units (deg, km/h, rpm, G) via the dictionary entry.
  const scaler = (tagId) => {
    const ch = dict.get(tagId);
    if (!ch || !Number.isFinite(ch.mult) || ch.mult === 0) return null;
    const f = UNIT_SCALE[ch.units] ?? 1;
    return (v) => (v * ch.mult + ch.off) * f;
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
  const beacons = [], odoPts = [], latPts = [], lonPts = [], speedPts = [], rpmPts = [], latAccPts = [];
  const buckets = new Map([
    [tags.odometer, odoPts],
    [tags.latitude, latPts],
    [tags.longitude, lonPts],
  ]);
  if (tags.speed != null) buckets.set(tags.speed, speedPts);
  if (tags.rpm != null) buckets.set(tags.rpm, rpmPts);
  if (tags.latAcc != null) buckets.set(tags.latAcc, latAccPts);

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
  for (const pts of buckets.values()) pts.sort((a, b) => a.t - b.t);

  // Scale the car channels to display units and take session maxima.
  const scaleAll = (pts, conv) => (conv ? pts.map((p) => ({ t: p.t, v: conv(p.v) })) : []);
  const speed = scaleAll(speedPts, scaler(tags.speed)); // km/h
  const rpm = scaleAll(rpmPts, scaler(tags.rpm));
  const latAcc = scaleAll(latAccPts, scaler(tags.latAcc)); // G
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
  const metrics = {
    topSpeedKph,
    maxRpm: maxOf(rpm, 20000),
    maxLatG: maxOf(latAcc.map((p) => ({ t: p.t, v: Math.abs(p.v) })), 5),
  };

  // GPS trace: dictionary conversion first (radians -> degrees), then the
  // heuristic decoders. Speed channel (km/h -> m/s) beats odometer slope for
  // the racing-line speeds.
  const latConv = scaler(tags.latitude), lonConv = scaler(tags.longitude);
  const gps = gpsFromChannels(latPts, lonPts, odoS, {
    dictConv: latConv && lonConv ? { lat: latConv, lon: lonConv } : null,
    speedS: speed.length > 10 ? series(speed.map((p) => ({ t: p.t, v: p.v / 3.6 }))) : null,
  });

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
    metrics,                    // {topSpeedKph, maxRpm, maxLatG} — each null when unavailable
    channels: { latPts, odoPts }, // raw series for lap recovery (pdr-laps.js)
  };
}
