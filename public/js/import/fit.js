// Garmin FIT parser — just enough of the FIT protocol to pull lap and GPS
// record messages out of a Catalyst (or other Garmin) session file.
//
// FIT is a binary stream: a file header, then records. A definition record
// declares the layout (field numbers, sizes, endianness) for a local message
// type; data records then use that layout. We decode:
//   - lap      (global 19): start_time (2), total_elapsed_time (7, ms/1000)
//   - record   (global 20): position_lat/long (0/1, semicircles),
//                           speed (6, m/s /1000), timestamp (253)
//   - session  (18): start_time (2) for the session date/time
// CRCs are not validated — we only read.

const FIT_EPOCH_S = 631065600; // 1989-12-31T00:00:00Z in Unix seconds
const SEMI = 180 / 2 ** 31; // semicircles -> degrees

function readValue(dv, off, size, baseType, little) {
  switch (baseType & 0x1f) {
    case 0x01: return dv.getInt8(off); // sint8
    case 0x00: // enum
    case 0x02: case 0x0a: return dv.getUint8(off); // uint8
    case 0x03: return dv.getInt16(off, little);
    case 0x04: case 0x0b: return dv.getUint16(off, little);
    case 0x05: return dv.getInt32(off, little);
    case 0x06: case 0x0c: return dv.getUint32(off, little);
    case 0x08: return dv.getFloat32(off, little);
    case 0x09: return dv.getFloat64(off, little);
    default: return null; // strings, 64-bit ints, byte arrays — not needed
  }
}

const INVALID = { 0x01: 0x7f, 0x02: 0xff, 0x0a: 0x00, 0x03: 0x7fff, 0x04: 0xffff, 0x0b: 0xffff, 0x05: 0x7fffffff, 0x06: 0xffffffff, 0x0c: 0xffffffff };

export function parseFitBuffer(buf) {
  const dv = new DataView(buf);
  if (dv.byteLength < 14) throw new Error("Not a valid FIT file");
  const headerSize = dv.getUint8(0);
  const dataSize = dv.getUint32(4, true);
  const sig =
    String.fromCharCode(dv.getUint8(8)) + String.fromCharCode(dv.getUint8(9)) +
    String.fromCharCode(dv.getUint8(10)) + String.fromCharCode(dv.getUint8(11));
  if (sig !== ".FIT") throw new Error("Not a valid FIT file");

  const end = Math.min(headerSize + dataSize, dv.byteLength);
  const defs = new Map(); // local type -> {global, little, fields, totalSize, devSize}

  const laps = [];
  const records = [];
  let sessionStart = null;
  let lastTimestamp = null; // for compressed-timestamp headers

  let p = headerSize;
  while (p < end) {
    const hdr = dv.getUint8(p);
    p += 1;

    if ((hdr & 0x80) === 0 && hdr & 0x40) {
      // definition record
      const local = hdr & 0x0f;
      const hasDev = (hdr & 0x20) !== 0;
      const little = dv.getUint8(p + 1) === 0;
      const global = dv.getUint16(p + 2, little);
      const nFields = dv.getUint8(p + 4);
      p += 5;
      const fields = [];
      let totalSize = 0;
      for (let i = 0; i < nFields; i++) {
        const num = dv.getUint8(p);
        const size = dv.getUint8(p + 1);
        const baseType = dv.getUint8(p + 2);
        fields.push({ num, size, baseType, offset: totalSize });
        totalSize += size;
        p += 3;
      }
      let devSize = 0;
      if (hasDev) {
        const nDev = dv.getUint8(p);
        p += 1;
        for (let i = 0; i < nDev; i++) {
          devSize += dv.getUint8(p + 1);
          p += 3;
        }
      }
      defs.set(local, { global, little, fields, totalSize, devSize });
      continue;
    }

    // data record (normal or compressed-timestamp header)
    const local = hdr & 0x80 ? (hdr >> 5) & 0x03 : hdr & 0x0f;
    const def = defs.get(local);
    if (!def) throw new Error("Corrupt FIT file (data before its definition)");

    const get = (fieldNum) => {
      const f = def.fields.find((x) => x.num === fieldNum);
      if (!f) return null;
      const v = readValue(dv, p + f.offset, f.size, f.baseType, def.little);
      if (v === null || v === INVALID[f.baseType & 0x1f]) return null;
      return v;
    };

    if (def.global === 19) {
      // lap
      const elapsed = get(7); // total_elapsed_time, /1000 s
      const timer = get(8); // total_timer_time
      const ms = elapsed ?? timer;
      const start = get(2);
      if (ms != null && ms > 0) laps.push({ startS: start, timeMs: Math.round(ms) });
    } else if (def.global === 20) {
      // record
      const lat = get(0);
      const lon = get(1);
      let ts = get(253);
      if (ts == null && hdr & 0x80 && lastTimestamp != null) {
        // compressed timestamp: 5-bit offset rolls forward from the last one
        const off = hdr & 0x1f;
        ts = (lastTimestamp & ~0x1f) + off + (off < (lastTimestamp & 0x1f) ? 0x20 : 0);
      }
      if (ts != null) lastTimestamp = ts;
      if (lat != null && lon != null && ts != null) {
        const speed = get(73) ?? get(6); // enhanced_speed or speed, /1000 m/s
        records.push({ ts, lat: lat * SEMI, lon: lon * SEMI, v: speed != null ? speed / 1000 : undefined });
      }
    } else if (def.global === 18) {
      // session
      sessionStart = get(2) ?? sessionStart;
    } else {
      const ts = get(253);
      if (ts != null) lastTimestamp = ts;
    }
    p += def.totalSize + def.devSize;
  }

  const t0 = records.length ? records[0].ts : null;
  const gps = records.map((r) => ({ t: r.ts - t0, lat: r.lat, lon: r.lon, v: r.v }));

  let date = null;
  let time = null;
  const startS = sessionStart ?? laps[0]?.startS ?? t0;
  if (startS != null) {
    const d = new Date((startS + FIT_EPOCH_S) * 1000);
    date = d.toISOString().slice(0, 10);
    time = d.toISOString().slice(11, 19);
  }

  const durationS = gps.length
    ? gps[gps.length - 1].t
    : laps.reduce((s, l) => s + l.timeMs / 1000, 0);

  return {
    kind: "fit",
    date,
    time,
    durationS,
    // Device-computed lap times are exact, not estimates.
    laps: laps.map((l) => ({ timeMs: l.timeMs, estimated: false })),
    gps: gps.length >= 10 ? gps : null,
    needsLine: laps.length === 0 && gps.length >= 10,
  };
}

export async function parseFitFile(fileBlob) {
  const out = parseFitBuffer(await fileBlob.arrayBuffer());
  if (!out.laps.length && !out.gps) {
    throw new Error("FIT file contains no laps or GPS data");
  }
  return out;
}
