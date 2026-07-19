// Input validation shared across routes — pure, unit-testable.

// 3-32 chars, lowercase letters/digits/hyphens, no leading/trailing hyphen.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export const isValidSlug = (slug: string) => SLUG_RE.test(slug);

// Keep only finite, positive lap times and round to whole milliseconds.
export function sanitizeLaps(laps: unknown): number[] {
  if (!Array.isArray(laps)) return [];
  return laps
    .filter((ms): ms is number => typeof ms === "number" && Number.isFinite(ms) && ms > 0)
    .map((ms) => Math.round(ms));
}

// A goal is either cleared (null/undefined) or a positive finite number of ms.
export const isValidGoal = (g: unknown): g is number | null | undefined =>
  g == null || (typeof g === "number" && Number.isFinite(g) && g > 0);

// Track conditions for an event: cleared, or one of the known values.
export const CONDITIONS = ["dry", "damp", "wet", "mixed"] as const;
export type Conditions = (typeof CONDITIONS)[number];
export const isValidConditions = (v: unknown): v is Conditions | null | undefined =>
  v == null || (typeof v === "string" && (CONDITIONS as readonly string[]).includes(v));

// Ambient temperature in °F: cleared, or a plausible whole number.
export const isValidTemp = (v: unknown): v is number | null | undefined =>
  v == null || (typeof v === "number" && Number.isInteger(v) && v >= -40 && v <= 150);

// A best-lap GPS trace: array of [x, y, v] points (local meters + speed).
// null clears it; a valid array is rounded to keep the stored JSON small.
// Returns undefined when the input isn't a plausible trace.
export function sanitizeTrace(v: unknown): [number, number, number][] | null | undefined {
  if (v == null) return null;
  if (!Array.isArray(v) || v.length < 10 || v.length > 600) return undefined;
  const pts: [number, number, number][] = [];
  for (const raw of v) {
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 3) return undefined;
    const [x, y, speed] = raw as unknown[];
    if (typeof x !== "number" || !Number.isFinite(x) || Math.abs(x) > 1e6) return undefined;
    if (typeof y !== "number" || !Number.isFinite(y) || Math.abs(y) > 1e6) return undefined;
    const sv = speed == null ? 0 : speed;
    if (typeof sv !== "number" || !Number.isFinite(sv) || Math.abs(sv) > 1e6) return undefined;
    pts.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(sv * 100) / 100]);
  }
  return pts;
}

// Per-lap channel data (see public/js/import/channels.js, which builds this
// shape — keep the two in sync): channel arrays on a uniform driven-distance
// grid, one entry per lap. null clears it; valid data is re-rounded so the
// stored JSON stays small. Returns undefined when the input isn't plausible.
export type LapChannelEntry = { n: number; timeMs: number; speed?: number[]; rpm?: number[]; latG?: number[] };
export type LapChannels = { v: 1; dStepM: number; laps: LapChannelEntry[] };

const CHANNEL_SPECS: ["speed" | "rpm" | "latG", number, number, number][] = [
  // name, max plausible value, rounding factor, min plausible value
  ["speed", 500, 10, 0],
  ["rpm", 25000, 1, 0],
  ["latG", 10, 1000, 0],
];

export function sanitizeChannels(v: unknown): LapChannels | null | undefined {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const dStepM = o.dStepM;
  if (typeof dStepM !== "number" || !Number.isFinite(dStepM) || dStepM < 5 || dStepM > 200) return undefined;
  if (!Array.isArray(o.laps) || o.laps.length < 1 || o.laps.length > 80) return undefined;
  const laps: LapChannelEntry[] = [];
  let points = 0;
  for (const raw of o.laps) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const l = raw as Record<string, unknown>;
    if (typeof l.n !== "number" || !Number.isInteger(l.n) || l.n < 0 || l.n > 10000) return undefined;
    if (typeof l.timeMs !== "number" || !Number.isFinite(l.timeMs) || l.timeMs <= 0) return undefined;
    const entry: LapChannelEntry = { n: l.n, timeMs: Math.round(l.timeMs) };
    let len = 0;
    for (const [name, max, f, min] of CHANNEL_SPECS) {
      const arr = l[name];
      if (arr == null) continue;
      if (!Array.isArray(arr) || arr.length < 10 || arr.length > 800) return undefined;
      if (len && arr.length !== len) return undefined; // channels share the grid
      len = arr.length;
      const vals: number[] = [];
      for (const x of arr) {
        if (typeof x !== "number" || !Number.isFinite(x) || x < min || x > max) return undefined;
        vals.push(Math.round(x * f) / f);
      }
      entry[name] = vals;
      points += vals.length;
    }
    if (!len) return undefined; // a lap entry with no channels isn't data
    laps.push(entry);
  }
  // Hard budget on stored size: 60k values is roughly 400KB of JSON; real
  // sessions (25 laps × 3 channels × ~150 points) land far under it.
  if (points > 60000) return undefined;
  return { v: 1, dStepM, laps };
}

// ISO yyyy-mm-dd, the format every date column stores.
export const isValidDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

// Consumable part kinds — drives grouping and per-kind defaults in the UI.
export const PART_KINDS = [
  "pads_front",
  "pads_rear",
  "tires",
  "rotors_front",
  "rotors_rear",
  "brake_fluid",
  "oil",
  "other",
] as const;
export type PartKind = (typeof PART_KINDS)[number];
export const isValidPartKind = (v: unknown): v is PartKind =>
  typeof v === "string" && (PART_KINDS as readonly string[]).includes(v);

// A per-event-day setup sheet. Structured enough to diff and chart, loose
// enough that field applicability varies by car: every field is optional,
// unknown keys are dropped, out-of-range values reject the sheet.
// Keep the field list in sync with SETUP_FIELDS in public/js/setup.js,
// which renders the form from the same spec.
type CornerKey = "fl" | "fr" | "rl" | "rr";
type AxleKey = "f" | "r";
export type SetupSheet = {
  tp_cold?: Partial<Record<CornerKey, number>>; // psi, cold
  tp_hot?: Partial<Record<CornerKey, number>>; // psi, hot off track
  camber?: Partial<Record<AxleKey, number>>; // degrees
  toe?: Partial<Record<AxleKey, number>>; // user's unit (deg or in)
  caster?: Partial<Record<AxleKey, number>>; // degrees
  rebound?: Partial<Record<AxleKey, number>>; // damper clicks
  compression?: Partial<Record<AxleKey, number>>; // damper clicks
  sway?: Partial<Record<AxleKey, number>>; // bar position / hole
  fuel?: number; // gallons at session start
  tires_id?: number; // parts.id refs — which consumables were on the car
  pads_f_id?: number;
  pads_r_id?: number;
  notes?: string;
};

const SETUP_GROUPS: [keyof SetupSheet, "corners" | "axle", number, number][] = [
  ["tp_cold", "corners", 0, 100],
  ["tp_hot", "corners", 0, 100],
  ["camber", "axle", -10, 10],
  ["toe", "axle", -5, 5],
  ["caster", "axle", 0, 15],
  ["rebound", "axle", 0, 99],
  ["compression", "axle", 0, 99],
  ["sway", "axle", 0, 99],
];
const CORNER_KEYS: CornerKey[] = ["fl", "fr", "rl", "rr"];
const AXLE_KEYS: AxleKey[] = ["f", "r"];

// Normalize a setup sheet. Returns null when nothing usable remains (clear),
// undefined when a known field holds an implausible value (reject).
export function sanitizeSetup(v: unknown): SetupSheet | null | undefined {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const out: SetupSheet = {};

  for (const [name, shape, min, max] of SETUP_GROUPS) {
    const raw = o[name];
    if (raw == null) continue;
    if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const group: Record<string, number> = {};
    for (const key of shape === "corners" ? CORNER_KEYS : AXLE_KEYS) {
      const val = (raw as Record<string, unknown>)[key];
      if (val == null) continue;
      if (typeof val !== "number" || !Number.isFinite(val) || val < min || val > max) return undefined;
      group[key] = Math.round(val * 100) / 100;
    }
    if (Object.keys(group).length) (out as Record<string, unknown>)[name] = group;
  }

  if (o.fuel != null) {
    if (typeof o.fuel !== "number" || !Number.isFinite(o.fuel) || o.fuel < 0 || o.fuel > 50) return undefined;
    out.fuel = Math.round(o.fuel * 10) / 10;
  }
  for (const ref of ["tires_id", "pads_f_id", "pads_r_id"] as const) {
    const val = o[ref];
    if (val == null) continue;
    if (typeof val !== "number" || !Number.isInteger(val) || val <= 0) return undefined;
    out[ref] = val;
  }
  if (o.notes != null) {
    if (typeof o.notes !== "string" || o.notes.length > 2000) return undefined;
    const notes = o.notes.trim();
    if (notes) out.notes = notes;
  }

  return Object.keys(out).length ? out : null;
}

export type ChecklistItem = { text: string; done: boolean };

// Normalize a prep checklist: null clears it, a valid array is trimmed and
// coerced to {text, done}. Returns undefined when the input isn't a checklist.
export function sanitizeChecklist(v: unknown): ChecklistItem[] | null | undefined {
  if (v == null) return null;
  if (!Array.isArray(v) || v.length > 100) return undefined;
  const items: ChecklistItem[] = [];
  for (const raw of v) {
    if (typeof raw !== "object" || raw === null) return undefined;
    const text = String((raw as Record<string, unknown>).text ?? "").trim();
    if (!text || text.length > 200) return undefined;
    items.push({ text, done: Boolean((raw as Record<string, unknown>).done) });
  }
  return items;
}
