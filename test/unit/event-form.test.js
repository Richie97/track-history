import { describe, expect, it } from "vitest";
import { sessionsToCreate, stagedSummary } from "../../public/js/event-form.js";

describe("sessionsToCreate", () => {
  const imported = { label: "PDR 09:15:00", notes: "Imported from a.mp4", laps: [121240, 120100], trace: null, channels: null };

  it("posts staged imports first, in order, then the hand-typed session", () => {
    const second = { ...imported, label: "GoPro 10:30:00" };
    const out = sessionsToCreate([imported, second], { label: " Day 1 — Session 2 ", laps: "2:03.55\n2:01.24", notes: "traffic" });
    expect(out.map((s) => s.label)).toEqual(["PDR 09:15:00", "GoPro 10:30:00", "Day 1 — Session 2"]);
    expect(out[2]).toEqual({ label: "Day 1 — Session 2", notes: "traffic", laps: [123550, 121240] });
  });

  it("drops a hand entry with no parseable laps rather than posting an empty session", () => {
    expect(sessionsToCreate([], { label: "Morning", laps: "", notes: "" })).toEqual([]);
    expect(sessionsToCreate([], { label: "", laps: "nonsense", notes: "" })).toEqual([]);
    expect(sessionsToCreate([imported], null)).toEqual([imported]);
  });

  it("sends blank label and notes as null, like the event page's form", () => {
    const [s] = sessionsToCreate([], { label: "  ", laps: "121.24", notes: "  " });
    expect(s).toEqual({ label: null, notes: null, laps: [121240] });
  });
});

describe("stagedSummary", () => {
  it("counts the laps and names the best", () => {
    expect(stagedSummary({ laps: [121240, 120100, 125000] })).toBe("3 laps · best 2:00.1");
    expect(stagedSummary({ laps: [121240] })).toBe("1 lap · best 2:01.24");
    expect(stagedSummary({ laps: [] })).toBe("0 laps");
  });
});
