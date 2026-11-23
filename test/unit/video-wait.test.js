import { describe, expect, it } from "vitest";
import { WAIT_SHOW_MS, videoWaitHtml, waitingAfter } from "../../public/js/video-wait.js";

describe("waitingAfter", () => {
  it("waits on a load, a stall and a seek", () => {
    for (const type of ["loadstart", "waiting", "seeking"]) expect(waitingAfter(type)).toBe(true);
  });

  it("stops waiting once there is a frame, or nothing left to wait for", () => {
    for (const type of ["loadeddata", "canplay", "playing", "seeked", "error", "emptied"]) {
      expect(waitingAfter(type)).toBe(false);
    }
  });

  it("reads suspend as the end of a metadata-only load", () => {
    expect(waitingAfter("suspend", { readyState: 1, seeking: false })).toBe(false);
  });

  it("reads nothing into a suspend before the metadata, or during a seek", () => {
    expect(waitingAfter("suspend", { readyState: 0, seeking: false })).toBe(null);
    expect(waitingAfter("suspend", { readyState: 1, seeking: true })).toBe(null);
    expect(waitingAfter("suspend")).toBe(null);
  });

  it("ignores events that say nothing about the network", () => {
    for (const type of ["timeupdate", "progress", "pause", "play", "stalled", "loadedmetadata"]) {
      expect(waitingAfter(type)).toBe(null);
    }
  });
});

describe("videoWaitHtml", () => {
  it("is hidden until asked for, and says what it is", () => {
    expect(videoWaitHtml()).toContain(" hidden");
    expect(videoWaitHtml(true)).not.toContain(" hidden");
    expect(videoWaitHtml(true)).toContain("Loading video…");
  });

  it("waits long enough that a buffered seek draws nothing", () => {
    expect(WAIT_SHOW_MS).toBeGreaterThanOrEqual(200);
  });
});
