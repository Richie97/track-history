import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNITS,
  UNIT_SYSTEMS,
  cacheUnits,
  clearUnitsCache,
  convSpeedMps,
  currentUnits,
  fmtAccuracy,
  fmtDist,
  fmtSpeedKph,
  fmtTemp,
  isUnitSystem,
  speedUnit,
  tempInputSpec,
  tempToDisplay,
  tempToStored,
} from "../../public/js/units.js";

describe("unit systems", () => {
  it("offers exactly imperial and metric, defaulting to what the app always showed", () => {
    expect(UNIT_SYSTEMS.map(([id]) => id)).toEqual(["imperial", "metric"]);
    expect(DEFAULT_UNITS).toBe("imperial");
    expect(isUnitSystem("metric")).toBe(true);
    expect(isUnitSystem("Metric")).toBe(false);
    expect(isUnitSystem(null)).toBe(false);
  });

  it("caches the account's choice and falls back to the default (no localStorage in Node)", () => {
    clearUnitsCache();
    expect(currentUnits()).toBe("imperial");
    cacheUnits("metric");
    expect(currentUnits()).toBe("metric");
    cacheUnits("furlongs"); // ignored — an unknown value must not poison the cache
    expect(currentUnits()).toBe("metric");
    clearUnitsCache();
    expect(currentUnits()).toBe("imperial");
  });
});

describe("speed (stored km/h)", () => {
  it("converts to mph or leaves km/h alone", () => {
    expect(speedUnit("imperial")).toBe("mph");
    expect(speedUnit("metric")).toBe("km/h");
    expect(fmtSpeedKph(194.5, "imperial")).toBe("121 mph");
    expect(fmtSpeedKph(194.5, "metric")).toBe("195 km/h");
    expect(fmtSpeedKph(100, "metric", 1)).toBe("100.0 km/h");
  });

  it("agrees with itself between the km/h and m/s paths", () => {
    // 30 m/s = 108 km/h; both routes to mph must land on the same number.
    expect(Math.round(convSpeedMps(30, "imperial"))).toBe(Math.round(108 * 0.621371));
    expect(convSpeedMps(30, "metric")).toBeCloseTo(108, 9);
  });
});

describe("distance (stored meters)", () => {
  it("formats metric axis ticks as before", () => {
    expect(fmtDist(0, "metric")).toBe("0 m");
    expect(fmtDist(940, "metric")).toBe("940 m");
    expect(fmtDist(2000, "metric")).toBe("2 km");
    expect(fmtDist(2400, "metric")).toBe("2.4 km");
  });

  it("uses feet under a quarter mile and miles above, opening the axis in miles", () => {
    expect(fmtDist(0, "imperial")).toBe("0 mi");
    expect(fmtDist(100, "imperial")).toBe("328 ft");
    expect(fmtDist(0.25 * 1609.344, "imperial")).toBe("0.25 mi");
    expect(fmtDist(0.5 * 1609.344, "imperial")).toBe("0.5 mi");
    expect(fmtDist(1609.344, "imperial")).toBe("1 mi");
    expect(fmtDist(4000, "imperial")).toBe("2.49 mi");
  });

  it("formats GPS accuracy", () => {
    expect(fmtAccuracy(4.2, "metric")).toBe("±4 m");
    expect(fmtAccuracy(4.2, "imperial")).toBe("±14 ft");
  });
});

describe("temperature (stored whole °F)", () => {
  it("shows °F as-is and °C rounded", () => {
    expect(fmtTemp(72, "imperial")).toBe("72°F");
    expect(fmtTemp(72, "metric")).toBe("22°C");
    expect(fmtTemp(32, "metric")).toBe("0°C");
    expect(fmtTemp(null, "metric")).toBe("");
    expect(tempToDisplay(null, "metric")).toBeNull();
  });

  it("stores form input as whole °F and round-trips whole degrees stably", () => {
    expect(tempToStored(72, "imperial")).toBe(72);
    expect(tempToStored(72.4, "imperial")).toBe(72);
    expect(tempToStored(22, "metric")).toBe(72);
    expect(tempToStored(null, "metric")).toBeNull();
    // Every whole °C from -40 to 65 survives a save-and-edit cycle unchanged:
    // the stored °F is rounded, so a metric user must never watch their own
    // entry drift by a degree on the next edit.
    for (let c = -40; c <= 65; c++) expect(tempToDisplay(tempToStored(c, "metric"), "metric")).toBe(c);
  });

  it("bounds the input to what the server accepts", () => {
    const f = tempInputSpec("imperial");
    const c = tempInputSpec("metric");
    expect([f.min, f.max]).toEqual([-40, 150]);
    // The °C bounds convert to inside isValidTemp's -40…150 °F window.
    expect(tempToStored(c.min, "metric")).toBeGreaterThanOrEqual(-40);
    expect(tempToStored(c.max, "metric")).toBeLessThanOrEqual(150);
  });
});
