import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION,
  MAX_RESTARTS,
  YT_CHUNK_BYTES,
  YT_CHUNK_MULTIPLE,
  chunkLength,
  clipYouTube,
  contentRange,
  dailyBudget,
  dateWords,
  decryptSecret,
  defaultTitle,
  defaultVideoMetadata,
  encryptSecret,
  googleErrorReason,
  lapTimeText,
  offsetText,
  pacificDay,
  parseResumeRange,
  retryDelaySeconds,
  sanitizeVideoMetadata,
  secondsToPacificMidnight,
  statusRange,
  uploadView,
  videoResource,
  youtubeAvailable,
  youtubeErrorText,
} from "../../src/lib/youtube";

// 32 / 16 bytes of one value, base64.
const keyOf = (byte: number, n = 32) => btoa(String.fromCharCode(...new Uint8Array(n).fill(byte)));
const KEY = keyOf(7);

describe("the draft", () => {
  const base = {
    track: "Virginia International Raceway (Full)",
    lapTimeMs: 122_110,
    sessionNumber: 3,
    date: "2026-06-14",
    car: "Corvette C7",
    lapOffsetMs: 3_317,
  };

  it("matches the mock-up", () => {
    expect(defaultVideoMetadata(base)).toEqual({
      title: "Virginia International Raceway (Full) · 2:02.110 · Corvette C7",
      description:
        "Best lap of Session 3 at Virginia International Raceway (Full), 14 June 2026.\nLap starts at 0:03.\n\n" + ATTRIBUTION,
      privacy: "unlisted",
    });
  });

  it("names the session by its label when it has one", () => {
    expect(defaultVideoMetadata({ ...base, sessionLabel: "Afternoon run" }).description).toMatch(
      /^Best lap of Afternoon run at /
    );
  });

  it("leaves the car out when there isn't one, and the offset line when the lap starts at 0", () => {
    const d = defaultVideoMetadata({ ...base, car: null, lapOffsetMs: 0 });
    expect(d.title).toBe("Virginia International Raceway (Full) · 2:02.110");
    expect(d.description).not.toContain("Lap starts");
  });

  it("cuts the track first, then the car, to stay within 100 characters", () => {
    const longTrack = "A".repeat(120);
    const t1 = defaultTitle({ track: longTrack, lapTimeMs: 90_000, car: "Corvette C7" });
    expect([...t1].length).toBe(100);
    expect(t1.endsWith(" · 1:30.000 · Corvette C7")).toBe(true);
    expect(t1).toContain("…");

    // A car so long that even a 12-character track can't make room: the car
    // is cut too.
    const t2 = defaultTitle({ track: longTrack, lapTimeMs: 90_000, car: "B".repeat(120) });
    expect([...t2].length).toBeLessThanOrEqual(100);
    expect(t2).toContain(" · 1:30.000 · ");
    expect(t2.startsWith("A".repeat(11) + "…")).toBe(true);
  });

  it("keeps < and > out of what it writes, so the sanitizer never refuses a draft", () => {
    const d = defaultVideoMetadata({ ...base, track: "<Thunderhill>", car: "M3 <E46>" });
    expect(sanitizeVideoMetadata(d)).toEqual({ meta: d });
  });

  it("formats the pieces", () => {
    expect(lapTimeText(122_110)).toBe("2:02.110");
    expect(lapTimeText(59_999)).toBe("0:59.999");
    expect(offsetText(3_999)).toBe("0:03");
    expect(offsetText(65_000)).toBe("1:05");
    expect(dateWords("2026-01-05")).toBe("5 January 2026");
    expect(dateWords("2026-13-05")).toBeNull();
    expect(dateWords(null)).toBeNull();
  });
});

describe("sanitizeVideoMetadata", () => {
  const ok = { title: "  VIR · 2:02.110  ", description: "Fast.", privacy: "public" };

  it("trims the title and passes the rest", () => {
    expect(sanitizeVideoMetadata(ok)).toEqual({ meta: { title: "VIR · 2:02.110", description: "Fast.", privacy: "public" } });
  });

  it("names each rule it refuses", () => {
    expect(sanitizeVideoMetadata(null)).toEqual({ error: "title, description and privacy are required" });
    expect(sanitizeVideoMetadata({ ...ok, title: "   " })).toEqual({ error: "title is required" });
    expect(sanitizeVideoMetadata({ ...ok, title: "x".repeat(101) })).toEqual({
      error: "title must be at most 100 characters",
    });
    // 100 code points is fine, even when they are multi-byte.
    expect("meta" in sanitizeVideoMetadata({ ...ok, title: "é".repeat(100) })).toBe(true);
    expect(sanitizeVideoMetadata({ ...ok, title: "a\nb" })).toEqual({ error: "title must be one line" });
    expect(sanitizeVideoMetadata({ ...ok, description: 5 })).toEqual({ error: "description must be text" });
    // Bytes, not characters: 2,501 two-byte characters is 5,002 bytes.
    expect(sanitizeVideoMetadata({ ...ok, description: "é".repeat(2501) })).toEqual({
      error: "description must be at most 5000 bytes",
    });
    expect(sanitizeVideoMetadata({ ...ok, title: "a <b>" })).toEqual({ error: "title and description can't contain < or >" });
    expect(sanitizeVideoMetadata({ ...ok, description: "1 > 0" })).toEqual({
      error: "title and description can't contain < or >",
    });
    expect(sanitizeVideoMetadata({ ...ok, privacy: "friends" })).toEqual({
      error: "privacy must be private, unlisted or public",
    });
  });

  it("takes a missing description as empty", () => {
    expect(sanitizeVideoMetadata({ title: "t", privacy: "private" })).toEqual({
      meta: { title: "t", description: "", privacy: "private" },
    });
  });
});

describe("the video resource", () => {
  it("is Autos & Vehicles, not made for kids, tagged, and carries no location", () => {
    const r = videoResource({ title: "t", description: "d", privacy: "unlisted" }, { track: "VIR", car: "C7" });
    expect(r).toEqual({
      snippet: { title: "t", description: "d", categoryId: "2", tags: ["track day", "HPDE", "VIR", "C7"] },
      status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
    });
    expect(JSON.stringify(r)).not.toMatch(/recordingDetails|location/i);
    expect(videoResource({ title: "t", description: "", privacy: "public" }, { track: "", car: null }).snippet.tags).toEqual([
      "track day",
      "HPDE",
    ]);
  });
});

describe("resumable ranges", () => {
  it("chunks are a multiple of 256 KiB", () => {
    expect(YT_CHUNK_BYTES % YT_CHUNK_MULTIPLE).toBe(0);
    expect(MAX_RESTARTS).toBe(2);
  });

  it("cuts a 150 MB clip into five chunks", () => {
    const total = 150_000_000;
    const lengths: number[] = [];
    for (let at = 0; at < total; ) {
      const n = chunkLength(at, total);
      lengths.push(n);
      at += n;
    }
    expect(lengths).toHaveLength(5);
    expect(lengths.slice(0, 4).every((n) => n === YT_CHUNK_BYTES)).toBe(true);
    expect(chunkLength(total, total)).toBe(0);
  });

  it("writes Content-Range and reads YouTube's Range", () => {
    expect(contentRange(0, 1024, 3000)).toBe("bytes 0-1023/3000");
    expect(contentRange(1024, 1976, 3000)).toBe("bytes 1024-2999/3000");
    expect(statusRange(3000)).toBe("bytes */3000");
    expect(parseResumeRange("bytes=0-33554431")).toBe(33554431);
    expect(parseResumeRange(" bytes=0-0 ")).toBe(0);
    // No header: nothing yet. A range not starting at 0 is not trusted.
    expect(parseResumeRange(null)).toBe(-1);
    expect(parseResumeRange("bytes=100-200")).toBe(-1);
    expect(parseResumeRange("garbage")).toBe(-1);
  });

  it("backs off from 30 s, doubling, to an hour", () => {
    expect([1, 2, 3, 7, 8, 9, 20].map(retryDelaySeconds)).toEqual([30, 60, 120, 1920, 3600, 3600, 3600]);
  });
});

describe("Pacific midnight", () => {
  const at = (iso: string) => Date.parse(iso);

  it("on an ordinary day", () => {
    // 2026-06-14 23:00 PDT = 06:00 UTC on the 15th.
    expect(secondsToPacificMidnight(at("2026-06-15T06:00:00Z"))).toBe(3600);
    expect(pacificDay(at("2026-06-15T06:00:00Z"))).toBe("2026-06-14");
    expect(pacificDay(at("2026-06-15T07:00:00Z"))).toBe("2026-06-15");
  });

  it("across spring forward (8 March 2026, a 23-hour day)", () => {
    // 00:30 PST on the 8th → midnight PDT on the 9th is 22.5 h later.
    expect(secondsToPacificMidnight(at("2026-03-08T08:30:00Z"))).toBe(22.5 * 3600);
    // 23:00 PST on the 7th → one hour.
    expect(secondsToPacificMidnight(at("2026-03-08T07:00:00Z"))).toBe(3600);
  });

  it("across fall back (1 November 2026, a 25-hour day)", () => {
    // 00:30 PDT on the 1st → midnight PST on the 2nd is 24.5 h later.
    expect(secondsToPacificMidnight(at("2026-11-01T07:30:00Z"))).toBe(24.5 * 3600);
    // 23:00 PST on the 1st → one hour.
    expect(secondsToPacificMidnight(at("2026-11-02T07:00:00Z"))).toBe(3600);
  });

  it("is never zero", () => {
    expect(secondsToPacificMidnight(at("2026-06-15T07:00:00Z"))).toBe(86400);
    expect(secondsToPacificMidnight(at("2026-06-15T06:59:59.900Z"))).toBe(1);
  });
});

describe("secrets at rest", () => {
  it("round-trips, with a fresh IV every time", async () => {
    const a = await encryptSecret(KEY, "1//refresh-token");
    const b = await encryptSecret(KEY, "1//refresh-token");
    expect(a).not.toBe(b);
    expect(a).not.toContain("refresh");
    expect(a).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await decryptSecret(KEY, a)).toBe("1//refresh-token");
  });

  it("refuses anything not sealed under this key", async () => {
    const sealed = await encryptSecret(KEY, "secret");
    const other = keyOf(9);
    await expect(decryptSecret(other, sealed)).rejects.toThrow();
    const [iv, ct] = sealed.split(".");
    // Flip the first character, which always changes the bytes (unlike the
    // last, whose low bits base64 may drop).
    const flipped = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    await expect(decryptSecret(KEY, `${iv}.${flipped}`)).rejects.toThrow();
    await expect(decryptSecret(KEY, "plaintext")).rejects.toThrow();
    await expect(encryptSecret(keyOf(0, 16), "x")).rejects.toThrow(/32 bytes/);
  });
});

describe("errors in our words", () => {
  it("maps YouTube's reasons, and an unknown one to the generic sentence", () => {
    expect(youtubeErrorText("invalidTitle")).toMatch(/title/);
    expect(youtubeErrorText("youtubeSignupRequired")).toMatch(/no YouTube channel/);
    expect(youtubeErrorText("somethingNew")).toBe("YouTube didn't accept the upload. Try again.");
    expect(youtubeErrorText(null)).toBe("YouTube didn't accept the upload. Try again.");
  });

  it("reads the reason out of a Google error body", () => {
    expect(googleErrorReason({ error: { errors: [{ reason: "quotaExceeded" }], status: "PERMISSION_DENIED" } })).toBe(
      "quotaExceeded"
    );
    expect(googleErrorReason({ error: { status: "PERMISSION_DENIED" } })).toBe("PERMISSION_DENIED");
    expect(googleErrorReason({ error: "invalid_grant" })).toBe("invalid_grant");
    expect(googleErrorReason(null)).toBeNull();
  });
});

describe("the feature flag", () => {
  const env = {
    YOUTUBE_CLIENT_ID: "id",
    YOUTUBE_CLIENT_SECRET: "secret",
    YOUTUBE_TOKEN_KEY: KEY,
    YOUTUBE_QUEUE: {} as Queue<{ upload_id: number }>,
  };

  it("needs all three secrets and the queue", () => {
    expect(youtubeAvailable(env, "a@example.com")).toBe(true);
    for (const k of Object.keys(env) as (keyof typeof env)[])
      expect(youtubeAvailable({ ...env, [k]: undefined }, "a@example.com")).toBe(false);
  });

  it("narrows to the allowlist while it is set, ignoring case and spaces", () => {
    const listed = { ...env, YOUTUBE_ALLOWLIST: " Reviewer@Google.com , me@example.com" };
    expect(youtubeAvailable(listed, "reviewer@google.com")).toBe(true);
    expect(youtubeAvailable(listed, "ME@example.com")).toBe(true);
    expect(youtubeAvailable(listed, "someone@example.com")).toBe(false);
    expect(youtubeAvailable(listed, null)).toBe(false);
    expect(youtubeAvailable({ ...env, YOUTUBE_ALLOWLIST: " , " }, "anyone@example.com")).toBe(true);
  });

  it("reads the daily budget", () => {
    expect(dailyBudget({})).toBeNull();
    expect(dailyBudget({ YOUTUBE_DAILY_BUDGET: "" })).toBeNull();
    expect(dailyBudget({ YOUTUBE_DAILY_BUDGET: "6" })).toBe(6);
    expect(dailyBudget({ YOUTUBE_DAILY_BUDGET: "0" })).toBe(0);
    expect(dailyBudget({ YOUTUBE_DAILY_BUDGET: "lots" })).toBeNull();
  });
});

describe("the lap page's view", () => {
  it("reports progress, and the link only once done", () => {
    const row = { status: "uploading" as const, privacy: "unlisted" as const, video_id: null, bytes_sent: 400, error: null };
    expect(uploadView(row, 1000)).toEqual({ status: "uploading", progress: 0.4, privacy: "unlisted", url: null, error: null });
    expect(uploadView({ ...row, status: "done", video_id: "abc", bytes_sent: 0 }, 1000)).toEqual({
      status: "done",
      progress: 1,
      privacy: "unlisted",
      url: "https://youtu.be/abc",
      error: null,
    });
    expect(clipYouTube({ status: "failed", privacy: "public", video_id: "stale" })).toEqual({
      status: "failed",
      video_id: null,
      url: null,
      privacy: "public",
    });
  });
});
