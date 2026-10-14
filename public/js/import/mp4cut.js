// Best-lap clip cutter for the browser (NS-47,
// docs/specs/native/NS-47-web-clip-upload.md): a passthrough cut of one window
// out of a camera's MP4, by hand, with no dependency and no decoding.
//
// It reads the source's `moov`, keeps one video track and at most one audio
// track, rebuilds their sample tables for the window and writes a new
// `ftyp` + `moov` + `mdat`. No sample is decoded or re-encoded. Three rules are
// load-bearing:
//
// - **The video is never read into memory.** The clip is a Blob assembled from
//   the new header (tens to hundreds of KB) and `File.slice()` ranges of the
//   source for the kept samples. A browser holds a sliced File as a reference
//   to the file on disk, so cutting reads only the `moov`, and uploading a part
//   (`clip.slice(…)`) streams it from disk. A day of five 150 MB clips must not
//   need 750 MB of RAM.
// - **The same file and window give byte-identical output.** No clock, no
//   random id, a fixed box order, the source's own mvhd/tkhd times. That is
//   what lets a closed tab resume: a second cut declares the same size, so the
//   server answers the upload already started with its parts already stored.
// - **Nothing but picture and sound.** The telemetry track (`marl`, `adco`,
//   `gpmd`), timecode, and every `udta` / `meta` / `uuid` / `tref` — where
//   location atoms live, and the PDR 2.5's cover image — are left behind.
//
// Where the cut falls: from the last sync sample at or before the window's
// start (Android's MediaExtractor rule — no edit list hides the frames before
// the requested start, so `lapOffsetMs` is measured and lands a little past
// PRE_ROLL_S) to the first sync sample at or after its end, exclusive, so every
// kept frame decodes. Sound runs from the AAC frame holding the first kept
// frame's time to the one holding the last frame's end, and an edit list lines
// it up with the picture.
//
// Times: "presentation time" here is a sample's place on the movie timeline,
// through its track's edit list — the clock the telemetry's lap times are on,
// since the telemetry track is muxed into the same file. An encoder with
// B-frames shifts media time behind its own edit list (the trap iOS hit in
// NS-45 ticket 2), so every time goes through `presentation()`, never straight
// from the sample tables.

import { boxes, child, children, fourcc, readMoov } from "./mp4.js";

// The largest clip the server takes — mirrors MAX_CLIP_BYTES in
// src/lib/clips.ts, pinned to it by test/unit/mp4cut.test.js.
export const MAX_CLIP_BYTES = 1024 * 1024 * 1024;

// An output chunk never spans more than this much media, so the two tracks
// interleave closely enough that a player reading by range never seeks far.
export const CHUNK_S = 1;

// Why a cut refused. Each is worded on the session as *"Couldn't save this
// lap's video"*; the session itself is already saved.
//   "fragmented"     a fragmented MP4 (moov holds mvex) — no camera we import writes one
//   "no-video"       no video track the rule below accepts
//   "no-keyframe"    no sync sample in or before the window
//   "window-outside" the window, or the lap in it, isn't in the video
//   "too-large"      the cut would be over MAX_CLIP_BYTES
//   "malformed"      sample tables that contradict each other
export class ClipCutError extends Error {
  constructor(reason, message) {
    super(message ?? `Couldn't cut the clip (${reason})`);
    this.name = "ClipCutError";
    this.reason = reason;
  }
}

// --- choosing the tracks ------------------------------------------------------

const PREFERRED_VIDEO = ["avc1", "avc3", "hvc1", "hev1"];
const JPEG_ENTRIES = ["jpeg", "mjpa", "mjpb"];
// MPEG-4 Systems object types that are still images, for an `mp4v` entry —
// how ffmpeg muxes a cover image (Android's ClipCutterTest source has one).
const IMAGE_OBJECT_TYPES = [0x6c, 0x6d, 0x6e];

// The phones' rule, over each track's { handler, entry, objectType }: the first
// H.264 / HEVC video track, else the first other video track that isn't a JPEG
// (a PDR 2.5's cover image must never be the picture); the first `soun` track
// whose entry is `mp4a`. Answers indices, or null for none.
export function pickTracks(tracks) {
  const isVideo = (t) => t.handler === "vide";
  let video = tracks.findIndex((t) => isVideo(t) && PREFERRED_VIDEO.includes(t.entry));
  if (video < 0) {
    video = tracks.findIndex(
      (t) => isVideo(t) && t.entry && !JPEG_ENTRIES.includes(t.entry) && !IMAGE_OBJECT_TYPES.includes(t.objectType)
    );
  }
  const audio = tracks.findIndex((t) => t.handler === "soun" && t.entry === "mp4a");
  return { video: video < 0 ? null : video, audio: audio < 0 ? null : audio };
}

// The object type in an `mp4v` entry's esds, or null. A VisualSampleEntry's
// child boxes start 78 bytes into its payload.
function mp4vObjectType(dv, entry) {
  const esds = boxes(dv, entry.body + 78, entry.start + entry.size).find((b) => b.type === "esds");
  if (!esds) return null;
  const end = esds.start + esds.size;
  let p = esds.body + 4; // version + flags
  const descriptor = () => {
    const tag = dv.getUint8(p++);
    let len = 0;
    for (let i = 0; i < 4 && p < end; i++) {
      const b = dv.getUint8(p++);
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return { tag, len };
  };
  if (p >= end || descriptor().tag !== 0x03) return null;
  p += 2; // ES_ID
  const flags = dv.getUint8(p++);
  if (flags & 0x80) p += 2; // streamDependenceFlag
  if (flags & 0x40) p += 1 + dv.getUint8(p); // URL_Flag
  if (flags & 0x20) p += 2; // OCRstreamFlag
  if (p >= end || descriptor().tag !== 0x04 || p >= end) return null;
  return dv.getUint8(p);
}

const timescaleOf = (dv, mdhd) => (dv.getUint8(mdhd.body) === 1 ? dv.getUint32(mdhd.body + 20) : dv.getUint32(mdhd.body + 12));

// One track's boxes and its edit, or null when it isn't a whole track.
function readTrack(dv, trak, movieTs) {
  const tkhd = child(dv, trak, "tkhd");
  const mdia = child(dv, trak, "mdia");
  const mdhd = mdia && child(dv, mdia, "mdhd");
  const hdlr = mdia && child(dv, mdia, "hdlr");
  const minf = mdia && child(dv, mdia, "minf");
  const stbl = minf && child(dv, minf, "stbl");
  const stsd = stbl && child(dv, stbl, "stsd");
  if (!tkhd || !mdhd || !hdlr || !stsd) return null;
  const entryBox = boxes(dv, stsd.body + 8, stsd.start + stsd.size)[0];
  const entry = entryBox?.type ?? null;
  const timescale = timescaleOf(dv, mdhd);
  if (!timescale) return null;
  return {
    tkhd, mdhd, stbl, stsd, timescale,
    handler: fourcc(dv, hdlr.body + 8),
    entry,
    objectType: entry === "mp4v" ? mp4vObjectType(dv, entryBox) : null,
    edit: readEdit(dv, trak, movieTs),
  };
}

// The track's edit list, reduced to what a camera writes: any number of empty
// edits (a delay, in movie time) and then one media edit, whose media_time is
// where the track's presentation begins. Later edits are ignored.
function readEdit(dv, trak, movieTs) {
  const edts = child(dv, trak, "edts");
  const elst = edts && child(dv, edts, "elst");
  let emptyS = 0;
  if (elst) {
    const v = dv.getUint8(elst.body);
    const n = dv.getUint32(elst.body + 4);
    for (let i = 0; i < n; i++) {
      const p = elst.body + 8 + i * (v === 1 ? 20 : 12);
      const duration = v === 1 ? Number(dv.getBigUint64(p)) : dv.getUint32(p);
      const mediaTime = v === 1 ? Number(dv.getBigInt64(p + 8)) : dv.getInt32(p + 4);
      if (mediaTime === -1) emptyS += duration / movieTs;
      else return { emptyS, mediaTime };
    }
  }
  return { emptyS, mediaTime: 0 };
}

// --- the sample tables ----------------------------------------------------------

// A track's sample tables, flat: per sample its decode time and duration (media
// ticks), composition offset (null when there is no ctts), size, file offset,
// sync flag (null when there is no stss — every sample is sync) and sample
// description index. Typed arrays: a 25-minute 30 fps source is ~45,000 video
// samples. Exported for the tests, which read the output back through it.
export function sampleTable(dv, stbl) {
  const box = (t) => child(dv, stbl, t);
  const stts = box("stts");
  const stsc = box("stsc");
  const stco = box("stco") || box("co64");
  const stsz = box("stsz");
  const stz2 = stsz ? null : box("stz2");
  if (!stts || !stsc || !stco || (!stsz && !stz2)) throw new ClipCutError("malformed", "Missing sample tables");

  // Sizes.
  let count, size;
  if (stsz) {
    const fixed = dv.getUint32(stsz.body + 4);
    count = dv.getUint32(stsz.body + 8);
    size = new Uint32Array(count);
    for (let i = 0; i < count; i++) size[i] = fixed || dv.getUint32(stsz.body + 12 + i * 4);
  } else {
    const field = dv.getUint8(stz2.body + 7);
    count = dv.getUint32(stz2.body + 8);
    size = new Uint32Array(count);
    const base = stz2.body + 12;
    for (let i = 0; i < count; i++) {
      if (field === 16) size[i] = dv.getUint16(base + i * 2);
      else if (field === 8) size[i] = dv.getUint8(base + i);
      else if (field === 4) size[i] = (dv.getUint8(base + (i >> 1)) >> (i & 1 ? 0 : 4)) & 0xf;
      else throw new ClipCutError("malformed", "Unknown stz2 field size");
    }
  }

  // Decode times and durations.
  const dts = new Float64Array(count);
  const delta = new Uint32Array(count);
  {
    const n = dv.getUint32(stts.body + 4);
    let i = 0, t = 0;
    for (let e = 0; e < n && i < count; e++) {
      const c = dv.getUint32(stts.body + 8 + e * 8);
      const d = dv.getUint32(stts.body + 12 + e * 8);
      for (let k = 0; k < c && i < count; k++, i++) {
        dts[i] = t;
        delta[i] = d;
        t += d;
      }
    }
    // A Corvette PDR's audio stts stops one sample short of its stsz; carry the
    // last duration forward, as ffmpeg does, rather than refuse the file.
    if (i === 0 && count) throw new ClipCutError("malformed", "Empty stts");
    for (; i < count; i++) {
      dts[i] = t;
      delta[i] = delta[i - 1];
      t += delta[i];
    }
  }

  // Composition offsets — signed in both versions (version 0 is nominally
  // unsigned, and no encoder writes one past 2^31).
  let cto = null;
  const ctts = box("ctts");
  if (ctts) {
    cto = new Int32Array(count);
    const n = dv.getUint32(ctts.body + 4);
    let i = 0;
    for (let e = 0; e < n && i < count; e++) {
      const c = dv.getUint32(ctts.body + 8 + e * 8);
      const o = dv.getInt32(ctts.body + 12 + e * 8);
      for (let k = 0; k < c && i < count; k++, i++) cto[i] = o;
    }
  }

  // File offsets, through the chunks.
  const offset = new Float64Array(count);
  const sdi = new Uint32Array(count);
  {
    const is64 = stco.type === "co64";
    const nChunks = dv.getUint32(stco.body + 4);
    const chunkAt = (c) => (is64 ? Number(dv.getBigUint64(stco.body + 8 + c * 8)) : dv.getUint32(stco.body + 8 + c * 4));
    const n = dv.getUint32(stsc.body + 4);
    const run = (e) => ({
      first: dv.getUint32(stsc.body + 8 + e * 12) - 1,
      per: dv.getUint32(stsc.body + 12 + e * 12),
      sdi: dv.getUint32(stsc.body + 16 + e * 12),
    });
    let i = 0;
    for (let e = 0; e < n && i < count; e++) {
      const r = run(e);
      const last = e + 1 < n ? run(e + 1).first : nChunks;
      for (let c = r.first; c < last && i < count; c++) {
        let p = chunkAt(c);
        for (let k = 0; k < r.per && i < count; k++, i++) {
          offset[i] = p;
          sdi[i] = r.sdi;
          p += size[i];
        }
      }
    }
    if (i < count) throw new ClipCutError("malformed", "stsc/stco cover fewer samples than stsz");
  }

  // Sync samples.
  let sync = null;
  const stss = box("stss");
  if (stss) {
    sync = new Uint8Array(count);
    const n = dv.getUint32(stss.body + 4);
    for (let e = 0; e < n; e++) {
      const s = dv.getUint32(stss.body + 8 + e * 4) - 1;
      if (s >= 0 && s < count) sync[s] = 1;
    }
  }

  return { count, dts, delta, cto, size, offset, sync, sdi };
}

// Each sample's presentation time on the movie timeline, in seconds.
function presentation(table, track) {
  const { count, dts, cto } = table;
  const { emptyS, mediaTime } = track.edit;
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = emptyS + (dts[i] + (cto ? cto[i] : 0) - mediaTime) / track.timescale;
  return out;
}

// --- writing -------------------------------------------------------------------

const te = new TextEncoder();

function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function box(type, ...parts) {
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(te.encode(type), 4);
  out.set(body, 8);
  return out;
}

const fullBox = (type, version, flags, ...parts) =>
  box(type, new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...parts);

// Big-endian u32s. An argument may be an array — a sample table — which is
// written in place rather than spread: spreading 45,000 sizes into a call
// overruns Safari's argument limit.
function u32(...vals) {
  let n = 0;
  for (const v of vals) n += typeof v === "number" ? 1 : v.length;
  const out = new Uint8Array(n * 4);
  const dv = new DataView(out.buffer);
  let i = 0;
  for (const v of vals) {
    if (typeof v === "number") dv.setUint32(4 * i++, v);
    else for (const x of v) dv.setUint32(4 * i++, x);
  }
  return out;
}

function i32(v) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, v);
  return out;
}

function u64(v) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(v));
  return out;
}

function i64(v) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(v));
  return out;
}

const copyBox = (dv, b) => new Uint8Array(dv.buffer.slice(dv.byteOffset + b.start, dv.byteOffset + b.start + b.size));

// A copied full box with a field patched at `off` bytes into its payload
// (after the version/flags word's start). `width` 4 or 8.
function patch(bytes, b, off, width, value) {
  const view = new DataView(bytes.buffer);
  const at = b.body - b.start + off;
  if (width === 8) view.setBigUint64(at, BigInt(value));
  else view.setUint32(at, value);
}

const isV1 = (dv, b) => dv.getUint8(b.body) === 1;

function mvhdBox(dv, mvhd, duration) {
  const out = copyBox(dv, mvhd);
  if (isV1(dv, mvhd)) patch(out, mvhd, 24, 8, duration);
  else patch(out, mvhd, 16, 4, duration);
  new DataView(out.buffer).setUint32(out.length - 4, 3); // next_track_ID
  return out;
}

// Copied with its matrix and dimensions (a rotated clip stays rotated), and
// always enabled and in the movie: a source may leave its picture track
// disabled behind a cover image (Android's ClipCutterTest source does), and
// AVFoundation won't open a movie whose tracks are all disabled.
function tkhdBox(dv, tkhd, trackId, duration) {
  const out = copyBox(dv, tkhd);
  out[tkhd.body - tkhd.start + 3] |= 0x03;
  if (isV1(dv, tkhd)) {
    patch(out, tkhd, 20, 4, trackId);
    patch(out, tkhd, 28, 8, duration);
  } else {
    patch(out, tkhd, 12, 4, trackId);
    patch(out, tkhd, 20, 4, duration);
  }
  return out;
}

function mdhdBox(dv, mdhd, duration) {
  const out = copyBox(dv, mdhd);
  if (isV1(dv, mdhd)) patch(out, mdhd, 24, 8, duration);
  else patch(out, mdhd, 16, 4, duration);
  return out;
}

// [{ duration (movie ticks), mediaTime (media ticks, -1 empty) }]
function elstBox(edits) {
  const v1 = edits.some((e) => e.duration > 0xffffffff || e.mediaTime > 0x7fffffff);
  const rate = u32(0x00010000);
  const rows = edits.map((e) =>
    v1 ? concat([u64(e.duration), i64(e.mediaTime), rate]) : concat([u32(e.duration), i32(e.mediaTime), rate])
  );
  return box("edts", fullBox("elst", v1 ? 1 : 0, 0, u32(edits.length), ...rows));
}

const HANDLER_NAMES = { vide: "VideoHandler", soun: "SoundHandler" };

// [count, value] runs, for stts and ctts.
function runLength(values) {
  const runs = [];
  for (const v of values) {
    const last = runs[runs.length - 1];
    if (last && last[1] === v) last[0]++;
    else runs.push([1, v]);
  }
  return runs;
}

function stblBox(dv, track, out, chunkOffsets) {
  const sttsRuns = runLength(out.delta);
  const parts = [copyBox(dv, track.stsd), fullBox("stts", 0, 0, u32(sttsRuns.length, sttsRuns.flat()))];
  if (out.cto) {
    const runs = runLength(out.cto);
    parts.push(fullBox("ctts", 0, 0, u32(runs.length, runs.flat())));
  }
  if (out.sync) parts.push(fullBox("stss", 0, 0, u32(out.sync.length, out.sync)));
  const same = out.size.every((s) => s === out.size[0]);
  parts.push(fullBox("stsz", 0, 0, same ? u32(out.size[0] ?? 0, out.size.length) : u32(0, out.size.length, out.size)));
  const stsc = [];
  out.chunks.forEach((c, i) => {
    const last = stsc[stsc.length - 1];
    if (!last || last[1] !== c.count || last[2] !== c.sdi) stsc.push([i + 1, c.count, c.sdi]);
  });
  parts.push(fullBox("stsc", 0, 0, u32(stsc.length, stsc.flat())));
  parts.push(fullBox("stco", 0, 0, u32(chunkOffsets.length, chunkOffsets)));
  return box("stbl", ...parts);
}

function trakBox(dv, track, out, trackId, chunkOffsets) {
  const media = track.handler === "vide"
    ? fullBox("vmhd", 0, 1, new Uint8Array(8))
    : fullBox("smhd", 0, 0, new Uint8Array(4));
  const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
  const hdlr = fullBox(
    "hdlr", 0, 0, u32(0), te.encode(track.handler), new Uint8Array(12), te.encode(`${HANDLER_NAMES[track.handler]}\0`)
  );
  const mdia = box(
    "mdia",
    mdhdBox(dv, track.mdhd, out.mediaDuration),
    hdlr,
    box("minf", media, dinf, stblBox(dv, track, out, chunkOffsets))
  );
  return box("trak", tkhdBox(dv, track.tkhd, trackId, out.trackDuration), elstBox(out.edits), mdia);
}

// --- the cut -----------------------------------------------------------------------

// One track's kept samples [from, to) rewritten for the clip: durations,
// composition offsets shifted non-negative, sync indices, and its chunks — runs
// contiguous in the source, broken at a description change or CHUNK_S.
function keep(table, track, from, to) {
  const n = to - from;
  const delta = Array.from(table.delta.subarray(from, to));
  const size = Array.from(table.size.subarray(from, to));
  // Composition times relative to the first kept sample's decode time, lifted so
  // none is negative (a version 1 ctts can carry negative offsets).
  let cto = null;
  let lift = 0;
  if (table.cto) {
    let min = 0;
    for (let k = from; k < to; k++) min = Math.min(min, table.dts[k] - table.dts[from] + table.cto[k]);
    lift = -min;
    cto = [];
    for (let k = from; k < to; k++) cto.push(table.cto[k] + lift);
  }
  let sync = null;
  if (table.sync) {
    sync = [];
    for (let k = from; k < to; k++) if (table.sync[k]) sync.push(k - from + 1);
  }
  const chunks = [];
  const limit = CHUNK_S * track.timescale;
  for (let k = from; k < to; k++) {
    const c = chunks[chunks.length - 1];
    if (c && table.offset[k] === c.srcStart + c.bytes && table.sdi[k] === c.sdi && table.dts[k] - c.dts < limit) {
      c.count++;
      c.bytes += table.size[k];
    } else {
      chunks.push({ srcStart: table.offset[k], bytes: table.size[k], count: 1, sdi: table.sdi[k], dts: table.dts[k] });
    }
  }
  // Decode time on the movie timeline, for interleaving the two tracks' chunks.
  for (const c of chunks) c.at = track.edit.emptyS + (c.dts - track.edit.mediaTime) / track.timescale;
  const mediaDuration = delta.reduce((s, d) => s + d, 0);
  // The first kept sample's composition time in the clip's media timeline.
  const firstCt = cto ? cto[0] : 0;
  return { n, delta, size, cto, sync, chunks, mediaDuration, firstCt };
}

// Cuts `window` — clipWindow(lap, parsed.durationS) — out of `file`, a File or
// Blob of the source MP4. `lapStartS` is the lap's start on the same clock
// (window.startS + window.lapOffsetS when omitted). Answers
//   { blob, sizeBytes, durationMs, lapOffsetMs, video: "avc1", audio: "mp4a" | null }
// or throws ClipCutError — never anything else: a file that isn't an MP4, or
// whose tables run off the end of the moov, is "malformed". Reads only the
// `moov`. `maxBytes` is for the tests.
export async function cutClip(
  file,
  window,
  lapStartS = window ? window.startS + window.lapOffsetS : NaN,
  { maxBytes = MAX_CLIP_BYTES } = {}
) {
  try {
    return await cut(file, window, lapStartS, maxBytes);
  } catch (e) {
    if (e instanceof ClipCutError) throw e;
    throw new ClipCutError("malformed", e?.message);
  }
}

async function cut(file, window, lapStartS, maxBytes) {
  if (!window || !(window.endS > window.startS) || !Number.isFinite(lapStartS)) {
    throw new ClipCutError("window-outside", "No window to cut");
  }
  const { moov: dv, size: moovSize } = await readMoov(file);
  const root = { start: 0, body: 8, size: moovSize };
  const top = children(dv, root);
  if (top.some((b) => b.type === "mvex")) throw new ClipCutError("fragmented", "Fragmented MP4s can't be cut");
  const mvhd = top.find((b) => b.type === "mvhd");
  if (!mvhd) throw new ClipCutError("malformed", "No mvhd");
  const movieTs = isV1(dv, mvhd) ? dv.getUint32(mvhd.body + 20) : dv.getUint32(mvhd.body + 12);
  if (!movieTs) throw new ClipCutError("malformed", "No movie timescale");

  const tracks = top.filter((b) => b.type === "trak").map((t) => readTrack(dv, t, movieTs));
  const picked = pickTracks(tracks.map((t) => t ?? {}));
  if (picked.video == null) throw new ClipCutError("no-video", "No video track to cut");
  const vt = tracks[picked.video];
  const at = picked.audio == null ? null : tracks[picked.audio];

  // The video: from the last sync sample at or before the window's start (or,
  // when the window starts before the first one, the first inside it) to the
  // first sync sample at or after its end.
  const vTable = sampleTable(dv, vt.stbl);
  if (!vTable.count) throw new ClipCutError("no-video", "The video track is empty");
  const vPts = presentation(vTable, vt);
  const isSync = (i) => !vTable.sync || vTable.sync[i] === 1;
  let videoEnd = -Infinity;
  for (let i = 0; i < vTable.count; i++) videoEnd = Math.max(videoEnd, vPts[i] + vTable.delta[i] / vt.timescale);
  if (window.startS >= videoEnd) throw new ClipCutError("window-outside", "The window is past the end of the video");
  let i0 = -1;
  for (let i = 0; i < vTable.count; i++) if (isSync(i) && vPts[i] <= window.startS) i0 = i;
  if (i0 < 0) {
    for (let i = 0; i < vTable.count; i++) {
      if (isSync(i) && vPts[i] < window.endS) {
        i0 = i;
        break;
      }
    }
  }
  if (i0 < 0) throw new ClipCutError("no-keyframe", "No keyframe in or before the window");
  let i1 = vTable.count;
  for (let i = i0 + 1; i < vTable.count; i++) {
    if (isSync(i) && vPts[i] >= window.endS) {
      i1 = i;
      break;
    }
  }
  const v0 = vPts[i0];
  let vEnd = v0;
  for (let i = i0; i < i1; i++) vEnd = Math.max(vEnd, vPts[i] + vTable.delta[i] / vt.timescale);
  if (lapStartS < v0 || lapStartS >= vEnd) throw new ClipCutError("window-outside", "The lap isn't in the video");

  const video = keep(vTable, vt, i0, i1);
  video.edits = [{ duration: Math.round((vEnd - v0) * movieTs), mediaTime: video.firstCt }];
  video.trackDuration = video.edits[0].duration;

  // The sound: the frame holding the first kept frame's time to the frame
  // holding the last one's end, lined up with the picture by its edit.
  let audio = null;
  if (at) {
    const aTable = sampleTable(dv, at.stbl);
    const aPts = presentation(aTable, at);
    let j0 = 0;
    for (let j = 0; j < aTable.count; j++) if (aPts[j] <= v0) j0 = j;
    let j1 = -1;
    for (let j = j0; j < aTable.count; j++) if (aPts[j] < vEnd) j1 = j;
    if (j1 >= j0) {
      audio = keep(aTable, at, j0, j1 + 1);
      const a0 = aPts[j0];
      const aEnd = Math.min(vEnd, aPts[j1] + aTable.delta[j1] / at.timescale);
      const edits = [];
      if (a0 > v0) {
        edits.push({ duration: Math.round((a0 - v0) * movieTs), mediaTime: -1 });
        edits.push({ duration: Math.round((aEnd - a0) * movieTs), mediaTime: audio.firstCt });
      } else {
        edits.push({ duration: Math.round((aEnd - v0) * movieTs), mediaTime: audio.firstCt + Math.round((v0 - a0) * at.timescale) });
      }
      audio.edits = edits.filter((e) => e.duration > 0);
      audio.trackDuration = audio.edits.reduce((s, e) => s + e.duration, 0);
      if (!audio.edits.length) audio = null;
    }
  }

  // The mdat: both tracks' chunks interleaved by decode time (video first on a
  // tie), so the file reads front to back.
  const order = [
    ...video.chunks.map((c) => ({ c, track: 0 })),
    ...(audio ? audio.chunks.map((c) => ({ c, track: 1 })) : []),
  ].sort((a, b) => a.c.at - b.c.at || a.track - b.track);
  let mdatBytes = 0;
  for (const { c } of order) {
    c.rel = mdatBytes;
    mdatBytes += c.bytes;
  }

  const ftyp = box(
    "ftyp",
    te.encode("isom"),
    u32(0x200),
    te.encode("isomiso2mp41"),
    ...(vt.entry.startsWith("avc") ? [te.encode("avc1")] : vt.entry.startsWith("h") ? [te.encode("hvc1")] : [])
  );
  const movieDuration = Math.max(video.trackDuration, audio ? audio.trackDuration : 0);
  const buildMoov = (base) =>
    box(
      "moov",
      mvhdBox(dv, mvhd, movieDuration),
      trakBox(dv, vt, video, 1, video.chunks.map((c) => base + c.rel)),
      ...(audio ? [trakBox(dv, at, audio, 2, audio.chunks.map((c) => base + c.rel))] : [])
    );
  // stco entries are fixed-width, so the moov's size doesn't depend on them:
  // measure once, then write with the real base.
  const moovLen = buildMoov(0).length;
  const mdatHeader = u32(8 + mdatBytes);
  const base = ftyp.length + moovLen + 8;
  const moov = buildMoov(base);
  const sizeBytes = base + mdatBytes;
  if (8 + mdatBytes > 0xffffffff || sizeBytes > maxBytes) {
    throw new ClipCutError("too-large", "The clip would be over the size limit");
  }

  // The source ranges, merged where one chunk follows another on disk too.
  const slices = [];
  for (const { c } of order) {
    const last = slices[slices.length - 1];
    if (last && last.end === c.srcStart) last.end += c.bytes;
    else slices.push({ start: c.srcStart, end: c.srcStart + c.bytes });
  }
  const blob = new Blob(
    [ftyp, moov, concat([mdatHeader, te.encode("mdat")]), ...slices.map((s) => file.slice(s.start, s.end))],
    { type: "video/mp4" }
  );

  return {
    blob,
    sizeBytes,
    durationMs: Math.round((vEnd - v0) * 1000),
    lapOffsetMs: Math.round((lapStartS - v0) * 1000),
    video: vt.entry,
    audio: audio ? at.entry : null,
  };
}
