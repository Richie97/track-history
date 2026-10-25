import { describe, expect, it } from "vitest";
import {
  CLIP_PART_BYTES,
  CLIP_URL_TTL_S,
  MAX_CLIP_BYTES,
  clipFilename,
  clipKey,
  partCount,
  partSize,
  signClipUrl,
  validateClipCreate,
  verifyClipUrl,
} from "../../src/lib/clips";

describe("part arithmetic", () => {
  it("counts parts of CLIP_PART_BYTES, the last carrying the remainder", () => {
    expect(partCount(1)).toBe(1);
    expect(partCount(CLIP_PART_BYTES)).toBe(1);
    expect(partCount(CLIP_PART_BYTES + 1)).toBe(2);
    expect(partCount(150_000_000)).toBe(3);

    const size = 150_000_000;
    expect(partSize(size, 1)).toBe(CLIP_PART_BYTES);
    expect(partSize(size, 2)).toBe(CLIP_PART_BYTES);
    expect(partSize(size, 3)).toBe(size - 2 * CLIP_PART_BYTES);
    expect([1, 2, 3].reduce((sum, n) => sum + partSize(size, n)!, 0)).toBe(size);
    expect(partSize(CLIP_PART_BYTES, 1)).toBe(CLIP_PART_BYTES);
  });

  it("has no part 0, no part past the last and no fractional part", () => {
    expect(partSize(100, 0)).toBeNull();
    expect(partSize(100, 2)).toBeNull();
    expect(partSize(100, 1.5)).toBeNull();
    expect(partSize(100, Number.NaN)).toBeNull();
  });

  it("keys one user's clips under one prefix", () => {
    expect(clipKey(42, 7)).toBe("clips/42/7.mp4");
  });
});

describe("the signed URL", () => {
  const SECRET = "unit-secret";
  const NOW = 1_780_000_000_000;

  it("verifies for an hour, for the clip it was signed for", async () => {
    const { url, expires_at } = await signClipUrl(SECRET, "https://trackevolution.app", 9, NOW);
    expect(expires_at).toBe(Math.floor(NOW / 1000) * 1000 + CLIP_URL_TTL_S * 1000);
    const u = new URL(url);
    expect(u.pathname).toBe("/clips/9.mp4");
    const exp = u.searchParams.get("exp");
    const sig = u.searchParams.get("sig");
    expect(await verifyClipUrl(SECRET, 9, exp, sig, NOW)).toBe(true);
    expect(await verifyClipUrl(SECRET, 9, exp, sig, expires_at - 1)).toBe(true);
    expect(await verifyClipUrl(SECRET, 9, exp, sig, expires_at)).toBe(false);
    expect(await verifyClipUrl(SECRET, 10, exp, sig, NOW)).toBe(false);
    expect(await verifyClipUrl("other-secret", 9, exp, sig, NOW)).toBe(false);
    expect(await verifyClipUrl(SECRET, 9, String(Number(exp) + 1), sig, NOW)).toBe(false);
  });

  it("refuses anything malformed before computing a MAC", async () => {
    expect(await verifyClipUrl(SECRET, 9, null, "a".repeat(64), 0)).toBe(false);
    expect(await verifyClipUrl(SECRET, 9, "123", null, 0)).toBe(false);
    expect(await verifyClipUrl(SECRET, 9, "12x", "a".repeat(64), 0)).toBe(false);
    expect(await verifyClipUrl(SECRET, 9, "123", "A".repeat(64), 0)).toBe(false);
    expect(await verifyClipUrl(SECRET, 9, "123", "a".repeat(63), 0)).toBe(false);
  });

  it("marks a download URL, outside the signature", async () => {
    const { url } = await signClipUrl(SECRET, "https://x.example", 3, NOW, { download: true });
    expect(new URL(url).searchParams.get("dl")).toBe("1");
  });
});

describe("clipFilename", () => {
  it("is the track (with its layout), the day and the lap", () => {
    expect(clipFilename("Virginia International Raceway (Full)", "2026-05-01", 7)).toBe(
      "virginia-international-raceway-full-2026-05-01-lap-7.mp4"
    );
    expect(clipFilename("Autódromo Hermanos Rodríguez", "2026-10-30", 3)).toBe(
      "autodromo-hermanos-rodriguez-2026-10-30-lap-3.mp4"
    );
  });

  it("never puts a quote or a path in a header", () => {
    expect(clipFilename('a"b/../c', "2026-01-01", 1)).toBe("a-b-c-2026-01-01-lap-1.mp4");
    expect(clipFilename(null, "not a date", 2)).toBe("lap-lap-2.mp4");
    expect(clipFilename("日本", "2026-01-01", 2)).toBe("lap-2026-01-01-lap-2.mp4");
  });
});

describe("validateClipCreate", () => {
  const ok = { time_ms: 100_000, size_bytes: 150_000_000, duration_ms: 105_000, lap_offset_ms: 3_000 };

  it("passes a lap-sized clip through", () => {
    expect(validateClipCreate(ok)).toEqual({ ...ok, lap_num: null });
    // NS-50: the lap's place in its session, when the client names it.
    expect(validateClipCreate({ ...ok, lap_num: 3 })).toEqual({ ...ok, lap_num: 3 });
    expect(validateClipCreate({ ...ok, lap_num: null })).toEqual({ ...ok, lap_num: null });
    // A 600 s lap is inclusive, and its padding may take the clip past 600 s.
    expect(validateClipCreate({ ...ok, time_ms: 600_000, duration_ms: 605_000 })).toEqual({
      ...ok,
      lap_num: null,
      time_ms: 600_000,
      duration_ms: 605_000,
    });
  });

  it("names what's wrong", () => {
    expect(validateClipCreate(null)).toEqual({ error: "invalid time_ms" });
    expect(validateClipCreate({ ...ok, time_ms: 600_001 })).toEqual({ error: "clip too long" });
    expect(validateClipCreate({ ...ok, size_bytes: MAX_CLIP_BYTES + 1 })).toEqual({ error: "clip too large" });
    expect(validateClipCreate({ ...ok, size_bytes: 1.5 })).toEqual({ error: "invalid size_bytes" });
    expect(validateClipCreate({ ...ok, lap_offset_ms: 105_000 })).toEqual({ error: "invalid lap_offset_ms" });
    expect(validateClipCreate({ ...ok, duration_ms: 0 })).toEqual({ error: "invalid duration_ms" });
    for (const lap_num of [0, -2, 1.5, "2"]) expect(validateClipCreate({ ...ok, lap_num })).toEqual({ error: "invalid lap_num" });
  });
});
