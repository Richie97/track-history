import { afterEach, describe, expect, it, vi } from "vitest";
import { platform } from "../../public/js/platform.js";
import { clearOffline } from "../../public/js/offline.js";
import { initRemoteRecorder, localTodayIso, pickRecordingEvent } from "../../public/js/record/remote.js";
import { isRecording, stopRecording } from "../../public/js/record/ui.js";

describe("localTodayIso", () => {
  it("formats the local calendar date as YYYY-MM-DD", () => {
    expect(localTodayIso(new Date(2026, 6, 21, 9, 30))).toBe("2026-07-21");
    expect(localTodayIso(new Date(2026, 0, 3, 23, 59))).toBe("2026-01-03");
  });
});

describe("pickRecordingEvent", () => {
  const ev = (id, start_date, days) => ({ id, start_date, days, track_name: `Track ${id}` });

  it("picks the event happening today", () => {
    const events = [ev("a", "2026-07-25", 1), ev("b", "2026-07-21", 1), ev("c", "2026-07-01", 1)];
    expect(pickRecordingEvent(events, "2026-07-21")?.id).toBe("b");
  });

  it("covers multi-day events through their last day", () => {
    const weekend = [ev("a", "2026-07-19", 3)];
    expect(pickRecordingEvent(weekend, "2026-07-19")?.id).toBe("a");
    expect(pickRecordingEvent(weekend, "2026-07-21")?.id).toBe("a");
    expect(pickRecordingEvent(weekend, "2026-07-22")).toBeNull();
  });

  it("never guesses when no event covers today", () => {
    expect(pickRecordingEvent([ev("a", "2026-07-20", 1), ev("b", "2026-07-22", 1)], "2026-07-21")).toBeNull();
    expect(pickRecordingEvent([], "2026-07-21")).toBeNull();
    expect(pickRecordingEvent(null, "2026-07-21")).toBeNull();
  });

  it("breaks overlaps toward the most recently started event", () => {
    const events = [ev("long", "2026-07-18", 7), ev("today", "2026-07-21", 1)];
    expect(pickRecordingEvent(events, "2026-07-21")?.id).toBe("today");
  });

  it("treats missing/invalid days as a one-day event and spans month ends", () => {
    expect(pickRecordingEvent([{ id: "x", start_date: "2026-07-21" }], "2026-07-21")?.id).toBe("x");
    expect(pickRecordingEvent([{ id: "x", start_date: "2026-07-21" }], "2026-07-22")).toBeNull();
    expect(pickRecordingEvent([ev("m", "2026-07-31", 2)], "2026-08-01")?.id).toBe("m");
  });
});

describe("initRemoteRecorder", () => {
  const today = localTodayIso();

  function fakeShell() {
    const watcher = { started: 0, stopped: 0 };
    platform.bgLocation = {
      start: async () => {
        watcher.started++;
      },
      stop: async () => {
        watcher.stopped++;
      },
      openSettings: () => {},
    };
    return watcher;
  }

  afterEach(async () => {
    await stopRecording();
    await clearOffline(); // GETs land in the offline cache even in Node
    platform.bgLocation = null;
    platform.recorderRemote = null;
    platform.onRecorderState = null;
    vi.unstubAllGlobals();
  });

  it("is a no-op without a native GPS watcher", () => {
    platform.bgLocation = null;
    initRemoteRecorder();
    expect(platform.recorderRemote).toBeNull();
  });

  it("starts a recording into today's event and reports state to the shell", async () => {
    const watcher = fakeShell();
    const events = [{ id: 7, start_date: today, days: 1, track_name: "VIR (Full)" }];
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => events }));
    const states = [];
    platform.onRecorderState = (s) => states.push(s);

    initRemoteRecorder();
    const res = await platform.recorderRemote.start();

    expect(res).toEqual({ ok: true, eventId: 7 });
    expect(isRecording()).toBe(true);
    expect(watcher.started).toBe(1);
    expect(states.at(-1)).toMatchObject({ recording: true, eventId: 7, eventLabel: "VIR (Full)" });

    await platform.recorderRemote.stop();
    expect(isRecording()).toBe(false);
    expect(watcher.stopped).toBe(1);
    expect(states.at(-1)).toMatchObject({ recording: false, eventId: null });
  });

  it("refuses with no-event when nothing is scheduled today", async () => {
    fakeShell();
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: 1, start_date: "2000-01-01", days: 1 }],
    }));
    initRemoteRecorder();
    expect(await platform.recorderRemote.start()).toEqual({ ok: false, reason: "no-event" });
    expect(isRecording()).toBe(false);
  });

  it("maps a 401 to auth and a dead network to offline", async () => {
    fakeShell();
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401, json: async () => ({ error: "auth required" }) }));
    initRemoteRecorder();
    expect(await platform.recorderRemote.start()).toEqual({ ok: false, reason: "auth" });

    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network down");
    });
    expect(await platform.recorderRemote.start()).toEqual({ ok: false, reason: "offline" });
  });

  it("treats start while already recording as success", async () => {
    fakeShell();
    const events = [{ id: 9, start_date: today, days: 1, track_name: "Summit Point" }];
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => events }));
    initRemoteRecorder();
    await platform.recorderRemote.start();
    expect(await platform.recorderRemote.start()).toEqual({ ok: true, eventId: 9 });
  });
});
