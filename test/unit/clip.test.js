import { describe, expect, it } from "vitest";
import {
  MAX_CLIP_S,
  POST_ROLL_S,
  PRE_ROLL_S,
  clipCandidate,
  clipFullText,
  clipOffer,
  clipOfferNote,
  clipOfferText,
  clipStorageLine,
  clipWindow,
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
    // 1 GB over 1000 s is 1 MB/s; a 100 s lap plus 5 s padding is 105 MB.
    expect(estimateClipBytes(lap(100_000, 100, 200), 1_000_000_000, 1000)).toBe(105_000_000);
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
    expect(clipOffer([video()], PRO, { ...room, used_bytes: 20 * GiB - 105_000_000 })).toBe("on");
    expect(clipOffer([video()], PRO, { ...room, used_bytes: 20 * GiB - 104_999_999 })).toBe("full");
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
