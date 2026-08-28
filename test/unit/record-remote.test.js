// The remote-start attachment rule (public/js/record/remote.js) is the
// reference implementation for RemoteRecording in both native apps — these
// are the JS test cases the Swift and Kotlin ports carried over, and
// contracts/logic/remote-attach.json pins the ports to this behavior.
import { describe, expect, it } from "vitest";
import { localTodayIso, pickRecordingEvent } from "../../public/js/record/remote.js";

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
