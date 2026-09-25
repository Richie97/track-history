import { describe, expect, it } from "vitest";
import {
  SETUP_FIELDS,
  catalogCarLabel,
  catalogCarName,
  catalogPrefill,
  defaultMeasurementUnit,
  diffSetups,
  equipSwapKinds,
  equipSwapsOff,
  isTireKind,
  partTitle,
  flatLabel,
  flatUnit,
  flattenSetup,
  fmtCost,
  fmtRemaining,
  fmtSetupValue,
  matchCatalogCars,
  partKindLabel,
  partOdometerLine,
  partStatus,
  setupStep,
  setupToDisplay,
  setupToStored,
  setupUnit,
  vehicleLogbook,
  vehicleOdometerLine,
  vehicleTileLine,
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

describe("equipping (front / rear tyres, spares)", () => {
  const parts = [
    { id: 1, kind: "tires", name: "Street", equipped: false, retired_on: null },
    { id: 2, kind: "tires_front", name: "A7", size: "285/30R18", equipped: true, retired_on: null },
    { id: 3, kind: "tires_rear", name: "A7", size: "335/30R18", equipped: true, retired_on: null },
    { id: 4, kind: "tires_front", name: "Old A7", equipped: false, retired_on: "2026-01-01" },
    { id: 5, kind: "pads_front", name: "DTC-60", equipped: true, retired_on: null },
    { id: 6, kind: "other", name: "Camera", equipped: true, retired_on: null },
  ];

  it("a full set takes both pairs off; a pair takes the full set and its own axle", () => {
    expect(equipSwapsOff(parts[0], parts).map((p) => p.id)).toEqual([2, 3]);
    expect(equipSwapsOff({ id: 9, kind: "tires_front" }, parts).map((p) => p.id)).toEqual([2]);
    expect(equipSwapsOff({ id: 9, kind: "other" }, parts)).toEqual([]);
    expect(equipSwapKinds("rotors_rear")).toEqual(["rotors_rear"]);
  });

  it("treats every tyre kind as tread depth and heat cycles", () => {
    expect(isTireKind("tires_rear")).toBe(true);
    expect(isTireKind("pads_rear")).toBe(false);
    expect(defaultMeasurementUnit("tires_front", "imperial")).toBe("32nds");
    expect(wearLimitHint("tires_rear", "metric")).toBe("3 (mm)");
  });

  it("titles a part with its size when it has one", () => {
    expect(partTitle(parts[1])).toBe("A7 · 285/30R18");
    expect(partTitle(parts[0])).toBe("Street");
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

// ---- car catalog picker (#222) ----------------------------------------------

const CATALOG = [
  { id: 1, make: "BMW", model: "M3", generation: "E46", year_from: 2000, year_to: 2006, wheelbase_mm: 2731, steering_ratio: 15.4 },
  { id: 2, make: "Chevrolet", model: "Corvette", generation: "C7", year_from: 2014, year_to: 2019, wheelbase_mm: 2710, steering_ratio: 16.25 },
  { id: 3, make: "Chevrolet", model: "Corvette", generation: "C8", year_from: 2020, year_to: null, wheelbase_mm: 2722, steering_ratio: 15.7 },
  { id: 4, make: "Mazda", model: "MX-5", generation: "ND", year_from: 2015, year_to: null, wheelbase_mm: 2310, steering_ratio: 15.5 },
  { id: 5, make: "Porsche", model: "718 Cayman", generation: "982", year_from: 2016, year_to: null, wheelbase_mm: 2475, steering_ratio: null },
  { id: 6, make: "Toyota", model: "GR86", generation: null, year_from: 2022, year_to: null, wheelbase_mm: 2575, steering_ratio: 13.5 },
];
const ids = (rows) => rows.map((r) => r.id);

describe("catalog labels", () => {
  it("names a car by make, model and generation", () => {
    expect(catalogCarName(CATALOG[1])).toBe("Chevrolet Corvette C7");
    expect(catalogCarName(CATALOG[5])).toBe("Toyota GR86");
  });
  it("labels a picker row with its generation and years", () => {
    expect(catalogCarLabel(CATALOG[1])).toBe("Chevrolet Corvette · C7 · 2014–2019");
    expect(catalogCarLabel(CATALOG[2])).toBe("Chevrolet Corvette · C8 · 2020–");
    expect(catalogCarLabel(CATALOG[5])).toBe("Toyota GR86 · 2022–");
  });
});

describe("matchCatalogCars", () => {
  it("returns the whole catalog for an empty query", () => {
    expect(ids(matchCatalogCars("", CATALOG))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ids(matchCatalogCars("   ", CATALOG))).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("finds a generation, a model and a make, case-insensitively", () => {
    expect(ids(matchCatalogCars("c7", CATALOG))).toEqual([2]);
    expect(ids(matchCatalogCars("CORVETTE", CATALOG))).toEqual([2, 3]);
    expect(ids(matchCatalogCars("chevrolet corvette", CATALOG))).toEqual([2, 3]);
  });
  it("every token has to fit, so extra words narrow", () => {
    expect(ids(matchCatalogCars("corvette c8", CATALOG))).toEqual([3]);
    expect(ids(matchCatalogCars("corvette miata", CATALOG))).toEqual([]);
  });
  it("ranks whole words over prefixes over substrings, ties in catalog order", () => {
    // "e46" is a whole word on the M3; "e" is only inside the others' names.
    expect(ids(matchCatalogCars("e", CATALOG))).toEqual([1, 2, 3, 5]);
    // "718" is a whole word on the Cayman; nothing else carries it.
    expect(ids(matchCatalogCars("718", CATALOG))).toEqual([5]);
  });
  it("ignores punctuation in a model name", () => {
    expect(ids(matchCatalogCars("mx5", CATALOG))).toEqual([4]);
    expect(ids(matchCatalogCars("mx-5", CATALOG))).toEqual([4]);
  });
  it("reads a four-digit token as a model year", () => {
    expect(ids(matchCatalogCars("2017", CATALOG))).toEqual([2, 4, 5]);
    expect(ids(matchCatalogCars("corvette 2017", CATALOG))).toEqual([2]);
    expect(ids(matchCatalogCars("corvette 2010", CATALOG))).toEqual([]);
  });
});

describe("catalogPrefill", () => {
  const C7 = CATALOG[1];
  const C8 = CATALOG[2];
  const CAYMAN = CATALOG[4];
  const plan = (row, current, previous) => {
    const p = catalogPrefill(row, current, previous);
    return [p.wheelbase_mm.action, p.steering_ratio.action];
  };

  it("fills a car with no numbers silently", () => {
    expect(catalogPrefill(C7, { wheelbase_mm: null, steering_ratio: null }, null)).toEqual({
      wheelbase_mm: { value: 2710, action: "fill" },
      steering_ratio: { value: 16.25, action: "fill" },
    });
  });
  it("asks before replacing a hand-typed number", () => {
    expect(plan(C7, { wheelbase_mm: 2700, steering_ratio: 15 }, null)).toEqual(["ask", "ask"]);
  });
  it("re-fills the previous pick's numbers without asking", () => {
    expect(plan(C8, { wheelbase_mm: 2710, steering_ratio: 16.25 }, C7)).toEqual(["fill", "fill"]);
  });
  it("keeps a number the driver corrected after the previous pick, behind a question", () => {
    expect(plan(C8, { wheelbase_mm: 2710, steering_ratio: 15 }, C7)).toEqual(["fill", "ask"]);
  });
  it("never offers to replace the driver's number with nothing", () => {
    expect(plan(CAYMAN, { wheelbase_mm: 2700, steering_ratio: 15 }, null)).toEqual(["ask", "keep"]);
  });
  it("clears the previous pick's ratio when the new car has none", () => {
    const p = catalogPrefill(CAYMAN, { wheelbase_mm: 2710, steering_ratio: 16.25 }, C7);
    expect(p.steering_ratio).toEqual({ value: null, action: "fill" });
  });
  it("has nothing to do when the numbers already match", () => {
    expect(plan(C7, { wheelbase_mm: 2710, steering_ratio: 16.25 }, null)).toEqual(["keep", "keep"]);
  });
});

describe("vehicleLogbook / vehicleTileLine (NS-37)", () => {
  const today = "2026-09-20";
  const ev = (id, over) => ({
    id,
    vehicle_id: 1,
    track_id: 100,
    track_name: "VIR",
    start_date: "2026-06-01",
    days: 1,
    best_ms: null,
    ...over,
  });

  it("counts track days, not events, and a track day that starts today is past", () => {
    const lb = vehicleLogbook(1, [ev(1, { days: 2 }), ev(2, { start_date: today })], today);
    expect(lb.track_days).toBe(3);
    expect(lb.events).toBe(2);
    expect(lb.last_event.id).toBe(2);
    expect(lb.next_event).toBeNull();
  });

  it("only counts rows the server matched to the car", () => {
    const lb = vehicleLogbook(1, [ev(1, { vehicle_id: null, car: "C8" }), ev(2, { vehicle_id: 2 })], today);
    expect(lb.events).toBe(0);
    expect(vehicleTileLine(lb)).toBe("No track days yet");
  });

  it("keeps one best per track — the fastest, the earlier event on a tie", () => {
    const lb = vehicleLogbook(
      1,
      [ev(1, { best_ms: 90000 }), ev(2, { start_date: "2026-07-01", best_ms: 90000 }), ev(3, { start_date: "2026-08-01", best_ms: 95000 })],
      today
    );
    expect(lb.bests).toEqual([{ track_id: 100, track_name: "VIR", best_ms: 90000, event_id: 1, start_date: "2026-06-01" }]);
  });

  it("orders tracks by the car's latest event there, event id breaking a date tie", () => {
    const lb = vehicleLogbook(
      1,
      [
        ev(1, { track_id: 100, best_ms: 1 }),
        ev(2, { track_id: 101, track_name: "NCM", start_date: "2026-07-01", best_ms: 2 }),
        ev(3, { track_id: 102, track_name: "Summit", start_date: "2026-07-01", best_ms: 3 }),
        ev(4, { track_id: 103, track_name: "Glen", start_date: "2026-08-01" }),
      ],
      today
    );
    expect(lb.bests.map((b) => b.track_id)).toEqual([102, 101, 100]);
  });

  it("words the tile from the last event, else the next, else nothing yet", () => {
    expect(vehicleTileLine(vehicleLogbook(1, [ev(1)], today))).toBe("1 track day · last at VIR");
    expect(vehicleTileLine(vehicleLogbook(1, [ev(1, { days: 3 })], today))).toBe("3 track days · last at VIR");
    expect(vehicleTileLine(vehicleLogbook(1, [ev(1, { start_date: "2026-10-01", track_name: "Glen" })], today))).toBe(
      "Next: Glen"
    );
  });
});

describe("odometer lines (#192)", () => {
  it("names the recorded session a vehicle's reading came from", () => {
    const odo = { km: 71130, on: "2026-05-02", readings: 3, other_car: 0 };
    expect(vehicleOdometerLine(odo, "metric")).toBe("Odometer: 71,130 km at the last recorded session (2026-05-02)");
    expect(vehicleOdometerLine({ ...odo, other_car: 1 }, "imperial")).toBe(
      "Odometer: 44,198 mi at the last recorded session (2026-05-02) · 1 lower reading skipped as another car's"
    );
    expect(vehicleOdometerLine(null, "metric")).toBeNull();
  });

  it("bounds a part's distance by its recorded sessions", () => {
    expect(partOdometerLine({ km: 1180, from: "2026-03-10", to: "2026-04-20", readings: 2 }, "metric")).toBe(
      "Odometer: 1,180 km between its first and last recorded sessions"
    );
    expect(partOdometerLine(null, "imperial")).toBeNull();
  });
});
