// Garage logbook helpers — pure, unit-testable. Setup-sheet field spec
// (mirrors sanitizeSetup in src/lib/validate.ts — keep in sync), setup
// diffing for the correlation views, and consumable wear/status formatting.

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
export const WEAR_LIMIT_HINTS = {
  pads_front: "3 (mm)",
  pads_rear: "3 (mm)",
  tires: "3 (32nds)",
  rotors_front: "28 (mm)",
  rotors_rear: "26 (mm)",
};

// ---------- setup sheet spec -------------------------------------------------

// Field spec driving the setup form, summaries and diffs. Shapes:
// "corners" (fl/fr/rl/rr), "axle" (f/r), "number" (scalar).
export const SETUP_FIELDS = [
  { key: "tp_cold", label: "Tire pressure — cold", unit: "psi", shape: "corners", step: 0.5 },
  { key: "tp_hot", label: "Tire pressure — hot", unit: "psi", shape: "corners", step: 0.5 },
  { key: "camber", label: "Camber", unit: "°", shape: "axle", step: 0.1 },
  { key: "toe", label: "Toe", unit: "", shape: "axle", step: 0.01 },
  { key: "caster", label: "Caster", unit: "°", shape: "axle", step: 0.1 },
  { key: "rebound", label: "Rebound", unit: "clk", shape: "axle", step: 1 },
  { key: "compression", label: "Compression", unit: "clk", shape: "axle", step: 1 },
  { key: "sway", label: "Sway bar", unit: "pos", shape: "axle", step: 1 },
  { key: "fuel", label: "Fuel", unit: "gal", shape: "number", step: 0.5 },
];
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

export const flatUnit = (key) => SETUP_FIELDS.find((f) => f.key === key.split(".")[0])?.unit ?? "";

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
