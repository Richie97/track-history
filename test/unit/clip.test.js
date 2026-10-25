import { describe, expect, it } from "vitest";
import {
  MAX_CLIP_S,
  PLAYBACK_LEAD_S,
  POST_ROLL_S,
  PRE_ROLL_S,
  EVERY_LAP_KINDS,
  clipCandidate,
  clipCandidates,
  clipFullText,
  clipRowTitle,
  everyLapFullText,
  everyLapOfferText,
  everyLapOfferTextWeb,
  lapVideoList,
  lapVideoStep,
  offersEveryLap,
  reviewClipBytes,
  reviewClipCount,
  clipOffer,
  clipOfferNote,
  clipOfferText,
  clipStorageLine,
  clipWindow,
  playbackStartMs,
  estimateClipBytes,
  fmtClipBytes,
} from "../../public/js/import/clip.js";
import { canSaveLapVideo } from "../../public/js/entitlement.js";

// NS-45: the reference rule both phones' clip ports are pinned to (through
// contracts/logic/lap-clips.json). These are the cases the ports carry too.

const lap = (timeMs, startT, endT, estimated = false) => ({ timeMs, startT, endT, estimated });
const PRO = { tier: "pro", source: "apple", expires_at: 1_800_000_000_000, auto_renew: true };
const FREE = { tier: "free", source: null, expires_at: null, auto_renew: null };
const GiB = 1024 ** 3;

describe("playbackStartMs", () => {
  it("opens PLAYBACK_LEAD_S ahead of the lap, never before the clip", () => {
    expect(playbackStartMs(3317)).toBe(3317 - PLAYBACK_LEAD_S * 1000);
    expect(playbackStartMs(PLAYBACK_LEAD_S * 1000)).toBe(0);
    expect(playbackStartMs(500)).toBe(0);
    expect(playbackStartMs(0)).toBe(0);
    expect(playbackStartMs(NaN)).toBe(0);
  });
});

describe("clipWindow", () => {
  it("pads the lap by PRE_ROLL_S and POST_ROLL_S", () => {
    expect(clipWindow(lap(100_000, 50, 150), 1000)).toEqual({
      startS: 50 - PRE_ROLL_S,
      endS: 150 + POST_ROLL_S,
      lapOffsetS: PRE_ROLL_S,
    });
  });

  it("clamps to the file, keeping the lap's offset honest", () => {
    expect(clipWindow(lap(99_000, 1, 100), 101)).toEqual({ startS: 0, endS: 101, lapOffsetS: 1 });
  });

  it("is inclusive at MAX_CLIP_S and null past it", () => {
    expect(clipWindow(lap(600_000, 10, 10 + MAX_CLIP_S), 2000)).not.toBeNull();
    expect(clipWindow(lap(600_001, 10, 10 + MAX_CLIP_S + 0.001), 2000)).toBeNull();
  });

  it("is null without a window inside the file", () => {
    expect(clipWindow(lap(1, null, 10), 100)).toBeNull();
    expect(clipWindow(lap(1, 10, 10), 100)).toBeNull();
    expect(clipWindow(lap(1, 20, 10), 100)).toBeNull();
    expect(clipWindow(lap(1, -1, 10), 100)).toBeNull();
    expect(clipWindow(lap(1, 10, 101), 100)).toBeNull();
    expect(clipWindow(null, 100)).toBeNull();
  });
});

describe("clipCandidate", () => {
  it("takes the best lap with a window, the lower lap number on a tie", () => {
    const parsed = {
      kind: "pdr",
      durationS: 500,
      laps: [lap(101_000, 10, 111), lap(100_000, 111, 211), lap(100_000, 211, 311)],
    };
    expect(clipCandidate(parsed).index).toBe(1);
  });

  it("skips a faster lap with no window", () => {
    const parsed = { kind: "gopro", durationS: 500, laps: [lap(90_000, null, null), lap(95_000, 10, 105)] };
    expect(clipCandidate(parsed).index).toBe(1);
  });

  it("keeps estimated laps", () => {
    const parsed = { kind: "pdr", durationS: 500, laps: [lap(99_000, 10, 109, true)] };
    expect(clipCandidate(parsed).index).toBe(0);
  });

  it("is null for anything that isn't a video", () => {
    for (const kind of ["live", "vbo", "trackprecision", undefined])
      expect(clipCandidate({ kind, durationS: 500, laps: [lap(99_000, 10, 109)] })).toBeNull();
    expect(clipCandidate(null)).toBeNull();
    expect(clipCandidate({ kind: "gopro", durationS: 500, laps: [] })).toBeNull();
  });
});

describe("estimateClipBytes", () => {
  it("is the file's bitrate over the window", () => {
    // 1 GB over 1000 s is 1 MB/s; a 100 s lap plus 7 s padding is 107 MB.
    expect(estimateClipBytes(lap(100_000, 100, 200), 1_000_000_000, 1000)).toBe(107_000_000);
    expect(estimateClipBytes(lap(100_000, 100, 200), 0, 1000)).toBeNull();
    expect(estimateClipBytes(lap(100_000, null, 200), 1e9, 1000)).toBeNull();
  });
});

describe("clipOffer", () => {
  const video = (include = true) => ({
    include,
    fileBytes: 1_000_000_000,
    parsed: { kind: "pdr", durationS: 1000, laps: [lap(100_000, 100, 200)] },
  });
  const vbo = { include: true, fileBytes: 10, parsed: { kind: "vbo", durationS: 1000, laps: [lap(100_000, 100, 200)] } };
  const room = { used_bytes: 0, quota_bytes: 20 * GiB, coach_count: 0 };

  it("offers the row on for Pro, locked for free, and not at all without a video", () => {
    expect(clipOffer([video()], PRO, room)).toBe("on");
    expect(clipOffer([video()], FREE, room)).toBe("locked");
    expect(clipOffer([video()], null, null)).toBe("locked");
    expect(clipOffer([vbo], PRO, room)).toBe("none");
    expect(clipOffer([video(false), vbo], PRO, room)).toBe("none");
    expect(clipOffer([], PRO, room)).toBe("none");
  });

  it("is full once this review's estimates would pass the quota — at it is fine", () => {
    expect(clipOffer([video()], PRO, { ...room, used_bytes: 20 * GiB - 107_000_000 })).toBe("on");
    expect(clipOffer([video()], PRO, { ...room, used_bytes: 20 * GiB - 106_999_999 })).toBe("full");
    expect(clipOffer([video(), video()], PRO, { ...room, used_bytes: 20 * GiB - 150_000_000 })).toBe("full");
    // A cached /me from before the field knows nothing is full.
    expect(clipOffer([video()], PRO, undefined)).toBe("on");
  });

  it("agrees with canSaveLapVideo", () => {
    expect(canSaveLapVideo(PRO)).toBe(true);
    expect(canSaveLapVideo(FREE)).toBe(false);
    expect(canSaveLapVideo(null)).toBe(false);
  });
});

describe("the row's words", () => {
  it("names coaches in one sentence, whatever the count", () => {
    expect(clipOfferNote({ coach_count: 0 })).toBe("");
    expect(clipOfferNote({ coach_count: 1 })).toBe("Your coaches can watch it too.");
    expect(clipOfferNote({ coach_count: 4 })).toBe("Your coaches can watch it too.");
    expect(clipOfferNote(null)).toBe("");
  });

  it("says the size when it has one", () => {
    expect(clipOfferText(150 * 1024 * 1024)).toBe("A clip of each session's fastest lap, about 150 MB each. Uploads on Wi-Fi.");
    expect(clipOfferText(null)).toBe("A clip of each session's fastest lap. Uploads on Wi-Fi.");
  });

  it("says storage is full, and Settings' line", () => {
    const clips = { used_bytes: Math.round(3.2 * GiB), quota_bytes: 20 * GiB, coach_count: 0 };
    expect(clipFullText(clips)).toBe("Your lap video storage is full (20 GB). Delete old clips from a lap's page.");
    expect(clipStorageLine(clips)).toBe("Lap videos: 3.2 GB of 20 GB");
    expect(clipStorageLine(null)).toBeNull();
  });

  it("formats bytes in MB below a gigabyte and GB to one decimal above", () => {
    expect(fmtClipBytes(0)).toBe("0 MB");
    expect(fmtClipBytes(1)).toBe("1 MB");
    expect(fmtClipBytes(150_000_000)).toBe("143 MB");
    expect(fmtClipBytes(GiB - 1)).toBe("1 GB");
    expect(fmtClipBytes(3.25 * GiB)).toBe("3.3 GB");
    expect(fmtClipBytes(20 * GiB)).toBe("20 GB");
  });
});

// NS-50: every full lap of a PDR import.
describe("every-lap clips", () => {
  const pdr = (laps, extra = {}) => ({ kind: "pdr", durationS: 1000, laps, ...extra });
  const item = (parsed, include = true, fileBytes = 1000 * 5_000_000) => ({ parsed, include, fileBytes });
  const laps = [lap(101_000, 10, 111), lap(100_000, 111, 211), lap(100_000, 211, 311), lap(102_000, 990, 1092)];

  it("names each lap by its place in the session", () => {
    expect(clipCandidate(pdr(laps))).toMatchObject({ index: 1, lapNum: 2 });
    expect(clipCandidates(pdr(laps), "best").map((c) => c.lapNum)).toEqual([2]);
    // The last lap runs past the file: no window, no clip.
    expect(clipCandidates(pdr(laps), "every").map((c) => c.lapNum)).toEqual([1, 2, 3]);
  });

  it("is PDR only: a GoPro keeps its best lap", () => {
    expect(EVERY_LAP_KINDS).toEqual(["pdr"]);
    const gopro = { kind: "gopro", durationS: 1000, laps };
    expect(clipCandidates(gopro, "every").map((c) => c.lapNum)).toEqual([2]);
    expect(clipCandidates({ kind: "vbo", durationS: 1000, laps }, "every")).toEqual([]);
    expect(clipCandidates(null, "every")).toEqual([]);
  });

  it("offers the choice only when it saves more", () => {
    expect(offersEveryLap([item(pdr(laps))])).toBe(true);
    expect(offersEveryLap([item(pdr(laps), false)])).toBe(false);
    expect(offersEveryLap([item(pdr([lap(100_000, 10, 110)]))])).toBe(false);
    expect(offersEveryLap([item({ kind: "gopro", durationS: 1000, laps })])).toBe(false);
  });

  it("counts and sizes the review per scope", () => {
    const items = [item(pdr(laps)), item({ kind: "gopro", durationS: 1000, laps }), item(pdr(laps), false)];
    expect(reviewClipCount(items, "best")).toBe(2);
    expect(reviewClipCount(items, "every")).toBe(4);
    // 5 MB/s over 101 + 7, 100 + 7 and 100 + 7 seconds, plus the GoPro's 107.
    expect(reviewClipBytes(items, "every")).toBe(5_000_000 * (108 + 107 + 107 + 107));
    expect(reviewClipBytes(items, "best")).toBe(5_000_000 * (107 + 107));
  });

  it("decides full against the picked scope", () => {
    const items = [item(pdr(laps))];
    const room = { used_bytes: 0, quota_bytes: 5_000_000 * 200, coach_count: 0 };
    expect(clipOffer(items, PRO, room)).toBe("on");
    expect(clipOffer(items, PRO, room, "best")).toBe("on");
    expect(clipOffer(items, PRO, room, "every")).toBe("full");
    expect(clipOffer(items, FREE, room, "every")).toBe("locked");
    expect(clipOffer([], PRO, room, "every")).toBe("none");
  });

  it("words the choice", () => {
    expect(everyLapOfferText(14, 1.3 * GiB)).toBe(
      "A clip of every full lap in each PDR session — 14 clips, about 1.3 GB in all. Uploads on Wi-Fi."
    );
    expect(everyLapOfferText(1, 0)).toBe("A clip of every full lap in each PDR session — 1 clip. Uploads on Wi-Fi.");
    expect(everyLapOfferTextWeb(3, 300 * 1024 * 1024)).toBe(
      "A clip of every full lap in each PDR session — 3 clips, about 300 MB in all. Uploads from this tab — keep it open until it's done."
    );
    expect(everyLapFullText({ used_bytes: 0, quota_bytes: 50 * GiB, coach_count: 0 })).toBe(
      "Every lap would go over your lap video storage (50 GB)."
    );
    expect(everyLapFullText(null)).toBe("Every lap would go over your lap video storage.");
    expect(clipRowTitle(true)).toBe("Save lap videos");
    expect(clipRowTitle(false)).toBe("Save best-lap video");
  });
});

// NS-50: the web's one player per session, stepping lap to lap.
describe("lapVideoList / lapVideoStep", () => {
  const laps = [
    { lap_num: 3, time_ms: 122_950, clip: { id: 13, lap_offset_ms: 4211 } },
    { lap_num: 1, time_ms: 157_240, clip: { id: 11, lap_offset_ms: 3929 } },
    { lap_num: 2, time_ms: 126_130, clip: null },
    { lap_num: 4, time_ms: 122_110, clip: { id: 14 } },
  ];

  it("lists the clipped laps in lap order and marks the session's best", () => {
    expect(lapVideoList(laps)).toEqual([
      { clipId: 11, lapNum: 1, timeMs: 157_240, offsetMs: 3929, best: false },
      { clipId: 13, lapNum: 3, timeMs: 122_950, offsetMs: 4211, best: false },
      { clipId: 14, lapNum: 4, timeMs: 122_110, offsetMs: 0, best: true },
    ]);
    // The best is the session's, even when that lap has no video.
    expect(lapVideoList([{ lap_num: 1, time_ms: 100, clip: null }, { lap_num: 2, time_ms: 200, clip: { id: 2 } }])[0].best).toBe(false);
    expect(lapVideoList([])).toEqual([]);
    expect(lapVideoList(null)).toEqual([]);
  });

  it("steps to the neighbouring lap with a video, null at the ends", () => {
    const list = lapVideoList(laps);
    expect(lapVideoStep(list, 13, -1).lapNum).toBe(1);
    expect(lapVideoStep(list, 13, 1).lapNum).toBe(4);
    expect(lapVideoStep(list, "11", -1)).toBeNull();
    expect(lapVideoStep(list, 14, 1)).toBeNull();
    expect(lapVideoStep(list, 99, 1)).toBeNull();
  });
});
