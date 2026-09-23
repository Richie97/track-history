// The car's own odometer, reconciled with the garage's hours estimate (#192) —
// pure, unit-testable.
//
// A video import from the car's recorder carries the car's *lifetime*
// odometer (`sessions.odometer_km`, migration 0027: the reading at the end of
// that session). The garage estimates wear from hours (lib/wear.ts), a
// deliberate approximation; the odometer is ground truth for distance. This
// module only *reports* it beside the estimate — it never feeds wear.ts, whose
// basis stays hours until that is decided on its own (the issue says so, and
// wear.ts's presentation is ported to three clients).
//
// Two properties of the readings shape every rule here:
//   - They are sparse. Only sessions imported from the car's own recorder have
//     one, so a driver who records one session of four sees a partial picture.
//     Nothing here extrapolates: a span runs from the first reading to the
//     last, and the words the clients put on it say "between recorded
//     sessions" — never "since fitted".
//   - They can go backwards. A vehicle's events are matched by the `car` text,
//     so a borrowed car or a mislinked day lands another car's mileage in this
//     one's history. A reading below the running maximum is taken as another
//     car's and skipped, never treated as an error or as a rollback.

export type OdometerReading = {
  start_date: string; // ISO yyyy-mm-dd of the session's event
  km: number;
};

// The readings that belong to this car, and how many were skipped as another
// car's. Input must be ordered by date, then by reading — within one day the
// order of sessions is not reliably chronological, but the odometer is.
export function carReadings<R extends OdometerReading>(readings: R[]): { kept: R[]; otherCar: number } {
  const kept: R[] = [];
  let otherCar = 0;
  let max = -Infinity;
  for (const r of readings) {
    if (!Number.isFinite(r.km)) continue;
    if (r.km < max) {
      otherCar++;
      continue;
    }
    max = r.km;
    kept.push(r);
  }
  return { kept, otherCar };
}

export type VehicleOdometer = {
  km: number; // the latest reading
  on: string; // the date of the event it was recorded at
  readings: number; // readings kept
  other_car: number; // readings skipped as another car's
};

// What the car's own odometer last said. Null when no session has a reading.
export function vehicleOdometer(readings: OdometerReading[]): VehicleOdometer | null {
  const { kept, otherCar } = carReadings(readings);
  if (!kept.length) return null;
  const last = kept[kept.length - 1];
  return { km: last.km, on: last.start_date, readings: kept.length, other_car: otherCar };
}

export type PartOdometer = {
  km: number; // distance between the first and last reading in the window
  from: string; // date of the first reading
  to: string; // date of the last
  readings: number;
};

const round1 = (v: number) => Math.round(v * 10) / 10;

// Distance the car's odometer covered while a part was fitted, *as far as the
// recordings show*: from the first reading in its service window to the last.
// The window is the same one wear.ts accrues hours over (installed on or after,
// retired on or before, nothing upcoming). A lower bound by construction — the
// first reading is the end of a session, and nothing after the last recorded
// session is known. Needs two readings; one says nothing about distance.
export function partOdometer(
  part: { installed_on: string; retired_on: string | null },
  readings: OdometerReading[],
  today: string
): PartOdometer | null {
  const end = part.retired_on ?? today;
  const inWindow = carReadings(readings).kept.filter(
    (r) => r.start_date >= part.installed_on && r.start_date <= end && r.start_date <= today
  );
  if (inWindow.length < 2) return null;
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  return { km: round1(last.km - first.km), from: first.start_date, to: last.start_date, readings: inWindow.length };
}
