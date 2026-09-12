// Garage logbook helpers — pure, unit-testable. Setup-sheet field spec
// (mirrors sanitizeSetup in src/lib/validate.ts — keep in sync), setup
// diffing for the correlation views, and consumable wear/status formatting.
//
// Unit handling: a sheet is stored in one system (psi, gallons — the ranges
// sanitizeSetup enforces) and shown in the user's (see js/units.js). The
// conversions here are the only place the two meet: setupToDisplay on the way
// to a form or summary, setupToStored on the way back.

import { isMetric, L_PER_GAL, PSI_PER_BAR } from "./units.js";

// ---------- consumable part kinds --------------------------------------------

export const PART_KINDS = [
  ["pads_front", "Front pads"],
  ["pads_rear", "Rear pads"],
  ["tires", "Tires"],
  ["rotors_front", "Front rotors"],
  ["rotors_rear", "Rear rotors"],
  ["brake_fluid", "Brake fluid"],
  ["oil", "Oil"],
  ["other", "Other"],
];
export const partKindLabel = (kind) => (PART_KINDS.find(([k]) => k === kind) || [])[1] ?? kind;

// Suggested replace-at levels shown as form placeholders (not enforced).
// Pads and rotors are specified in millimetres on both sides of the Atlantic;
// only tread depth changes idiom (32nds of an inch vs. mm). The imperial table
// is the one pinned by contracts/logic/garage-status.json.
export const WEAR_LIMIT_HINTS = {
  pads_front: "3 (mm)",
  pads_rear: "3 (mm)",
  tires: "3 (32nds)",
  rotors_front: "28 (mm)",
  rotors_rear: "26 (mm)",
};
export const WEAR_LIMIT_HINTS_METRIC = { ...WEAR_LIMIT_HINTS, tires: "3 (mm)" };
export const wearLimitHint = (kind, units) =>
  (isMetric(units) ? WEAR_LIMIT_HINTS_METRIC : WEAR_LIMIT_HINTS)[kind] ?? "";

// The unit a new wear measurement is offered in. A measurement stores its own
// unit string, so this is only a default — a part's later measurements follow
// its first one (see the measurement form in app.js).
export const defaultMeasurementUnit = (kind, units) =>
  kind === "tires" && !isMetric(units) ? "32nds" : "mm";

// ---------- setup sheet spec -------------------------------------------------

// Field spec driving the setup form, summaries and diffs. Shapes:
// "corners" (fl/fr/rl/rr), "axle" (f/r), "number" (scalar). `unit`/`step`
// are the stored (imperial) presentation; `metric` is the alternative, with
// `perUnit` = stored units per one displayed unit (psi per bar, gal per L).
const BAR = { unit: "bar", perUnit: PSI_PER_BAR, step: 0.05, dp: 2 };
const LITRES = { unit: "L", perUnit: 1 / L_PER_GAL, step: 1, dp: 1 };
export const SETUP_FIELDS = [
  { key: "tp_cold", label: "Tire pressure — cold", unit: "psi", shape: "corners", step: 0.5, metric: BAR },
  { key: "tp_hot", label: "Tire pressure — hot", unit: "psi", shape: "corners", step: 0.5, metric: BAR },
  { key: "camber", label: "Camber", unit: "°", shape: "axle", step: 0.1 },
  { key: "toe", label: "Toe", unit: "", shape: "axle", step: 0.01 },
  { key: "caster", label: "Caster", unit: "°", shape: "axle", step: 0.1 },
  { key: "rebound", label: "Rebound", unit: "clk", shape: "axle", step: 1 },
  { key: "compression", label: "Compression", unit: "clk", shape: "axle", step: 1 },
  { key: "sway", label: "Sway bar", unit: "pos", shape: "axle", step: 1 },
  { key: "fuel", label: "Fuel", unit: "gal", shape: "number", step: 0.5, metric: LITRES },
];

const metricSpec = (f, units) => (isMetric(units) && f.metric) || null;
const roundTo = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

// The unit label and input step for a field in the user's system.
export const setupUnit = (f, units) => metricSpec(f, units)?.unit ?? f.unit;
export const setupStep = (f, units) => metricSpec(f, units)?.step ?? f.step;

// Stored → displayed value (null passes through). Rounded to the display
// unit's natural precision so a form pre-filled from a stored sheet shows
// "2.14", not "2.1374".
export function setupToDisplay(f, v, units) {
  if (v == null) return v;
  const m = metricSpec(f, units);
  return m ? roundTo(v / m.perUnit, m.dp) : v;
}

// Displayed → stored value. Two decimals, which is what sanitizeSetup keeps
// for pressures — so a metric sheet round-trips stably after its first save.
export function setupToStored(f, v, units) {
  if (v == null) return v;
  const m = metricSpec(f, units);
  return m ? roundTo(v * m.perUnit, 2) : v;
}

export const setupFieldFor = (flatKey) => SETUP_FIELDS.find((f) => f.key === flatKey.split(".")[0]) ?? null;
export const CORNER_KEYS = [
  ["fl", "FL"],
  ["fr", "FR"],
  ["rl", "RL"],
  ["rr", "RR"],
];
export const AXLE_KEYS = [
  ["f", "F"],
  ["r", "R"],
];
// Part references a sheet can carry: which consumables were on the car.
export const PART_REFS = [
  ["tires_id", "Tires", "tires"],
  ["pads_f_id", "Front pads", "pads_front"],
  ["pads_r_id", "Rear pads", "pads_rear"],
];

const subKeys = (shape) => (shape === "corners" ? CORNER_KEYS : AXLE_KEYS).map(([k]) => k);

// Flatten a sheet to "field.sub" → value entries (numbers only; notes and
// part refs are handled separately). Stable order = spec order.
export function flattenSetup(sheet) {
  const out = [];
  if (!sheet) return out;
  for (const f of SETUP_FIELDS) {
    if (f.shape === "number") {
      if (sheet[f.key] != null) out.push([f.key, sheet[f.key]]);
      continue;
    }
    const group = sheet[f.key];
    if (!group) continue;
    for (const k of subKeys(f.shape)) {
      if (group[k] != null) out.push([`${f.key}.${k}`, group[k]]);
    }
  }
  for (const [key] of PART_REFS) if (sheet[key] != null) out.push([key, sheet[key]]);
  return out;
}

// Human label for a flat key: "tp_cold.fl" → "Tire pressure — cold FL".
export function flatLabel(key) {
  const [root, sub] = key.split(".");
  const ref = PART_REFS.find(([k]) => k === root);
  if (ref) return ref[1];
  const f = SETUP_FIELDS.find((x) => x.key === root);
  if (!f) return key;
  const subLabel = sub
    ? (f.shape === "corners" ? CORNER_KEYS : AXLE_KEYS).find(([k]) => k === sub)?.[1] ?? sub
    : "";
  return subLabel ? `${f.label} ${subLabel}` : f.label;
}

// Unit for a flat key ("tp_cold.fl" → "psi" / "bar"); "" for part refs and
// unitless fields.
export function flatUnit(key, units) {
  const f = setupFieldFor(key);
  return f ? setupUnit(f, units) : "";
}

// A flat key's stored value as the user should read it: "31 psi" / "2.14 bar",
// unitless fields bare. Part refs are the caller's job (they need the garage).
export function fmtSetupValue(key, v, units) {
  if (v == null) return "—";
  const f = setupFieldFor(key);
  if (!f) return String(v);
  const unit = setupUnit(f, units);
  // "31 psi" but "-3.2°" — the degree sign attaches to its number.
  return `${setupToDisplay(f, v, units)}${unit ? `${unit === "°" ? "" : " "}${unit}` : ""}`;
}

// What changed between two sheets: [{key, from, to}] in spec order. A null
// prev means everything in cur is "new" (from: null). Part-ref values are the
// raw ids — the caller maps them to part names for display.
export function diffSetups(prev, cur) {
  const before = new Map(flattenSetup(prev));
  const after = new Map(flattenSetup(cur));
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  return keys
    .filter((k) => before.get(k) !== after.get(k))
    .map((k) => ({ key: k, from: before.get(k) ?? null, to: after.get(k) ?? null }));
}

// ---------- wear status ------------------------------------------------------

// Rough conversion for "how many more track days" phrasing — matches
// DEFAULT_HOURS_PER_DAY in src/lib/wear.ts.
export const HOURS_PER_DAY = 2;

// Traffic-light status for a part's wear estimate:
//   due  — replace now (over the limit / past expected life)
//   low  — roughly two track days or less remaining
//   ok   — plenty left
//   null — no basis for an estimate (no expected life, <2 measurements)
export function partStatus(wear) {
  if (!wear || wear.remaining_hours == null) return null;
  if (wear.remaining_hours <= 0 || (wear.pct_used ?? 0) >= 1) return "due";
  if (wear.remaining_hours <= 2 * HOURS_PER_DAY) return "low";
  return "ok";
}

export function fmtHours(h) {
  if (h == null) return "—";
  return `${Math.round(h * 10) / 10} h`;
}

// "~4.5 h (≈2 track days)" — the phrasing used for remaining life.
export function fmtRemaining(wear) {
  if (!wear || wear.remaining_hours == null) return null;
  if (wear.remaining_hours <= 0) return "replace now";
  const days = wear.remaining_hours / HOURS_PER_DAY;
  const roundedDays = days >= 2 ? Math.round(days) : Math.round(days * 2) / 2;
  return `~${fmtHours(wear.remaining_hours)} left (≈${roundedDays} track day${roundedDays === 1 ? "" : "s"})`;
}

export const fmtCost = (cents) =>
  cents == null ? null : `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
