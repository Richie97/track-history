// Unit system (imperial / metric) — pure conversions plus the cached choice.
//
// The preference lives on the account (`users.units`, served by GET /api/me
// and set by PUT /api/me/units) so every client shows the same system. Nothing
// stored changes with it: lap times are milliseconds, event temperatures are
// °F (`events.temp_f`), channel speeds km/h, setup-sheet pressures psi and
// fuel gallons, and a wear measurement carries whatever unit it was logged
// in. This module converts at the edges — display, and form input on the way
// back — so the server and the offline mirror never see a converted value.
//
// Import-safe in Node (no top-level `localStorage`): the cache is read lazily
// and every access is try/catch-wrapped, like theme.js.

export const UNIT_SYSTEMS = [
  ["imperial", "Imperial", "mph · °F · psi · gal"],
  ["metric", "Metric", "km/h · °C · bar · L"],
];
// What an account that never chose sees — the app always showed imperial, so
// the default keeps every existing logbook reading the way it did. Mirrors
// DEFAULT_UNITS in src/lib/validate.ts.
export const DEFAULT_UNITS = "imperial";
export const isUnitSystem = (u) => UNIT_SYSTEMS.some(([id]) => id === u);
export const isMetric = (u) => u === "metric";

// ---------- the cached choice -----------------------------------------------

// The signed-in user's preference is known once GET /me answers; it is cached
// so public share pages (no /me) and the import review (shared with the
// recorder) read the same value without threading it through every call.
const UNITS_KEY = "th-units";
let cached = null;

export function currentUnits() {
  if (cached) return cached;
  try {
    const u = localStorage.getItem(UNITS_KEY);
    if (isUnitSystem(u)) return u;
  } catch {}
  return DEFAULT_UNITS;
}

export function cacheUnits(units) {
  if (!isUnitSystem(units)) return;
  cached = units;
  try {
    localStorage.setItem(UNITS_KEY, units);
  } catch {}
}

// Signing out must not carry one user's choice to the next person on a shared
// device.
export function clearUnitsCache() {
  cached = null;
  try {
    localStorage.removeItem(UNITS_KEY);
  } catch {}
}

// ---------- speed (stored km/h) -----------------------------------------------

export const KPH_TO_MPH = 0.621371;
// m/s → mph, for the live recorder's read-out. 3.6 × KPH_TO_MPH, spelled out so
// the two speed paths can't disagree at a rounding boundary.
export const MPS_TO_MPH = 3.6 * KPH_TO_MPH;

export const speedUnit = (units) => (isMetric(units) ? "km/h" : "mph");
export const convSpeedKph = (kph, units) => (isMetric(units) ? kph : kph * KPH_TO_MPH);
export const convSpeedMps = (mps, units) => (isMetric(units) ? mps * 3.6 : mps * MPS_TO_MPH);
export const fmtSpeedKph = (kph, units, dp = 0) =>
  `${convSpeedKph(kph, units).toFixed(dp)} ${speedUnit(units)}`;

// ---------- distance (stored meters) ------------------------------------------

export const M_PER_MI = 1609.344;
export const FT_PER_M = 3.28084;

// Axis-tick / read-out style: "940 m" / "2.4 km", or "800 ft" / "0.75 mi".
// Feet give way to miles at a quarter mile — below that a distance reads
// better in feet, above it in the number a driver already knows a track by.
// Zero is "0 mi" so an imperial axis doesn't open in a different unit than it
// continues in.
export function fmtDist(m, units) {
  if (!isMetric(units)) {
    const mi = m / M_PER_MI;
    if (m === 0 || mi >= 0.25) return `${Number(mi.toFixed(2))} mi`;
    return `${Math.round(m * FT_PER_M)} ft`;
  }
  return m >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km` : `${m} m`;
}

// GPS accuracy style: "±4 m" / "±13 ft".
export const fmtAccuracy = (m, units) =>
  isMetric(units) ? `±${Math.round(m)} m` : `±${Math.round(m * FT_PER_M)} ft`;

// ---------- temperature (stored whole °F) -------------------------------------

export const tempUnit = (units) => (isMetric(units) ? "°C" : "°F");
export const tempToDisplay = (f, units) => (f == null ? null : isMetric(units) ? Math.round(((f - 32) * 5) / 9) : f);
export const tempToStored = (v, units) => (v == null ? null : Math.round(isMetric(units) ? (v * 9) / 5 + 32 : v));
export const fmtTemp = (f, units) => (f == null ? "" : `${tempToDisplay(f, units)}${tempUnit(units)}`);
// The event form's input bounds — the °F range is what isValidTemp in
// src/lib/validate.ts enforces; the °C one maps onto it.
export const tempInputSpec = (units) =>
  isMetric(units) ? { min: -40, max: 65, placeholder: 22 } : { min: -40, max: 150, placeholder: 72 };

// ---------- pressure (stored psi) and fuel (stored gallons) -------------------

export const PSI_PER_BAR = 14.503774;
export const L_PER_GAL = 3.785412;
