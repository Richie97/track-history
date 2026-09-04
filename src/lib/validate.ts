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
export type ChannelName =
  | "speed" | "rpm" | "latG" | "throttle" | "brake" | "steering"
  | "longG" | "yaw" | "gear" | "wheelSlip" | "boost" | "flags";
export type ScalarName =
  | "oilC" | "oilKpa" | "coolantC" | "transC" | "fuelPct" | "battV"
  | "tyreKpaLF" | "tyreKpaRF" | "tyreKpaLR" | "tyreKpaRR"
  | "tyreCLF" | "tyreCRF" | "tyreCLR" | "tyreCRR";
export type MetaName = "ambientC" | "intakeC" | "elevationM" | "odometerKm";

export type LapChannelEntry = { n: number; timeMs: number } & Partial<
  Record<ChannelName, number[]>
> &
  Partial<Record<ScalarName, number>>;
export type ChannelMeta = Partial<Record<MetaName, number>>;
export type LapChannels = { v: 1; dStepM: number; meta?: ChannelMeta; laps: LapChannelEntry[] };

// name, max plausible value, rounding factor, min plausible value. Order
// mirrors CHANNEL_NAMES in public/js/import/channels.js, whose tail the
// importer drops first when a session overruns the value budget.
const CHANNEL_SPECS: [ChannelName, number, number, number][] = [
  ["speed", 500, 10, 0],
  ["rpm", 25000, 1, 0],
  ["latG", 10, 1000, 0],
  ["throttle", 100, 10, 0],
  ["brake", 100, 10, 0],
  // steering-wheel degrees, signed; PDR's dictionary encodes at most ±2048°
  ["steering", 2048, 10, -2048],
  // longitudinal G, signed: negative under braking
  ["longG", 10, 1000, -10],
  ["yaw", 360, 10, -360],
  // gear 1-8; 0 is the clutch-in / no-gear state, not a gear
  ["gear", 8, 1, 0],
  // (driven - non-driven) wheelspeed as a percentage: + wheelspin, - lockup
  ["wheelSlip", 100, 10, -100],
  // boost is gauge pressure, so full vacuum is about -100 kPa
  ["boost", 400, 10, -110],
  // bitfield: ABS | traction control << 1 | stability control << 2
  ["flags", 7, 1, 0],
];

// Slow channels reduced to one value per lap (SCALAR_NAMES in channels.js).
// Same tuple shape; these are single numbers, so they cost nothing against
// the array budget and are validated only for plausibility.
const SCALAR_SPECS: [ScalarName, number, number, number][] = [
  ["oilC", 250, 10, -60],
  ["oilKpa", 1500, 1, 0],
  ["coolantC", 250, 10, -60],
  ["transC", 250, 10, -60],
  ["fuelPct", 100, 10, 0],
  ["battV", 40, 10, 0],
  ["tyreKpaLF", 700, 1, 0],
  ["tyreKpaRF", 700, 1, 0],
  ["tyreKpaLR", 700, 1, 0],
  ["tyreKpaRR", 700, 1, 0],
  ["tyreCLF", 250, 10, -60],
  ["tyreCRF", 250, 10, -60],
  ["tyreCLR", 250, 10, -60],
  ["tyreCRR", 250, 10, -60],
];

// One value for the whole session (META_NAMES in channels.js). `odometerKm`
// is the car's lifetime odometer as the recorder saw it, not the session's
// distance.
const META_SPECS: [MetaName, number, number, number][] = [
  ["ambientC", 70, 10, -60],
  ["intakeC", 150, 10, -60],
  ["elevationM", 3000, 1, 0],
  ["odometerKm", 3000000, 1, 0],
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
    for (const [name, max, f, min] of SCALAR_SPECS) {
      const x = l[name];
      if (x == null) continue;
      if (typeof x !== "number" || !Number.isFinite(x) || x < min || x > max) return undefined;
      entry[name] = Math.round(x * f) / f;
    }
    laps.push(entry);
  }
  // Hard budget on stored size: 120k values is roughly 800KB of JSON — well
  // under D1's 2MB per-value cap; real sessions (25 laps × 6 channels × ~150
  // points) land far under it. Mirrored by MAX_TOTAL_VALUES in
  // public/js/import/channels.js.
  if (points > 120000) return undefined;
  const out: LapChannels = { v: 1, dStepM, laps };
  if (o.meta != null) {
    if (typeof o.meta !== "object" || Array.isArray(o.meta)) return undefined;
    const raw = o.meta as Record<string, unknown>;
    const meta: ChannelMeta = {};
    for (const [name, max, f, min] of META_SPECS) {
      const x = raw[name];
      if (x == null) continue;
      if (typeof x !== "number" || !Number.isFinite(x) || x < min || x > max) return undefined;
      meta[name] = Math.round(x * f) / f;
    }
    if (Object.keys(meta).length) out.meta = meta;
  }
  return out;
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

// Normalize a user's prep-checklist template: null clears it (falling back to
// the app's built-in default), a valid array is trimmed. Returns undefined when
// the input isn't a template.
//
// Strings, not {text, done}: a template is what a checklist starts *from*, so
// carrying done flags would only invite an item that arrives pre-ticked. The
// caps match sanitizeChecklist's, since one becomes the other.
export function sanitizeChecklistTemplate(v: unknown): string[] | null | undefined {
  if (v == null) return null;
  if (!Array.isArray(v) || v.length > 100) return undefined;
  const items: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") return undefined;
    const text = raw.trim();
    if (!text || text.length > 200) return undefined;
    items.push(text);
  }
  // An empty list is a cleared template, not a template with nothing in it —
  // otherwise "delete every item" would leave the user with no default at all
  // and no way back to one.
  return items.length ? items : null;
}

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
