import { afterEach, describe, expect, it } from "vitest";
import { STAGE_MEDIUM_MIN, STAGE_WIDE_MIN, currentSyncMode, setSyncMode, stageLayout } from "../../public/js/lap-stage.js";

// The DOM half of the stage is checked in a browser; these are the two
// decisions it makes without one.
describe("the sync-mode preference", () => {
  afterEach(() => {
    delete globalThis.localStorage;
  });
  const fakeStorage = () => {
    const m = new Map();
    globalThis.localStorage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
    return m;
  };
  it("defaults to Same place, with no storage at all", () => {
    expect(currentSyncMode()).toBe("place");
    expect(() => setSyncMode("time")).not.toThrow();
  });
  it("remembers the last mode picked, under th-sync-mode", () => {
    const m = fakeStorage();
    setSyncMode("time");
    expect(m.get("th-sync-mode")).toBe("time");
    expect(currentSyncMode()).toBe("time");
  });
  it("ignores an unknown value, stored or offered", () => {
    const m = fakeStorage();
    m.set("th-sync-mode", "sideways");
    expect(currentSyncMode()).toBe("place");
    setSyncMode("sideways");
    expect(m.get("th-sync-mode")).toBe("sideways");
  });
});

describe("stageLayout", () => {
  it("reads the stage's own width: wide from 1000, medium from 600", () => {
    expect([STAGE_WIDE_MIN, STAGE_MEDIUM_MIN]).toEqual([1000, 600]);
    expect(stageLayout(1000)).toBe("wide");
    expect(stageLayout(999)).toBe("medium");
    expect(stageLayout(600)).toBe("medium");
    expect(stageLayout(599)).toBe("compact");
  });
});
