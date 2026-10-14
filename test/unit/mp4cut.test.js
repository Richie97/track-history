import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { boxes, child, children, fourcc, readMoov } from "../../public/js/import/mp4.js";
import { CHUNK_S, ClipCutError, MAX_CLIP_BYTES, cutClip, pickTracks, sampleTable } from "../../public/js/import/mp4cut.js";
import { MAX_CLIP_BYTES as SERVER_MAX_CLIP_BYTES } from "../../src/lib/clips.ts";
import { CUT_AUDIO_TS, CUT_VIDEO_TS, buildCutSourceMp4, cutSampleBytes } from "../fixtures/build.mjs";

const blob = (bytes) => new Blob([bytes], { type: "video/mp4" });
const bytesOf = async (b) => new Uint8Array(await b.arrayBuffer());

// The window a 4 s → 9 s lap would get, as clipWindow gives it. With 1.5 s
// GOPs the cut runs from the sync sample at 3.0 s to the one at 9.0 s.
const WINDOW = { startS: 4, endS: 9, lapOffsetS: 3 };
const LAP_START_S = 7;

// The clip read back: each track's handler, edit, timescale and samples (with
// their bytes), through the same table expander the cutter uses on the source.
async function readClip(clipBlob) {
  const { moov: dv, size } = await readMoov(clipBlob);
  const top = children(dv, { start: 0, body: 8, size });
  const all = await bytesOf(clipBlob);
  const tracks = top
    .filter((b) => b.type === "trak")
    .map((trak) => {
      const tkhd = child(dv, trak, "tkhd");
      const mdia = child(dv, trak, "mdia");
      const mdhd = child(dv, mdia, "mdhd");
      const stbl = child(dv, child(dv, mdia, "minf"), "stbl");
      const stsd = child(dv, stbl, "stsd");
      const elst = child(dv, child(dv, trak, "edts"), "elst");
      const edits = [];
      for (let e = 0; e < dv.getUint32(elst.body + 4); e++) {
        edits.push([dv.getUint32(elst.body + 8 + e * 12), dv.getInt32(elst.body + 12 + e * 12)]);
      }
      const table = sampleTable(dv, stbl);
      const samples = Array.from({ length: table.count }, (_, k) =>
        all.subarray(table.offset[k], table.offset[k] + table.size[k])
      );
      const stco = child(dv, stbl, "stco");
      return {
        chunks: dv.getUint32(stco.body + 4),
        handler: fourcc(dv, child(dv, mdia, "hdlr").body + 8),
        entry: boxes(dv, stsd.body + 8, stsd.start + stsd.size)[0].type,
        flags: dv.getUint32(tkhd.body) & 0xffffff,
        id: dv.getUint32(tkhd.body + 12),
        timescale: dv.getUint32(mdhd.body + 12),
        edits,
        table,
        samples,
      };
    });
  return { dv, top, tracks, all };
}

// Which source sample a clip sample is: the tag and decode index it carries.
const sampleId = (s) => [new TextDecoder().decode(s.subarray(0, 4)), new DataView(s.buffer, s.byteOffset).getUint32(4)];

const has = (bytes, text) => {
  const needle = new TextEncoder().encode(text);
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let k = 0; k < needle.length; k++) if (bytes[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
};

describe("pickTracks", () => {
  const v = (entry, objectType = null) => ({ handler: "vide", entry, objectType });
  const a = (entry) => ({ handler: "soun", entry });

  it("prefers H.264 / HEVC over a cover image ahead of it", () => {
    expect(pickTracks([v("jpeg"), v("avc1"), a("mp4a")])).toEqual({ video: 1, audio: 2 });
    expect(pickTracks([v("mp4v", 0x6c), v("hvc1")])).toEqual({ video: 1, audio: null });
  });

  it("takes another picture codec only when there is no H.264 / HEVC, and never a JPEG", () => {
    expect(pickTracks([v("jpeg"), v("mjpa"), v("mp4v", 0x20)])).toEqual({ video: 2, audio: null });
    expect(pickTracks([v("jpeg"), v("mp4v", 0x6c), a("mp4a")])).toEqual({ video: null, audio: 2 });
  });

  it("keeps only AAC sound", () => {
    expect(pickTracks([v("avc1"), a("ac-3"), a("mp4a")]).audio).toBe(2);
    expect(pickTracks([v("avc1"), a("Opus")]).audio).toBe(null);
  });
});

describe("cutClip", () => {
  it("keeps the picture from the sync sample before the window to the one at its end", async () => {
    const cut = await cutClip(blob(buildCutSourceMp4()), WINDOW, LAP_START_S);
    const { tracks } = await readClip(cut.blob);
    const video = tracks[0];
    expect(video.handler).toBe("vide");
    expect(video.entry).toBe("avc1");
    expect(video.timescale).toBe(CUT_VIDEO_TS);
    // Decode indices 90 (the I frame at 3.0 s) up to, not including, 270 (9.0 s).
    expect(video.samples.map((s) => sampleId(s)[1])).toEqual(Array.from({ length: 180 }, (_, k) => 90 + k));
    // The first sample is a sync sample, and so is every 45th after it.
    expect([...video.table.sync].flatMap((s, k) => (s ? [k] : []))).toEqual([0, 45, 90, 135]);
    expect(cut.durationMs).toBe(6000);
    expect(cut.video).toBe("avc1");
    expect(cut.audio).toBe("mp4a");
  });

  it("copies every sample byte for byte", async () => {
    const cut = await cutClip(blob(buildCutSourceMp4()), WINDOW, LAP_START_S);
    const { tracks } = await readClip(cut.blob);
    for (const t of tracks) {
      for (const s of t.samples) {
        const [tag, index] = sampleId(s);
        expect(["VIDE", "SOUN"]).toContain(tag);
        expect(s).toEqual(cutSampleBytes(tag, index, s.length));
      }
    }
  });

  it("measures the lap's offset through the B-frame edit list", async () => {
    // A lap at 7.0 s in a clip whose first frame is the 3.0 s keyframe is
    // 4.000 s in. Reading media time without the source's edit list (a shift
    // of two frames here) is how iOS's first cut came back 250 ms out.
    const cut = await cutClip(blob(buildCutSourceMp4()), WINDOW, LAP_START_S);
    expect(cut.lapOffsetMs).toBe(4000);
    const { tracks } = await readClip(cut.blob);
    const video = tracks[0];
    // The clip's edit starts presentation at the first kept frame.
    const firstCt = video.table.dts[0] + video.table.cto[0];
    expect(video.edits).toEqual([[6000, firstCt]]);
    // No composition time is before it except frames that follow it in decode
    // order — and in a closed GOP there are none.
    for (let k = 0; k < video.table.count; k++) {
      expect(video.table.dts[k] + video.table.cto[k]).toBeGreaterThanOrEqual(firstCt);
    }
  });

  it("measures the offset the same way without B-frames", async () => {
    const cut = await cutClip(blob(buildCutSourceMp4({ bframes: false })), WINDOW, LAP_START_S);
    expect(cut.lapOffsetMs).toBe(4000);
    const { tracks } = await readClip(cut.blob);
    expect(tracks[0].table.cto).toBe(null);
    expect(tracks[0].edits).toEqual([[6000, 0]]);
  });

  it("lines the sound up with the picture to within one frame", async () => {
    const cut = await cutClip(blob(buildCutSourceMp4()), WINDOW, LAP_START_S);
    const { tracks } = await readClip(cut.blob);
    const sound = tracks[1];
    expect(sound.handler).toBe("soun");
    // The source's frames sit at (1024 j − 2112) / 48000 s; the one holding
    // 3.0 s is j = 142, which starts 704 samples before the picture.
    const first = sampleId(sound.samples[0])[1];
    expect(first).toBe(142);
    expect(sound.edits).toEqual([[6000, 704]]);
    expect(704 / CUT_AUDIO_TS).toBeLessThan(1024 / CUT_AUDIO_TS);
    // …and runs to the frame holding the picture's end, 9.0 s.
    const last = sampleId(sound.samples[sound.samples.length - 1])[1];
    expect((1024 * last - 2112) / CUT_AUDIO_TS).toBeLessThan(9);
    expect((1024 * (last + 1) - 2112) / CUT_AUDIO_TS).toBeGreaterThanOrEqual(9);
  });

  it("starts the sound with an empty edit when it begins after the picture", async () => {
    const src = buildCutSourceMp4({ audioDelayS: 0.5, audioPriming: 0 });
    const cut = await cutClip(blob(src), { startS: 0, endS: 4, lapOffsetS: 1 }, 1);
    const { tracks } = await readClip(cut.blob);
    expect(cut.lapOffsetMs).toBe(1000);
    expect(tracks[1].edits).toEqual([[500, -1], [4000, 0]]);
    expect(sampleId(tracks[1].samples[0])[1]).toBe(0);
  });

  it("writes only picture and sound — no telemetry, cover image or location", async () => {
    const cut = await cutClip(blob(buildCutSourceMp4()), WINDOW, LAP_START_S);
    const { top, tracks, all } = await readClip(cut.blob);
    expect(tracks.map((t) => [t.handler, t.id])).toEqual([["vide", 1], ["soun", 2]]);
    expect(top.map((b) => b.type)).toEqual(["mvhd", "trak", "trak"]);
    const mdat = boxes(new DataView(all.buffer), 0, all.length).find((b) => b.type === "mdat");
    const header = all.subarray(0, mdat.body);
    for (const atom of ["udta", "meta", "uuid", "tref", "xyz", "ISO6709", "marl", "ctbx", "jpeg", "LEAD", "TELE"]) {
      expect(has(header, atom), atom).toBe(false);
    }
    // …and nothing but those two tracks' samples is in the mdat.
    for (const t of tracks) for (const s of t.samples) expect(["VIDE", "SOUN"]).toContain(sampleId(s)[0]);
  });

  it("puts the moov before the mdat and interleaves the tracks by time", async () => {
    const cut = await cutClip(blob(buildCutSourceMp4()), WINDOW, LAP_START_S);
    const all = await bytesOf(cut.blob);
    const dv = new DataView(all.buffer);
    expect(boxes(dv, 0, all.length).map((b) => b.type)).toEqual(["ftyp", "moov", "mdat"]);
    expect(fourcc(dv, 8)).toBe("isom");
    expect(has(all.subarray(0, 32), "avc1")).toBe(true);
    // The source interleaves every half second, so the clip's chunks are its
    // half-second runs (never longer than CHUNK_S), alternating track by track.
    const { tracks } = await readClip(cut.blob);
    expect(CHUNK_S).toBe(1);
    expect(tracks[0].chunks).toBe(12); // 6 s of picture
    expect(tracks[1].chunks).toBeGreaterThanOrEqual(12);
    const firstOf = (t) => t.table.offset[0];
    const lastOf = (t) => t.table.offset[t.table.count - 1];
    expect(firstOf(tracks[1])).toBeLessThan(lastOf(tracks[0]));
    expect(firstOf(tracks[0])).toBeLessThan(lastOf(tracks[1]));
    expect(cut.sizeBytes).toBe(all.length);
  });

  it("gives byte-identical output for the same file and window", async () => {
    const src = blob(buildCutSourceMp4());
    const a = await cutClip(src, WINDOW, LAP_START_S);
    const b = await cutClip(src, WINDOW, LAP_START_S);
    expect(a.sizeBytes).toBe(b.sizeBytes);
    expect(await bytesOf(a.blob)).toEqual(await bytesOf(b.blob));
  });

  it("reads 64-bit chunk offsets", async () => {
    const cut = await cutClip(blob(buildCutSourceMp4({ co64: true })), WINDOW, LAP_START_S);
    const { tracks } = await readClip(cut.blob);
    expect(tracks[0].samples.map((s) => sampleId(s)[1])[0]).toBe(90);
    for (const s of tracks[0].samples) expect(s).toEqual(cutSampleBytes("VIDE", sampleId(s)[1], s.length));
  });

  it("skips an mp4v cover image whose esds says JPEG", async () => {
    const cut = await cutClip(blob(buildCutSourceMp4({ lead: "mp4v-jpeg" })), WINDOW, LAP_START_S);
    expect(cut.video).toBe("avc1");
  });

  it("passes HEVC through, and says so in the ftyp", async () => {
    const cut = await cutClip(blob(buildCutSourceMp4({ video: "hvc1" })), WINDOW, LAP_START_S);
    expect(cut.video).toBe("hvc1");
    expect(has((await bytesOf(cut.blob)).subarray(0, 32), "hvc1")).toBe(true);
  });

  it("enables a picture track the source left disabled behind its cover image", async () => {
    const cut = await cutClip(blob(buildCutSourceMp4({ videoEnabled: false })), WINDOW, LAP_START_S);
    const { tracks } = await readClip(cut.blob);
    expect(tracks.map((t) => t.flags & 3)).toEqual([3, 3]);
  });

  it("carries the last sound duration forward when its stts stops one sample short", async () => {
    // The Corvette PDR's audio track does exactly this.
    const src = buildCutSourceMp4({ audioSttsShort: true });
    const cut = await cutClip(blob(src), { startS: 16, endS: 20, lapOffsetS: 1 }, 17);
    const { tracks } = await readClip(cut.blob);
    const ids = tracks[1].samples.map((s) => sampleId(s)[1]);
    expect(ids[ids.length - 1]).toBe(938); // the source's last frame
    expect(new Set(tracks[1].table.delta)).toEqual(new Set([1024]));
  });

  it("cuts a clip with no sound", async () => {
    const cut = await cutClip(blob(buildCutSourceMp4({ audio: false })), WINDOW, LAP_START_S);
    expect(cut.audio).toBe(null);
    expect((await readClip(cut.blob)).tracks).toHaveLength(1);
  });

  it("starts at the first keyframe inside a window that opens before any", async () => {
    // Sync samples only at 1.5, 4.5 and 7.5 s: a window from 0 s to 6 s runs
    // from the one at 1.5 s to the one at 7.5 s.
    const src = buildCutSourceMp4({ bframes: false, syncAt: [45, 135, 225] });
    const cut = await cutClip(blob(src), { startS: 0, endS: 6, lapOffsetS: 2 }, 2);
    expect(cut.lapOffsetMs).toBe(500);
    expect(cut.durationMs).toBe(6000);
  });

  it("runs to the end of the track when no keyframe follows the window", async () => {
    const cut = await cutClip(blob(buildCutSourceMp4()), { startS: 16, endS: 20, lapOffsetS: 1 }, 17);
    expect(cut.durationMs).toBe(5000); // 15.0 s → 20.0 s
    expect(cut.lapOffsetMs).toBe(2000);
  });

  describe("refuses", () => {
    const reason = async (promise) => {
      try {
        await promise;
      } catch (e) {
        expect(e).toBeInstanceOf(ClipCutError);
        return e.reason;
      }
      throw new Error("expected a ClipCutError");
    };

    it("a fragmented MP4", async () => {
      expect(await reason(cutClip(blob(buildCutSourceMp4({ fragmented: true })), WINDOW, LAP_START_S))).toBe("fragmented");
    });

    it("a file with no picture but a cover image", async () => {
      expect(await reason(cutClip(blob(buildCutSourceMp4({ video: null })), WINDOW, LAP_START_S))).toBe("no-video");
    });

    it("a window with no keyframe in or before it", async () => {
      const src = blob(buildCutSourceMp4({ bframes: false, syncAt: [590] }));
      expect(await reason(cutClip(src, { startS: 2, endS: 6, lapOffsetS: 1 }, 3))).toBe("no-keyframe");
    });

    it("a window past the end of the video", async () => {
      expect(await reason(cutClip(blob(buildCutSourceMp4()), { startS: 25, endS: 30, lapOffsetS: 3 }, 28))).toBe("window-outside");
    });

    it("a lap the video doesn't reach", async () => {
      // A telemetry clock that ran past the video: Android's "lap isn't in the video".
      expect(await reason(cutClip(blob(buildCutSourceMp4()), { startS: 18, endS: 25, lapOffsetS: 3 }, 21))).toBe("window-outside");
    });

    it("no window at all", async () => {
      expect(await reason(cutClip(blob(buildCutSourceMp4()), null))).toBe("window-outside");
    });

    it("a file that isn't an MP4, or whose moov is cut short", async () => {
      expect(await reason(cutClip(blob(new TextEncoder().encode("not a video at all")), WINDOW))).toBe("malformed");
      const src = buildCutSourceMp4();
      const truncated = src.subarray(0, src.length - 2000);
      expect(await reason(cutClip(blob(truncated), WINDOW, LAP_START_S))).toBe("malformed");
    });

    it("a clip over the size limit", async () => {
      const src = blob(buildCutSourceMp4());
      expect(await reason(cutClip(src, WINDOW, LAP_START_S, { maxBytes: 10_000 }))).toBe("too-large");
    });
  });

  it("caps a clip at the server's MAX_CLIP_BYTES", () => {
    expect(MAX_CLIP_BYTES).toBe(SERVER_MAX_CLIP_BYTES);
  });

  it("reads only the moov: the clip's samples are slices of the source", async () => {
    // A Blob that counts the bytes read out of it. The cutter's reads are the
    // top-level box headers and the moov; the samples go into the clip as
    // slices, unread.
    let read = 0;
    class Counting extends Blob {
      slice(...args) {
        return new Counting([super.slice(...args)]);
      }
      arrayBuffer() {
        read += this.size;
        return super.arrayBuffer();
      }
    }
    const bytes = buildCutSourceMp4({ durationS: 60 });
    const cut = await cutClip(new Counting([bytes]), WINDOW, LAP_START_S);
    const { size: moovSize } = await readMoov(blob(bytes));
    expect(read).toBeLessThanOrEqual(moovSize + 3 * 16);
    expect(cut.sizeBytes).toBeGreaterThan(read);
    // …and the clip still holds the right samples.
    const { tracks } = await readClip(cut.blob);
    expect(sampleId(tracks[0].samples[0])).toEqual(["VIDE", 90]);
  });
});

// The decode check: a real H.264 + AAC file (Android's instrumented-test
// source — an MJPEG cover track ahead of the picture, 1.48 s keyframes, a
// `loci` box) cut and handed to ffmpeg. CI may have no ffmpeg; the test is
// skipped then, as promo/'s render is.
const SOURCE = new URL("../../apps/android/app/src/androidTest/assets/clip-source.mp4", import.meta.url).pathname;
const haveFfmpeg = spawnSync("ffprobe", ["-version"]).status === 0 && spawnSync("ffmpeg", ["-version"]).status === 0;

describe.skipIf(!haveFfmpeg)("cutClip on real H.264 (needs ffmpeg)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mp4cut-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const probe = (args) => spawnSync("ffprobe", ["-v", "error", ...args], { encoding: "utf8" });

  it("makes a clip ffmpeg decodes clean, with one h264 and one aac stream and nothing else", async () => {
    const src = readFileSync(SOURCE);
    const cut = await cutClip(blob(src), { startS: 5, endS: 12, lapOffsetS: 3 }, 8);
    const out = join(dir, "clip.mp4");
    writeFileSync(out, await bytesOf(cut.blob));

    // Keyframes every 1.48 s: the cut starts at 4.44 s, so the lap is 3.56 s in.
    expect(cut.lapOffsetMs).toBe(3560);
    const streams = probe(["-show_entries", "stream=codec_name,codec_type", "-of", "csv=p=0", out]).stdout.trim().split("\n");
    expect(streams).toEqual(["h264,video", "aac,audio"]);
    const tags = probe(["-show_entries", "format_tags", "-of", "json", out]).stdout;
    expect(tags).not.toMatch(/location|xyz/i);
    const decode = spawnSync("ffmpeg", ["-v", "error", "-i", out, "-f", "null", "-"], { encoding: "utf8" });
    expect(decode.status).toBe(0);
    expect(decode.stderr).toBe("");

    // The picture's packets are the source's, byte for byte, in order.
    const hashes = (file, sel) =>
      probe(["-select_streams", sel, "-show_entries", "packet=data_hash", "-show_data_hash", "MD5", "-of", "csv=p=0", file]).stdout.trim().split("\n");
    const mine = hashes(out, "v:0");
    const theirs = hashes(SOURCE, "v:1");
    const at = theirs.indexOf(mine[0]);
    expect(theirs.slice(at, at + mine.length)).toEqual(mine);
  });
});
