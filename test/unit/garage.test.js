import { describe, expect, it } from "vitest";
import {
  SETUP_FIELDS,
  defaultMeasurementUnit,
  diffSetups,
  flatLabel,
  flatUnit,
  flattenSetup,
  fmtCost,
  fmtRemaining,
  fmtSetupValue,
  partKindLabel,
  partStatus,
  setupStep,
  setupToDisplay,
  setupToStored,
  setupUnit,
  wearLimitHint,
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

describe("setup-sheet units", () => {
  const tp = SETUP_FIELDS.find((f) => f.key === "tp_cold");
  const fuel = SETUP_FIELDS.find((f) => f.key === "fuel");
  const camber = SETUP_FIELDS.find((f) => f.key === "camber");

  it("labels pressures and fuel in the user's system, everything else the same", () => {
    expect(setupUnit(tp, "imperial")).toBe("psi");
    expect(setupUnit(tp, "metric")).toBe("bar");
    expect(setupUnit(fuel, "metric")).toBe("L");
    expect(setupUnit(camber, "metric")).toBe("°");
    expect(setupStep(tp, "metric")).toBe(0.05);
    expect(setupStep(camber, "metric")).toBe(camber.step);
    expect(flatUnit("tp_hot.rr", "metric")).toBe("bar");
    expect(flatUnit("tp_hot.rr", "imperial")).toBe("psi");
    expect(flatUnit("tires_id", "metric")).toBe("");
  });

  it("converts stored psi/gal for display and back, and leaves imperial untouched", () => {
    expect(setupToDisplay(tp, 31, "imperial")).toBe(31);
    expect(setupToDisplay(tp, 31, "metric")).toBe(2.14);
    expect(setupToDisplay(fuel, 10, "metric")).toBe(37.9);
    expect(setupToDisplay(camber, -3.2, "metric")).toBe(-3.2);
    expect(setupToDisplay(tp, null, "metric")).toBeNull();
    expect(setupToStored(tp, 2.2, "metric")).toBe(31.91);
    expect(setupToStored(fuel, 40, "metric")).toBe(10.57);
    expect(setupToStored(tp, 31, "imperial")).toBe(31);
  });

  it("round-trips a metric entry stably after its first save", () => {
    // A sheet saved from a metric form and re-opened must pre-fill the same
    // number the driver typed, or every edit would nudge the values.
    for (const bar of [1.8, 2.0, 2.15, 2.45]) {
      const stored = setupToStored(tp, bar, "metric");
      expect(setupToDisplay(tp, stored, "metric")).toBe(bar);
      expect(setupToStored(tp, setupToDisplay(tp, stored, "metric"), "metric")).toBe(stored);
    }
    for (const litres of [20, 35, 41]) {
      const stored = setupToStored(fuel, litres, "metric");
      expect(setupToDisplay(fuel, stored, "metric")).toBe(litres);
    }
  });

  it("formats diff-chip values with their unit", () => {
    expect(fmtSetupValue("tp_cold.fl", 31, "imperial")).toBe("31 psi");
    expect(fmtSetupValue("tp_cold.fl", 31, "metric")).toBe("2.14 bar");
    expect(fmtSetupValue("toe.f", 0.05, "metric")).toBe("0.05");
    expect(fmtSetupValue("camber.f", -3.2, "imperial")).toBe("-3.2°");
    expect(fmtSetupValue("fuel", null, "metric")).toBe("—");
  });
});

describe("wear units", () => {
  it("suggests tread depth in 32nds only for imperial users", () => {
    expect(wearLimitHint("tires", "imperial")).toBe("3 (32nds)");
    expect(wearLimitHint("tires", "metric")).toBe("3 (mm)");
    expect(wearLimitHint("pads_front", "metric")).toBe("3 (mm)");
    expect(wearLimitHint("oil", "metric")).toBe("");
    expect(defaultMeasurementUnit("tires", "imperial")).toBe("32nds");
    expect(defaultMeasurementUnit("tires", "metric")).toBe("mm");
    expect(defaultMeasurementUnit("pads_rear", "imperial")).toBe("mm");
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
