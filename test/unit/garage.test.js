import { describe, expect, it } from "vitest";
import {
  diffSetups,
  flatLabel,
  flattenSetup,
  fmtCost,
  fmtRemaining,
  partKindLabel,
  partStatus,
} from "../../public/js/garage.js";

describe("flattenSetup / flatLabel", () => {
  it("flattens groups in spec order with dotted keys", () => {
    const flat = flattenSetup({
      camber: { f: -3.2, r: -2 },
      tp_cold: { fl: 31, rr: 30 },
      fuel: 12,
      tires_id: 4,
      notes: "ignored",
    });
    expect(flat).toEqual([
      ["tp_cold.fl", 31],
      ["tp_cold.rr", 30],
      ["camber.f", -3.2],
      ["camber.r", -2],
      ["fuel", 12],
      ["tires_id", 4],
    ]);
  });

  it("labels flat keys for humans", () => {
    expect(flatLabel("tp_cold.fl")).toBe("Tire pressure — cold FL");
    expect(flatLabel("camber.f")).toBe("Camber F");
    expect(flatLabel("fuel")).toBe("Fuel");
    expect(flatLabel("tires_id")).toBe("Tires");
  });

  it("handles null sheets", () => {
    expect(flattenSetup(null)).toEqual([]);
  });
});

describe("diffSetups", () => {
  it("reports changed, added and removed values", () => {
    const prev = { camber: { f: -2.5, r: -2 }, fuel: 14 };
    const cur = { camber: { f: -3.2, r: -2 }, rebound: { f: 10 } };
    expect(diffSetups(prev, cur)).toEqual([
      { key: "camber.f", from: -2.5, to: -3.2 },
      { key: "fuel", from: 14, to: null },
      { key: "rebound.f", from: null, to: 10 },
    ]);
  });

  it("everything is new against a null previous sheet", () => {
    expect(diffSetups(null, { fuel: 12 })).toEqual([{ key: "fuel", from: null, to: 12 }]);
  });

  it("identical sheets diff to nothing", () => {
    const s = { tp_cold: { fl: 31 }, tires_id: 2 };
    expect(diffSetups(s, { ...s })).toEqual([]);
  });
});

describe("partStatus / fmtRemaining", () => {
  const wear = (remaining_hours, pct_used = 0.5) => ({ remaining_hours, pct_used });

  it("classifies remaining life", () => {
    expect(partStatus(wear(null))).toBeNull();
    expect(partStatus(wear(0))).toBe("due");
    expect(partStatus(wear(2, 1))).toBe("due"); // past 100% used
    expect(partStatus(wear(3))).toBe("low"); // ≤ 2 track days
    expect(partStatus(wear(10))).toBe("ok");
  });

  it("phrases remaining life in hours and track days", () => {
    expect(fmtRemaining(wear(0))).toBe("replace now");
    expect(fmtRemaining(wear(2.7))).toBe("~2.7 h left (≈1.5 track days)");
    expect(fmtRemaining(wear(8))).toBe("~8 h left (≈4 track days)");
    expect(fmtRemaining(wear(null))).toBeNull();
  });
});

describe("labels & money", () => {
  it("labels part kinds", () => {
    expect(partKindLabel("pads_front")).toBe("Front pads");
    expect(partKindLabel("mystery")).toBe("mystery");
  });

  it("formats cents as dollars", () => {
    expect(fmtCost(38900)).toBe("$389");
    expect(fmtCost(38950)).toBe("$389.50");
    expect(fmtCost(null)).toBeNull();
  });
});
