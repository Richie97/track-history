// AiM SmartyCam telemetry parser (NS-55, docs/specs/native/NS-55-smartycam-import.md).
//
// A SmartyCam .MOV is QuickTime with three tracks: the picture (avc1), the
// sound (`sowt` PCM) and a third, handler `free`, that is *declared* as PCM
// audio and is really the telemetry: one chunk every five video frames (6 Hz),
// of which only the first RECORD_BYTES are a little-endian record — the rest is
// noise. The layout is reverse-engineered from one camera (SmartyCam GP HD,
// firmware 01.03.30, slave to an AiM logger); the offsets are in readRecord.
//
// Three traps, each inherited by a port:
//
// - **Video time is not real time.** The camera drops frames (about 3 s at the
//   start of every file, and up to 3 % after), so a 128 s lap can be 125 s of
//   video. `t` here is *video* seconds — frame / fps — on purpose: every lap's
//   startT / endT then cuts the clip where the lap is in the file. Lap *times*
//   are the logger's own (offset 40), never endT − startT.
// - **The lap counter trails the crossing by one record** (LAP_LATENCY_RECORDS).
// - **The trailing XML's nlap / best are the logger's totals for the day**, not
//   this file's. Only the date and the time are read from it, and never the
//   driver's name, the vehicle or a serial number.
//
// Like the other video parsers, only the index and the records are read
// through Blob.slice; the video itself is never read or uploaded.

import { bufAt, child, children, fourcc, readMoov } from "./mp4.js";
import { lapTrace, projectTrace, traceOrigin } from "./geo.js";

export const RECORD_BYTES = 124;
export const NO_VALUE = -12290; // the camera's "no reading" in any car field
export const LAP_LATENCY_RECORDS = 1;
export const LAP_CLOCK_TOLERANCE_MS = 1500;

const MIN_CHANNEL_SAMPLES = 10;
const READ_BATCH = 64; // records fetched at once
const META_TAIL_BYTES = 4096;

// WGS-84.
const WGS84_A = 6378137;
const WGS84_E2 = 6.69437999014e-3;
const GEODETIC_ITERATIONS = 5; // fixed, so every port lands on the same digits

// ECEF metres → { lat, lon } in degrees.
export function ecefToGeodetic(xM, yM, zM) {
  const lon = Math.atan2(yM, xM);
  const p = Math.hypot(xM, yM);
  let lat = Math.atan2(zM, p * (1 - WGS84_E2));
  for (let i = 0; i < GEODETIC_ITERATIONS; i++) {
    const s = Math.sin(lat);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
    lat = Math.atan2(zM + WGS84_E2 * n * s, p);
  }
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI };
}

const car = (v) => (v === NO_VALUE ? null : v);

// One record at `offset` of a view. Car fields and the lap fields are null
// when the camera wrote NO_VALUE; `ecef` (metres) and `speedMs` are null when
// the fix isn't one — all zero, a -1, or nowhere near the Earth's surface.
//
//    0 u32  video frame index (0, 5, 10, …)
//    8 i32  logger clock, ms
//   32 i32  completed-lap counter        40 i32  time of the lap just completed, ms
//   60/64/68 i32  ECEF position, cm      76/80/84 i32  ECEF velocity, cm/s
//  104 i32  rpm    108 i32  throttle %   120 i32  gear
//
// Not read: the ×1e7 latitude / longitude at 16 / 24 (2 Hz, and up to 45 m
// behind the ECEF fix), the float at 112 (its meaning changes with the
// camera's configuration) and four slow channels nobody has identified.
export function readRecord(dv, offset = 0) {
  const i32 = (o) => dv.getInt32(offset + o, true);
  const x = i32(60);
  const y = i32(64);
  const z = i32(68);
  const r = Math.hypot(x, y, z) / 100;
  const fix = x !== -1 && y !== -1 && z !== -1 && r > 6.3e6 && r < 6.4e6;
  const lapCount = car(i32(32));
  const lapMs = car(i32(40));
  return {
    frame: dv.getUint32(offset, true),
    tsMs: i32(8),
    lapCount: lapCount != null && lapCount >= 0 ? lapCount : null,
    lapMs: lapMs != null && lapMs > 0 ? lapMs : null,
    ecef: fix ? { x: x / 100, y: y / 100, z: z / 100 } : null,
    speedMs: fix ? Math.hypot(i32(76), i32(80), i32(84)) / 100 : null,
    rpm: car(i32(104)),
    throttle: car(i32(108)),
    gear: car(i32(120)),
  };
}

// The laps a file holds, from records that carry `t` (video seconds).
//
// The counter steps to `c` one record after the car crossed the line, with the
// time of lap `c` beside it. A lap needs both its crossings in the file, so it
// is two *consecutive* steps: the first step seen closes a lap that began
// before the video did (the out-lap, timed from when the logger started) and
// only opens the next. A counter that jumps, goes backwards or goes missing
// opens nothing. A lap whose logger-clock length disagrees with its reported
// time is a glitch, not a lap.
export function lapsFromCounter(records) {
  const laps = [];
  let open = null; // { count, t, tsMs } — the crossing that began the lap in progress
  let prev = null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.lapCount == null) {
      open = null;
      prev = null;
      continue;
    }
    if (prev != null && r.lapCount !== prev) {
      if (r.lapCount === prev + 1) {
        const at = records[Math.max(0, i - LAP_LATENCY_RECORDS)];
        if (
          open &&
          open.count === prev &&
          r.lapMs != null &&
          Math.abs(at.tsMs - open.tsMs - r.lapMs) <= LAP_CLOCK_TOLERANCE_MS &&
          at.t > open.t
        ) {
          laps.push({ lapNumber: laps.length + 1, timeMs: r.lapMs, estimated: false, startT: open.t, endT: at.t });
        }
        open = { count: r.lapCount, t: at.t, tsMs: at.tsMs };
      } else {
        open = null;
      }
    }
    prev = r.lapCount;
  }
  return laps;
}

// Whether each car field looks like what it is taken to be, over the whole
// file. Their meaning is confirmed on one camera configuration only, so a
// field that fails is left out — the import never fails on it.
export function plausibleChannels(records) {
  const vals = (k) => records.map((r) => r[k]).filter((v) => v != null);
  const enough = (v) => v.length >= MIN_CHANNEL_SAMPLES;
  const rpm = vals("rpm");
  const throttle = vals("throttle");
  const gear = vals("gear");
  const max = (v) => v.reduce((m, x) => (x > m ? x : m), -Infinity);
  const min = (v) => v.reduce((m, x) => (x < m ? x : m), Infinity);
  return {
    rpm: enough(rpm) && min(rpm) >= 0 && max(rpm) >= 1000 && max(rpm) <= 20000,
    throttle: enough(throttle) && min(throttle) >= 0 && max(throttle) <= 100 && max(throttle) - min(throttle) >= 30,
    gear: enough(gear) && min(gear) >= 0 && max(gear) <= 8,
  };
}

// The trailing <aim_meta_data> block → { date: "yyyy-mm-dd", time: "hh:mm:ss" },
// each null when absent. Nothing else in it is read.
export function parseAimMeta(text) {
  const field = (n) => new RegExp(`<p n="${n}">([^<]*)</p>`).exec(text ?? "")?.[1] ?? null;
  const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(field("date") ?? "");
  const h = /^(\d{2}):(\d{2})[.:](\d{2})$/.exec(field("hour") ?? "");
  return {
    date: d ? `${d[3]}-${d[2]}-${d[1]}` : null,
    time: h ? `${h[1]}:${h[2]}:${h[3]}` : null,
  };
}

const td = new TextDecoder("latin1");

// A trak's handler subtype, sample-entry type and tables.
function trackInfo(moov, trak) {
  const mdia = child(moov, trak, "mdia");
  const hdlr = mdia && child(moov, mdia, "hdlr");
  const mdhd = mdia && child(moov, mdia, "mdhd");
  const minf = mdia && child(moov, mdia, "minf");
  const stbl = minf && child(moov, minf, "stbl");
  if (!hdlr || !mdhd || !stbl) return null;
  const stsd = child(moov, stbl, "stsd");
  const v1 = moov.getUint8(mdhd.body) === 1;
  return {
    handler: fourcc(moov, hdlr.body + 8),
    entry: stsd && stsd.size >= 24 ? fourcc(moov, stsd.body + 12) : null,
    timescale: moov.getUint32(mdhd.body + (v1 ? 20 : 12)),
    duration: v1 ? Number(moov.getBigUint64(mdhd.body + 24)) : moov.getUint32(mdhd.body + 16),
    stbl,
  };
}

// Where each chunk of a track starts and how many bytes it holds, for a track
// of fixed-size samples (which is what a track declared as PCM is).
function chunkTable(moov, stbl) {
  const stco = child(moov, stbl, "stco") ?? child(moov, stbl, "co64");
  const stsc = child(moov, stbl, "stsc");
  const stsz = child(moov, stbl, "stsz");
  if (!stco || !stsc || !stsz) return [];
  const sampleBytes = moov.getUint32(stsz.body + 4);
  if (!sampleBytes) return [];
  const is64 = stco.type === "co64";
  const nChunks = moov.getUint32(stco.body + 4);
  const nRuns = moov.getUint32(stsc.body + 4);
  const out = [];
  for (let e = 0; e < nRuns; e++) {
    const first = moov.getUint32(stsc.body + 8 + e * 12);
    const perChunk = moov.getUint32(stsc.body + 12 + e * 12);
    const next = e + 1 < nRuns ? moov.getUint32(stsc.body + 8 + (e + 1) * 12) : nChunks + 1;
    for (let c = first; c < next && c <= nChunks; c++) {
      const offset = is64 ? Number(moov.getBigUint64(stco.body + 8 + (c - 1) * 8)) : moov.getUint32(stco.body + 8 + (c - 1) * 4);
      out.push({ offset, bytes: perChunk * sampleBytes });
    }
  }
  return out;
}

// Seconds since 1904 (QuickTime's epoch) → { date, time } in UTC.
function mvhdStamp(moov, moovBox) {
  const mvhd = child(moov, moovBox, "mvhd");
  if (!mvhd) return { date: null, time: null };
  const v1 = moov.getUint8(mvhd.body) === 1;
  const s = v1 ? Number(moov.getBigUint64(mvhd.body + 4)) : moov.getUint32(mvhd.body + 4);
  const ms = (s - 2082844800) * 1000;
  if (!(s > 2082844800) || !Number.isFinite(ms)) return { date: null, time: null };
  const iso = new Date(ms).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

export async function parseSmartyCamFile(fileBlob) {
  const { moov } = await readMoov(fileBlob);
  const moovBox = { type: "moov", start: 0, body: 8, size: moov.byteLength };
  const tracks = children(moov, moovBox)
    .filter((b) => b.type === "trak")
    .map((trak) => trackInfo(moov, trak))
    .filter(Boolean);

  // The telemetry: handler `free`, declared as `sowt`, in chunks long enough
  // to hold a record. The chunk length is the file's own — never a constant.
  const data = tracks.find((t) => t.handler === "free" && t.entry === "sowt");
  const chunks = data ? chunkTable(moov, data.stbl).filter((c) => c.bytes >= RECORD_BYTES) : [];
  if (!chunks.length) throw new Error("No SmartyCam telemetry track in this video");

  // The picture's frame rate turns a record's frame index into video seconds.
  const video = tracks.find((t) => t.handler === "vide");
  const stts = video && child(moov, video.stbl, "stts");
  const frameDelta = stts && moov.getUint32(stts.body + 4) ? moov.getUint32(stts.body + 12) : 0;
  if (!video || !video.timescale || !frameDelta) throw new Error("SmartyCam video track is missing its timing");
  const fps = video.timescale / frameDelta;
  const durationS = video.duration / video.timescale;

  const records = [];
  let lastFrame = -1;
  for (let i = 0; i < chunks.length; i += READ_BATCH) {
    const views = await Promise.all(chunks.slice(i, i + READ_BATCH).map((c) => bufAt(fileBlob, c.offset, RECORD_BYTES)));
    for (const dv of views) {
      if (dv.byteLength < RECORD_BYTES) continue;
      const r = readRecord(dv);
      if (r.frame <= lastFrame) continue; // a record out of order is not a record
      lastFrame = r.frame;
      r.t = r.frame / fps;
      records.push(r);
    }
  }

  const gps = [];
  for (const r of records) {
    if (!r.ecef) continue;
    const { lat, lon } = ecefToGeodetic(r.ecef.x, r.ecef.y, r.ecef.z);
    gps.push({ t: r.t, lat, lon, v: r.speedMs });
  }
  if (gps.length < 10) throw new Error("No GPS data in this SmartyCam video");

  const laps = lapsFromCounter(records);

  const ok = plausibleChannels(records);
  const series = (k) => records.filter((r) => r[k] != null).map((r) => ({ t: r.t, v: r[k] }));
  const carChannels = {};
  for (const k of ["rpm", "throttle", "gear"]) if (ok[k]) carChannels[k] = series(k);

  const topKph = gps.reduce((m, p) => Math.max(m, p.v * 3.6), 0);
  const metrics = {
    topSpeedKph: topKph >= 30 && topKph < 500 ? topKph : null,
    maxRpm: carChannels.rpm ? carChannels.rpm.reduce((m, p) => Math.max(m, p.v), 0) : null,
  };

  const tail = await bufAt(fileBlob, Math.max(0, fileBlob.size - META_TAIL_BYTES), META_TAIL_BYTES);
  const meta = parseAimMeta(td.decode(new Uint8Array(tail.buffer, tail.byteOffset, tail.byteLength)));
  const stamp = meta.date ? meta : mvhdStamp(moov, moovBox);

  let bestLapTrace = null;
  let traceGeo = null;
  if (laps.length) {
    const best = laps.reduce((a, b) => (b.timeMs < a.timeMs ? b : a));
    bestLapTrace = lapTrace(projectTrace(gps), best.startT, best.endT);
    traceGeo = bestLapTrace ? traceOrigin(gps) : null;
  }

  return {
    kind: "smartycam",
    date: stamp.date,
    time: stamp.time,
    durationS,
    laps,
    gps,
    carChannels,
    metrics,
    bestLapTrace,
    traceGeo,
    needsLine: false,
  };
}
