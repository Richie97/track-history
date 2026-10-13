import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, OfflineError, OFFLINE_UNCACHED } from "../../public/js/api.js";
import { cachePut, resetOfflineForTests } from "../../public/js/offline.js";

// What a GET says when the network is gone (#341): the cached copy if there is
// one, the shared offline sentence if there isn't, and the server's own words
// whenever the server answered.
describe("api GET offline", () => {
  beforeEach(async () => {
    await resetOfflineForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const offline = () => vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

  it("answers from the cache when the network is gone", async () => {
    await cachePut("/events", [{ id: 1 }]);
    offline();
    expect(await api("/events")).toEqual([{ id: 1 }]);
  });

  it("says the page was never saved, not the browser's words, when nothing is cached", async () => {
    offline();
    const err = await api("/events").catch((e) => e);
    expect(err).toBeInstanceOf(OfflineError);
    expect(err).not.toBeInstanceOf(ApiError);
    expect(err.message).toBe(OFFLINE_UNCACHED);
  });

  it("keeps the server's message when the server answered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: "not found" }) })
    );
    const err = await api("/events/9").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("not found");
  });
});

// `cache: false` (NS-45): a signed video URL expires in an hour, so the read
// comes from the server or not at all — never from the cache, never into it.
describe("api GET with cache: false", () => {
  beforeEach(async () => {
    await resetOfflineForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ignores a cached copy when the network is gone", async () => {
    await cachePut("/clips/1/url", { url: "https://stale.example", expires_at: 1 });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const err = await api("/clips/1/url", { cache: false }).catch((e) => e);
    expect(err).toBeInstanceOf(OfflineError);
  });

  it("answers from the server without caching what it said", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ url: "https://x.example/clips/2.mp4", expires_at: 5 }) })
    );
    expect(await api("/clips/2/url", { cache: false })).toEqual({ url: "https://x.example/clips/2.mp4", expires_at: 5 });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    // A plain read of the same path finds nothing cached.
    expect(await api("/clips/2/url").catch((e) => e)).toBeInstanceOf(OfflineError);
  });
});
