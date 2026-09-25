// Garage logbook helpers — pure, unit-testable. Setup-sheet field spec
// (mirrors sanitizeSetup in src/lib/validate.ts — keep in sync), setup
// diffing for the correlation views, and consumable wear/status formatting.
//
// Unit handling: a sheet is stored in one system (psi, gallons — the ranges
// sanitizeSetup enforces) and shown in the user's (see js/units.js). The
// conversions here are the only place the two meet: setupToDisplay on the way
// to a form or summary, setupToStored on the way back.

import { fmtOdometer, isMetric, L_PER_GAL, PSI_PER_BAR } from "./units.js";

// ---------- consumable part kinds --------------------------------------------

export const PART_KINDS = [
  ["pads_front", "Front pads"],
  ["pads_rear", "Rear pads"],
  ["tires", "Tires (full set)"],
  ["tires_front", "Front tires"],
  ["tires_rear", "Rear tires"],
  ["rotors_front", "Front rotors"],
  ["rotors_rear", "Rear rotors"],
  ["brake_fluid", "Brake fluid"],
  ["oil", "Oil"],
  ["other", "Other"],
];
export const partKindLabel = (kind) => (PART_KINDS.find(([k]) => k === kind) || [])[1] ?? kind;

// A full set and a front or rear pair are all tyres: tread depth, heat cycles.
export const isTireKind = (kind) => kind === "tires" || kind === "tires_front" || kind === "tires_rear";

// Which kinds share a place on the car with `kind` — what equipping a part
// takes off. Mirrors equipSwapKinds in src/lib/wear.ts; keep the two in step.
export function equipSwapKinds(kind) {
  if (kind === "other") return [];
  if (kind === "tires") return ["tires", "tires_front", "tires_rear"];
  if (kind === "tires_front" || kind === "tires_rear") return [kind, "tires"];
  return [kind];
}

// The equipped parts equipping `part` would take off the car, from a
// vehicle's /garage parts — the server makes the same choice
// (POST /parts/:id/equip); this is only so the switch can say so first.
export const equipSwapsOff = (part, parts) => {
  const kinds = equipSwapKinds(part.kind);
  return parts.filter((p) => p.id !== part.id && p.equipped && !p.retired_on && kinds.includes(p.kind));
};

// The part's name with its size, when it has one: "Hoosier A7 · 285/30R18".
export const partTitle = (p) => (p.size ? `${p.name} · ${p.size}` : p.name);

// Suggested replace-at levels shown as form placeholders (not enforced).
// Pads and rotors are specified in millimetres on both sides of the Atlantic;
// only tread depth changes idiom (32nds of an inch vs. mm). The imperial table
// is the one pinned by contracts/logic/garage-status.json.
export const WEAR_LIMIT_HINTS = {
  pads_front: "3 (mm)",
  pads_rear: "3 (mm)",
  tires: "3 (32nds)",
  tires_front: "3 (32nds)",
  tires_rear: "3 (32nds)",
  rotors_front: "28 (mm)",
  rotors_rear: "26 (mm)",
};
export const WEAR_LIMIT_HINTS_METRIC = { ...WEAR_LIMIT_HINTS, tires: "3 (mm)", tires_front: "3 (mm)", tires_rear: "3 (mm)" };
export const wearLimitHint = (kind, units) =>
  (isMetric(units) ? WEAR_LIMIT_HINTS_METRIC : WEAR_LIMIT_HINTS)[kind] ?? "";

// The unit a new wear measurement is offered in. A measurement stores its own
// unit string, so this is only a default — a part's later measurements follow
// its first one (see the measurement form in app.js).
export const defaultMeasurementUnit = (kind, units) =>
  isTireKind(kind) && !isMetric(units) ? "32nds" : "mm";

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
  ["tires_f_id", "Front tires", "tires_front"],
  ["tires_r_id", "Rear tires", "tires_rear"],
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

// ---------- the car's own odometer (#192) -------------------------------------
//
// GET /garage carries the odometer reading from the car's own recorder beside
// the hours estimate — `odometer` on a vehicle ({ km, on, readings, other_car })
// and on a part ({ km, from, to, readings }), each null without enough
// readings (src/lib/odometer.ts). Only video imports carry one, so the words
// always say "recorded session" and never imply the picture is complete.
// Ported under the same names and pinned by contracts/logic/garage-status.json.

export function vehicleOdometerLine(odo, units) {
  if (!odo) return null;
  const line = `Odometer: ${fmtOdometer(odo.km, units)} at the last recorded session (${odo.on})`;
  if (!odo.other_car) return line;
  return `${line} · ${odo.other_car} lower reading${odo.other_car === 1 ? "" : "s"} skipped as another car's`;
}

export function partOdometerLine(odo, units) {
  if (!odo) return null;
  return `Odometer: ${fmtOdometer(odo.km, units)} between its first and last recorded sessions`;
}

export const fmtCost = (cents) =>
  cents == null ? null : `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

// ---------- car catalog (#222) ---------------------------------------------
//
// The vehicle form's catalog picker: one searchable field over
// GET /api/car-catalog rather than year → make → model dropdowns. Ported to the
// iOS Kit and Android :core under the same names and pinned by
// contracts/logic/car-catalog-match.json, so "c7" ranks the Corvette row the
// same on every client.

// "Chevrolet Corvette C7" — the name a pick writes into an *empty* name field.
export const catalogCarName = (row) => [row.make, row.model, row.generation].filter(Boolean).join(" ");

// "2014–2019", or "2020–" while still in production.
export const catalogCarYears = (row) =>
  row.year_to == null ? `${row.year_from}–` : `${row.year_from}–${row.year_to}`;

// "Chevrolet Corvette · C7 · 2014–2019" — how a picker row reads. The
// generation and the year span are what disambiguate seven Corvettes, so they
// are rendered rather than the bare model name repeated.
export const catalogCarLabel = (row) =>
  [`${row.make} ${row.model}`, row.generation, catalogCarYears(row)].filter(Boolean).join(" · ");

// How well one query token fits a row: 3 for a whole word ("c7"), 2 for a word
// prefix ("corv"), 1 for a substring anywhere, 0 for no fit. Words are compared
// both as written and with punctuation stripped, so "mx5" finds "MX-5". A
// four-digit token that matches nothing by name is tried as a model year
// inside the row's span, so "corvette 2017" finds the C7.
function tokenScore(token, words, row) {
  let best = 0;
  for (const w of words) {
    const plain = w.replace(/[^a-z0-9]/g, "");
    if (w === token || plain === token) best = Math.max(best, 3);
    else if (w.startsWith(token) || plain.startsWith(token)) best = Math.max(best, 2);
    else if (w.includes(token) || plain.includes(token)) best = Math.max(best, 1);
  }
  if (best === 0 && /^\d{4}$/.test(token)) {
    const year = Number(token);
    if (year >= row.year_from && (row.year_to == null || year <= row.year_to)) best = 2;
  }
  return best;
}

// The catalog rows matching a query, best first. Every whitespace-separated
// token has to fit the row somewhere (make, model, generation or year span),
// so "chevrolet corvette" narrows rather than widens; ties keep the catalog's
// own order (make / model / first year), and an empty query is the whole list.
export function matchCatalogCars(query, rows) {
  const tokens = String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return rows.slice();
  const scored = [];
  rows.forEach((row, i) => {
    const words = catalogCarName(row).toLowerCase().split(" ");
    let score = 0;
    for (const t of tokens) {
      const s = tokenScore(t, words, row);
      if (s === 0) return;
      score += s;
    }
    scored.push({ row, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.row);
}

export const CATALOG_GEOMETRY_FIELDS = ["wheelbase_mm", "steering_ratio"];

// What picking `row` may do to each of the two numbers already on the form —
// the "pre-fill, never overwrite" rule, decided per field:
//
//   fill — write the catalog's value (null included: a car re-picked from a C7
//          to a car with no single ratio must not keep the C7's)
//   ask  — the number is the driver's and differs; ask before replacing it
//   keep — nothing to do (already equal, or the driver's own number and the
//          catalog has nothing better than "unknown")
//
// A number is the driver's when it is set and is not what the previous pick
// (`previous`, the row the form's numbers came from, or null for a car typed
// by hand) filled in — so a corrected ratio survives a re-pick behind a
// question, and an untouched one is replaced silently.
export function catalogPrefill(row, current, previous) {
  const plan = {};
  for (const field of CATALOG_GEOMETRY_FIELDS) {
    const value = row[field] ?? null;
    const cur = current?.[field] ?? null;
    const driverOwned = cur != null && (previous == null || cur !== (previous[field] ?? null));
    let action;
    if (cur === value) action = "keep";
    else if (!driverOwned) action = "fill";
    else if (value == null) action = "keep";
    else action = "ask";
    plan[field] = { value, action };
  }
  return plan;
}

// ---- a car's logbook (NS-37) ---------------------------------------------------
//
// The free half of a car's garage page and tile: what it has done, from the
// event list every client already caches — so it costs no request and works
// offline. Rows belong to the car by `vehicle_id`, which the server matched
// from the car name on save; a row whose `car` text merely reads the same is
// *not* counted here, because the server is the one place that match is made.
// Past means `start_date <= today` (the totals' rule: a track day that starts
// today counts). Hours are deliberately absent — they are the wear math's,
// arrive computed on the Pro GET /api/garage, and a client copy would be a
// fifth one.
//
// `bests` is one row per track the car has a time at, using each event's
// computed `best_ms` (a manual best counts, per withComputed), ordered by the
// car's most recent event at that track; within a track the fastest wins and a
// tie keeps the earlier event, the day the time was first set.
const eventOrder = (a, b) => a.start_date.localeCompare(b.start_date) || a.id - b.id;

const eventRef = (e) =>
  e ? { id: e.id, track_id: e.track_id, track_name: e.track_name, start_date: e.start_date } : null;

export function vehicleLogbook(vehicleId, events, today) {
  const mine = (events ?? []).filter((e) => e.vehicle_id != null && e.vehicle_id === vehicleId).sort(eventOrder);
  const past = mine.filter((e) => e.start_date <= today);
  const upcoming = mine.filter((e) => e.start_date > today);
  const byTrack = new Map();
  for (const e of past) {
    const row = byTrack.get(e.track_id) ?? { latest: e, best: null };
    row.latest = e; // `past` is ascending, so the last one seen is the latest
    if (e.best_ms != null && (row.best == null || e.best_ms < row.best.best_ms)) row.best = e;
    byTrack.set(e.track_id, row);
  }
  const bests = [...byTrack.values()]
    .filter((r) => r.best)
    .sort((a, b) => eventOrder(b.latest, a.latest))
    .map(({ best }) => ({
      track_id: best.track_id,
      track_name: best.track_name,
      best_ms: best.best_ms,
      event_id: best.id,
      start_date: best.start_date,
    }));
  return {
    track_days: past.reduce((sum, e) => sum + (e.days ?? 0), 0),
    events: past.length,
    last_event: eventRef(past[past.length - 1]),
    next_event: eventRef(upcoming[0]),
    bests,
  };
}

// The one line a car's tile carries. No date in it: a date is locale work, and
// three clients writing the same words is the point of pinning it.
export function vehicleTileLine(logbook) {
  const { track_days: days, last_event: last, next_event: next } = logbook;
  if (last) return `${days} track day${days === 1 ? "" : "s"} · last at ${last.track_name}`;
  if (next) return `Next: ${next.track_name}`;
  return "No track days yet";
}
