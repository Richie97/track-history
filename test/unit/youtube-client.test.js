import { describe, expect, it } from "vitest";
import {
  YOUTUBE_CONNECT_TEXT,
  YOUTUBE_LINKS,
  YOUTUBE_PRIVACY,
  youtubeAccountLine,
  youtubeIsPending,
  youtubeOffer,
  youtubeRequestError,
  youtubeStatusLine,
} from "../../public/js/youtube.js";

// NS-46: the client's pure half. These cases port with it (YouTubeUpload in
// the iOS Kit and Android :core), beside contracts/logic/youtube.json.

const pro = { tier: "pro", source: "apple", expires_at: 1_800_000_000_000, auto_renew: true };
const free = { tier: "free", source: null, expires_at: null, auto_renew: null };
const me = (o = {}) => ({ youtube: { available: true, connected: true, account: "a@b.c", channel_title: null, ...o } });
const clip = (status) => ({ id: 1, youtube: status ? { status, video_id: null, url: null, privacy: "unlisted" } : null });

describe("youtubeOffer", () => {
  it("offers the upload to a connected Pro driver, and the connect step before that", () => {
    expect(youtubeOffer(clip(null), pro, me(), false)).toBe("upload");
    expect(youtubeOffer(clip(null), pro, me({ connected: false }), false)).toBe("connect");
  });

  it("follows the upload's state", () => {
    expect(youtubeOffer(clip("queued"), pro, me(), false)).toBe("pending");
    expect(youtubeOffer(clip("uploading"), pro, me(), false)).toBe("pending");
    expect(youtubeOffer(clip("done"), pro, me(), false)).toBe("done");
    expect(youtubeOffer(clip("failed"), pro, me(), false)).toBe("failed");
  });

  it("locks starting one for a free account, but never hides a link already made", () => {
    expect(youtubeOffer(clip(null), free, me(), false)).toBe("locked");
    expect(youtubeOffer(clip("failed"), free, me(), false)).toBe("locked");
    expect(youtubeOffer(clip("done"), free, me(), false)).toBe("done");
    expect(youtubeOffer(clip("uploading"), free, me(), false)).toBe("pending");
  });

  it("draws nothing while the feature is off, with no clip, or for a coach", () => {
    expect(youtubeOffer(clip("done"), pro, me({ available: false }), false)).toBe("none");
    expect(youtubeOffer(clip(null), pro, null, false)).toBe("none");
    expect(youtubeOffer(null, pro, me(), false)).toBe("none");
    for (const s of [null, "queued", "done", "failed"]) expect(youtubeOffer(clip(s), pro, me(), true)).toBe("none");
  });
});

describe("youtubeStatusLine", () => {
  it("says where the upload is, flooring the percentage under 100", () => {
    expect(youtubeStatusLine({ status: "queued", progress: 0, error: null })).toBe("Waiting to upload to YouTube");
    expect(youtubeStatusLine({ status: "uploading", progress: 0.4, error: null })).toBe("Uploading to YouTube · 40%");
    expect(youtubeStatusLine({ status: "uploading", progress: 0.996, error: null })).toBe("Uploading to YouTube · 99%");
    expect(youtubeStatusLine({ status: "uploading", progress: 1, error: null })).toBe("Uploading to YouTube · 99%");
    expect(youtubeStatusLine({ status: "done", privacy: "public" })).toBe("On YouTube · Public");
    expect(youtubeStatusLine({ status: "failed", error: "YouTube was disconnected." })).toBe("YouTube was disconnected.");
    expect(youtubeStatusLine({ status: "failed", error: null })).toBe("YouTube didn't accept the upload. Try again.");
    expect(youtubeStatusLine(null)).toBe("");
  });

  it("lets a waiting note win over the percentage", () => {
    const note = "Waiting for YouTube — uploads continue tomorrow.";
    expect(youtubeStatusLine({ status: "queued", progress: 0, error: note })).toBe(note);
    expect(youtubeStatusLine({ status: "uploading", progress: 0.5, error: note })).toBe(note);
  });

  it("polls only while on its way", () => {
    expect(["queued", "uploading", "done", "failed"].map((status) => youtubeIsPending({ status }))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

describe("the words", () => {
  it("names both of Google's documents in the consent text, and links them", () => {
    for (const l of YOUTUBE_LINKS) expect(YOUTUBE_CONNECT_TEXT).toContain(l.label);
    expect(YOUTUBE_CONNECT_TEXT).toContain("YouTube API Services");
    expect(YOUTUBE_PRIVACY.map((p) => p.value)).toEqual(["private", "unlisted", "public"]);
  });

  it("words the server's refusals", () => {
    expect(youtubeRequestError("youtube upload limit")).toBe("You can upload 10 videos to YouTube a day.");
    expect(youtubeRequestError("title must be at most 100 characters")).toBe("title must be at most 100 characters");
    expect(youtubeRequestError("")).toBe("YouTube didn't accept the upload. Try again.");
  });

  it("says which account Settings is connected to", () => {
    expect(youtubeAccountLine({ available: false })).toBe("");
    expect(youtubeAccountLine({ available: true, connected: true, account: "a@b.c", channel_title: "Fast" })).toBe(
      "Connected as a@b.c · Fast"
    );
    expect(youtubeAccountLine({ available: true, connected: false, account: "a@b.c" })).toMatch(/was removed/);
    expect(youtubeAccountLine({ available: true, connected: false, account: null })).toBe("Not connected.");
  });
});
