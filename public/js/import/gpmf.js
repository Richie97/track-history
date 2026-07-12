// GoPro GPMF telemetry parser (Hero 5 and later). GoPro MP4s carry a
// metadata track (handler 'meta', sample format 'gpmd') holding KLV-encoded
// telemetry — GPS fixes at 10-18 Hz among it. Like pdr.js, only the MP4
// index and the telemetry samples are read via Blob.slice; the video itself
// is never read or uploaded.
//
// Format reference: https://github.com/gopro/gpmf-parser (openly documented
// by GoPro). We extract the GPS stream (GPS5, or GPS9 on Hero 11+) and hand
// back a trace; lap times come from the user-picked start/finish line
// (see geo.js) since GoPro footage has no lap markers.

const td = new TextDecoder("latin1");

async function bufAt(blob, offset, length) {
  const ab = await blob.slice(offset, Math.min(offset + length, blob.size)).arrayBuffer();
  return new DataView(ab);
}

const fourcc = (dv, off) => td.decode(new Uint8Array(dv.buffer, dv.byteOffset + off, 4));

function boxes(dv, start, end) {
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

// --- KLV ---------------------------------------------------------------------
// Each GPMF item: [key:4cc][type:u8][structSize:u8][repeat:u16 BE][data pad4].
// type 0 = nested container.

function* klvItems(dv, start, end) {
  let p = start;
  while (p + 8 <= end) {
    const key = fourcc(dv, p);
    const type = dv.getUint8(p + 4);
    const structSize = dv.getUint8(p + 5);
    const repeat = dv.getUint16(p + 6);
    const dataLen = structSize * repeat;
    if (p + 8 + dataLen > end) break;
    yield { key, type, structSize, repeat, data: p + 8, dataLen };
    p += 8 + ((dataLen + 3) & ~3);
  }
}

const TYPE_SIZES = { b: 1, B: 1, c: 1, s: 2, S: 2, l: 4, L: 4, f: 4, d: 8, j: 8, J: 8, F: 4, U: 16 };

function readTyped(dv, off, ch) {
  switch (ch) {
    case "b": return dv.getInt8(off);
    case "B": return dv.getUint8(off);
    case "s": return dv.getInt16(off);
    case "S": return dv.getUint16(off);
    case "l": return dv.getInt32(off);
    case "L": return dv.getUint32(off);
    case "f": return dv.getFloat32(off);
    case "d": return dv.getFloat64(off);
    default: return null;
  }
}

// Parse one telemetry payload; returns GPS samples found in it.
function parsePayload(dv, start, end) {
  const out = { samples: [], utc: null };

  const walkStream = (s, e) => {
    let scal = null;
    let type9 = null;
    let gps5 = null;
    let gps9 = null;
    let fix = null;
    for (const it of klvItems(dv, s, e)) {
      if (it.key === "SCAL") {
        scal = [];
        const es = it.structSize === 8 ? 8 : 4; // SCAL is int32 (or int64, rare)
        for (let i = 0; i + es <= it.dataLen; i += es) {
          scal.push(es === 8 ? Number(dv.getBigInt64(it.data + i)) : dv.getInt32(it.data + i));
        }
      } else if (it.key === "TYPE") {
        type9 = td.decode(new Uint8Array(dv.buffer, dv.byteOffset + it.data, it.dataLen)).replace(/\0.*$/, "");
      } else if (it.key === "GPS5") gps5 = it;
      else if (it.key === "GPS9") gps9 = it;
      else if (it.key === "GPSF") fix = dv.getUint32(it.data);
      else if (it.key === "GPSU" && !out.utc) {
        out.utc = td.decode(new Uint8Array(dv.buffer, dv.byteOffset + it.data, it.dataLen)).replace(/\0.*$/, "");
      }
    }

    if (gps9 && type9 && scal) {
      // GPS9: lat, lon, alt, 2D speed, 3D speed, days since 2000, secs, DOP, fix
      const sizes = [...type9].map((c) => TYPE_SIZES[c] ?? 0);
      const offs = [];
      let acc = 0;
      for (const sz of sizes) {
        offs.push(acc);
        acc += sz;
      }
      if (acc !== gps9.structSize) return;
      for (let i = 0; i < gps9.repeat; i++) {
        const base = gps9.data + i * gps9.structSize;
        const val = (j) => {
          const v = readTyped(dv, base + offs[j], type9[j]);
          return v == null ? null : v / (scal[j] ?? 1);
        };
        const sampleFix = val(8);
        if (sampleFix != null && sampleFix < 2) continue;
        out.samples.push({ lat: val(0), lon: val(1), v: val(3) });
      }
    } else if (gps5 && scal && (fix == null || fix >= 2)) {
      // GPS5: lat, lon, alt, 2D speed, 3D speed — int32 BE, scaled by SCAL
      const n = Math.floor(gps5.dataLen / 20);
      for (let i = 0; i < n; i++) {
        const base = gps5.data + i * 20;
        out.samples.push({
          lat: dv.getInt32(base) / (scal[0] ?? 1),
          lon: dv.getInt32(base + 4) / (scal[1] ?? 1),
          v: dv.getInt32(base + 12) / (scal[3] ?? 1),
        });
      }
    }
  };

  const walk = (s, e) => {
    for (const it of klvItems(dv, s, e)) {
      if (it.key === "STRM") walkStream(it.data, it.data + it.dataLen);
      else if (it.type === 0) walk(it.data, it.data + it.dataLen);
    }
  };
  walk(start, end);
  return out;
}

// --- MP4 plumbing --------------------------------------------------------------

export async function parseGpmfFile(fileBlob) {
  // 1. Locate moov among top-level boxes.
  let pos = 0;
  let moovLoc = null;
  while (pos + 16 <= fileBlob.size) {
    const hdr = await bufAt(fileBlob, pos, 16);
    let size = hdr.getUint32(0);
    const type = fourcc(hdr, 4);
    if (size === 1) size = Number(hdr.getBigUint64(8));
    if (size === 0) size = fileBlob.size - pos;
    if (size < 8) throw new Error("Not a valid MP4 file");
    if (type === "moov") {
      moovLoc = { pos, size };
      break;
    }
    pos += size;
  }
  if (!moovLoc) throw new Error("No moov box found — is this an MP4?");
  const moov = await bufAt(fileBlob, moovLoc.pos, moovLoc.size);
  const root = { type: "moov", start: 0, body: 8, size: moovLoc.size };

  // 2. Find the GPMF track: handler 'meta' with sample format 'gpmd'.
  let stbl = null;
  let timescale = 1000;
  for (const trak of boxes(moov, root.body, moovLoc.size).filter((b) => b.type === "trak")) {
    const mdia = child(moov, trak, "mdia");
    if (!mdia) continue;
    const minf = mdia && child(moov, mdia, "minf");
    const s = minf && child(moov, minf, "stbl");
    const stsd = s && child(moov, s, "stsd");
    if (!stsd) continue;
    const entry = boxes(moov, stsd.body + 8, stsd.start + stsd.size)[0];
    if (!entry || entry.type !== "gpmd") continue;
    stbl = s;
    const mdhd = child(moov, mdia, "mdhd");
    if (mdhd) {
      timescale = moov.getUint8(mdhd.body) === 1 ? moov.getUint32(mdhd.body + 20) : moov.getUint32(mdhd.body + 12);
    }
    break;
  }
  if (!stbl) throw new Error("No GoPro GPMF telemetry track in this video");

  const stco = child(moov, stbl, "stco") || child(moov, stbl, "co64");
  const stsz = child(moov, stbl, "stsz");
  const stsc = child(moov, stbl, "stsc");
  const stts = child(moov, stbl, "stts");
  if (!stco || !stsz || !stsc || !stts) throw new Error("GPMF track is missing sample tables");

  // Sample sizes.
  const fixedSize = moov.getUint32(stsz.body + 4);
  const sampleCount = moov.getUint32(stsz.body + 8);
  const sizeAt = (i) => (fixedSize ? fixedSize : moov.getUint32(stsz.body + 12 + i * 4));

  // Sample start times (media units) from stts.
  const times = [];
  {
    const n = moov.getUint32(stts.body + 4);
    let t = 0;
    for (let e = 0; e < n; e++) {
      const count = moov.getUint32(stts.body + 8 + e * 8);
      const delta = moov.getUint32(stts.body + 12 + e * 8);
      for (let i = 0; i < count && times.length <= sampleCount; i++) {
        times.push(t);
        t += delta;
      }
    }
    times.push(t); // sentinel: end of last sample
  }

  // Sample file offsets via stsc + stco.
  const is64 = stco.type === "co64";
  const nChunks = moov.getUint32(stco.body + 4);
  const chunkOffset = (i) =>
    is64 ? Number(moov.getBigUint64(stco.body + 8 + i * 8)) : moov.getUint32(stco.body + 8 + i * 4);
  const nStsc = moov.getUint32(stsc.body + 4);
  const stscEntry = (i) => ({
    firstChunk: moov.getUint32(stsc.body + 8 + i * 12),
    perChunk: moov.getUint32(stsc.body + 12 + i * 12),
  });

  const offsets = [];
  let sample = 0;
  for (let e = 0; e < nStsc && sample < sampleCount; e++) {
    const cur = stscEntry(e);
    const nextFirst = e + 1 < nStsc ? stscEntry(e + 1).firstChunk : nChunks + 1;
    for (let c = cur.firstChunk; c < nextFirst && sample < sampleCount; c++) {
      let off = chunkOffset(c - 1);
      for (let k = 0; k < cur.perChunk && sample < sampleCount; k++) {
        offsets.push(off);
        off += sizeAt(sample);
        sample++;
      }
    }
  }

  // 3. Scan payloads for GPS samples, spreading each payload's fixes evenly
  // across its time span.
  const points = [];
  let utc = null;
  for (let i = 0; i < offsets.length; i++) {
    const dv = await bufAt(fileBlob, offsets[i], sizeAt(i));
    const { samples, utc: u } = parsePayload(dv, 0, dv.byteLength);
    if (!utc && u) utc = u;
    if (!samples.length) continue;
    const t0 = times[i] / timescale;
    const t1 = times[i + 1] / timescale;
    samples.forEach((s, j) => {
      if (s.lat == null || s.lon == null) return;
      points.push({ t: t0 + (j / samples.length) * (t1 - t0), lat: s.lat, lon: s.lon, v: s.v });
    });
  }
  if (points.length < 10) throw new Error("No GPS data in this video (was GPS enabled on the camera?)");

  // GPSU: "yymmddhhmmss.sss" (UTC)
  let date = null;
  let time = null;
  const m = utc && /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(utc);
  if (m) {
    date = `20${m[1]}-${m[2]}-${m[3]}`;
    time = `${m[4]}:${m[5]}:${m[6]}`;
  }

  return {
    kind: "gopro",
    date,
    time,
    durationS: times[times.length - 1] / timescale,
    laps: [],
    gps: points,
    needsLine: true,
  };
}
