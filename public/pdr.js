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
// Record framing inside a telemetry sample:
//   - 8-byte record:  [id:u8][payload:24][extra:u32]            (skipped)
//   - 16-byte event:  [0xe0][tag:u24][value:s32][ts:u64 100ns]  (channel data)
// Event tag ids are defined in the 'mrld' channel table (448-byte entries,
// first u32 = tag id, name at entry+128). Session local date/time is in 'mrlv'.

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

  const tags = { beacon: 0x36, odometer: 0x42, latitude: 0x31 }; // observed defaults
  if (mrld) {
    const STRIDE = 448, NAME_OFF = 128;
    for (let e = mrld.body; e + STRIDE <= mrld.start + mrld.size; e += STRIDE) {
      let name = "";
      for (let i = 0; i < 63; i++) {
        const c = moov.getUint8(e + NAME_OFF + i);
        if (c < 0x20 || c > 0x7e) break;
        name += String.fromCharCode(c);
      }
      const tagId = moov.getUint32(e);
      if (name === "Beacon") tags.beacon = tagId;
      else if (name === "Recording Event Odometer") tags.odometer = tagId;
      else if (name === "Latitude") tags.latitude = tagId;
    }
  }

  let date = null, time = null;
  if (mrlv) {
    const raw = td.decode(new Uint8Array(moov.buffer, moov.byteOffset + mrlv.body, mrlv.size - 8));
    const ldat = /ldatdate(\d{4}-\d{2}-\d{2})/.exec(raw) || /datedate(\d{4}-\d{2}-\d{2})/.exec(raw);
    const ltim = /ltimtime(\d{2}-\d{2}-\d{2})/.exec(raw);
    if (ldat) date = ldat[1];
    if (ltim) time = ltim[1].replace(/-/g, ":");
  }

  // 4. Scan telemetry samples for beacon / odometer / latitude events.
  const beacons = [], odoPts = [], latPts = [];
  let lastTicks = 0;
  for (let i = 0; i < nChunks; i++) {
    const s = await bufAt(fileBlob, offsets[i], sizeAt(i));
    const n = s.byteLength;
    let q = 0;
    while (q + 8 <= n) {
      if (s.getUint8(q) === 0xe0) {
        if (q + 16 > n) break;
        const tag = s.getUint32(q) & 0xffffff;
        const v = s.getInt32(q + 4);
        const ticks = s.getUint32(q + 8) * 4294967296 + s.getUint32(q + 12);
        if (ticks > lastTicks) lastTicks = ticks;
        const t = ticks / 1e7;
        if (tag === tags.beacon) beacons.push({ v, t });
        else if (tag === tags.odometer) odoPts.push({ t, v });
        else if (tag === tags.latitude) latPts.push({ t, v });
        q += 16;
      } else {
        q += 8;
      }
    }
  }
  beacons.sort((a, b) => a.t - b.t);
  odoPts.sort((a, b) => a.t - b.t);
  latPts.sort((a, b) => a.t - b.t);

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

  // 6. Laps = deltas between consecutive crossings.
  const laps = [];
  for (let i = 1; i < crossings.length; i++) {
    laps.push({
      lapNumber: crossings[i].v,
      timeMs: Math.round((crossings[i].t - crossings[i - 1].t) * 1000),
      estimated: !(crossings[i].exact && crossings[i - 1].exact),
    });
  }

  return {
    date,                       // "2025-10-27" (local) or null
    time,                       // "09:23:26" (local) or null
    durationS: lastTicks / 1e7,
    beaconCount: beacons.length,
    laps,                       // [{lapNumber, timeMs, estimated}]
  };
}
