import { describe, expect, it } from "vitest";
import { carReadings, partOdometer, vehicleOdometer } from "../../src/lib/odometer";

const r = (start_date: string, km: number) => ({ start_date, km });

describe("carReadings", () => {
  it("keeps a rising series whole", () => {
    const { kept, otherCar } = carReadings([r("2026-03-01", 70000), r("2026-04-01", 70500), r("2026-04-01", 70500)]);
    expect(kept).toHaveLength(3);
    expect(otherCar).toBe(0);
  });

  it("treats a reading below the running maximum as another car's, not a rollback", () => {
    // A borrowed car on 04-01, then this car again: the 20k reading is skipped
    // and the next reading continues from 70k rather than jumping 50k.
    const { kept, otherCar } = carReadings([r("2026-03-01", 70000), r("2026-04-01", 20000), r("2026-05-01", 70400)]);
    expect(kept.map((k) => k.km)).toEqual([70000, 70400]);
    expect(otherCar).toBe(1);
  });

  it("ignores non-finite readings", () => {
    expect(carReadings([r("2026-03-01", Number.NaN), r("2026-03-02", 5)]).kept).toEqual([r("2026-03-02", 5)]);
  });
});

describe("vehicleOdometer", () => {
  it("is null without a reading", () => {
    expect(vehicleOdometer([])).toBeNull();
  });

  it("reports the latest reading, its date and the skipped count", () => {
    expect(vehicleOdometer([r("2026-03-01", 70000), r("2026-04-01", 20000), r("2026-05-01", 71130)])).toEqual({
      km: 71130,
      on: "2026-05-01",
      readings: 2,
      other_car: 1,
    });
  });
});

describe("partOdometer", () => {
  const today = "2026-06-01";
  const readings = [
    r("2026-02-01", 69000), // before the part went on
    r("2026-03-10", 70000),
    r("2026-03-10", 70090.4),
    r("2026-04-20", 70800),
    r("2026-05-20", 71180), // after it came off
  ];

  it("spans the first to the last reading in the service window", () => {
    const part = { installed_on: "2026-03-01", retired_on: "2026-05-01" };
    expect(partOdometer(part, readings, today)).toEqual({ km: 800, from: "2026-03-10", to: "2026-04-20", readings: 3 });
  });

  it("runs to today while the part is in service", () => {
    const part = { installed_on: "2026-03-15", retired_on: null };
    expect(partOdometer(part, readings, today)).toEqual({ km: 380, from: "2026-04-20", to: "2026-05-20", readings: 2 });
  });

  it("sums the stretches the part was on the car and skips the shelf time", () => {
    const part = {
      installed_on: "2026-02-01",
      retired_on: null,
      mounts: [
        { mounted_on: "2026-02-01", removed_on: "2026-03-10" },
        { mounted_on: "2026-04-01", removed_on: null },
      ],
    };
    // 69000 → 70090.4 in the first stretch, 70800 → 71180 in the second; the
    // 710 km between them were driven on something else.
    expect(partOdometer(part, readings, today)).toEqual({ km: 1470.4, from: "2026-02-01", to: "2026-05-20", readings: 5 });
    expect(partOdometer({ ...part, mounts: [] }, readings, today)).toBeNull();
  });

  it("needs two readings — one says nothing about distance", () => {
    expect(partOdometer({ installed_on: "2026-05-01", retired_on: null }, readings, today)).toBeNull();
  });

  it("rounds to a tenth of a kilometre", () => {
    const part = { installed_on: "2026-03-10", retired_on: "2026-03-10" };
    expect(partOdometer(part, readings, today)?.km).toBe(90.4);
  });

  it("skips another car's reading inside the window", () => {
    const part = { installed_on: "2026-03-01", retired_on: null };
    const mixed = [r("2026-03-10", 70000), r("2026-04-01", 12000), r("2026-04-20", 70800)];
    expect(partOdometer(part, mixed, today)).toEqual({ km: 800, from: "2026-03-10", to: "2026-04-20", readings: 2 });
  });

  it("ignores a reading on an upcoming day", () => {
    const part = { installed_on: "2026-03-01", retired_on: null };
    expect(partOdometer(part, [r("2026-03-10", 70000), r("2026-07-01", 70900)], today)).toBeNull();
  });
});
