// The driver profile (NS-38): the field spec every client's form renders, and
// the grouped lines a coach reads. Mirrors `sanitizeProfile` in
// src/lib/profile.ts — the server is the one that validates, so a field added
// here without it is dropped on save; keep the two in step.
//
// Deliberately no birth date and no emergency contact: an instructor asks for
// both at the track, and a logbook that never holds them never has to protect
// them.
//
// Pure, so contracts/logic/coaching.json can pin `profileSections` for the iOS
// and Android ports.

export const HELMET_RATINGS = Object.freeze([
  ["SA2020", "Snell SA2020"],
  ["SA2025", "Snell SA2025"],
  ["SAH2020", "Snell SAH2020"],
  ["FIA8859", "FIA 8859"],
  ["M", "Snell M (motorcycle)"],
  ["other", "Other"],
]);

export const HEAD_NECK = Object.freeze([
  ["none", "None"],
  ["hans", "HANS"],
  ["hybrid", "Hybrid-style"],
  ["other", "Other"],
]);

// `kind`: text (one line, 200 chars), long (a box, 1,000), year, select, bool.
// `max` is the server's cap, so the form can stop a save before it is refused.
export const PROFILE_GROUPS = Object.freeze([
  {
    title: "About you",
    fields: [{ key: "occupation", label: "Occupation", kind: "text", max: 200, placeholder: "Engineer, nurse, pilot…" }],
  },
  {
    title: "Experience",
    fields: [
      { key: "first_track_year", label: "First track day (year)", kind: "year", placeholder: "2019" },
      { key: "experience", label: "Other driving", kind: "long", max: 1000, placeholder: "Karting since 2012, autocross, sim racing…" },
      { key: "license", label: "Competition licence", kind: "text", max: 200, placeholder: "NASA HPDE4, SCCA novice…" },
      { key: "instruction", label: "Instruction so far", kind: "long", max: 1000, placeholder: "Two schools, signed off to solo in 2024…" },
    ],
  },
  {
    title: "Safety gear",
    fields: [
      { key: "helmet", label: "Helmet", kind: "text", max: 200, placeholder: "Make and model" },
      { key: "helmet_rating", label: "Helmet rating", kind: "select", options: HELMET_RATINGS },
      { key: "head_neck", label: "Head & neck restraint", kind: "select", options: HEAD_NECK },
      { key: "suit", label: "Suit", kind: "text", max: 200, placeholder: "Single-layer SFI 3.2A/1…" },
      { key: "gloves", label: "Driving gloves", kind: "bool" },
      { key: "shoes", label: "Driving shoes", kind: "bool" },
      { key: "gear_notes", label: "Anything else about your gear", kind: "long", max: 1000, placeholder: "Wears glasses, arm restraints…" },
    ],
  },
  {
    title: "Coaching",
    fields: [
      { key: "goals", label: "What I want to work on", kind: "long", max: 1000, placeholder: "Trail braking into T1, carrying speed through the esses…" },
      { key: "for_instructor", label: "Anything your instructor should know", kind: "long", max: 1000, placeholder: "An old injury, nerves in traffic, first time in this car…" },
    ],
  },
]);

export const PROFILE_FIELDS = Object.freeze(PROFILE_GROUPS.flatMap((g) => g.fields));

const optionLabel = (options, value) => options.find(([v]) => v === value)?.[1] ?? null;

// One field's value as a coach reads it, or null when there is nothing to say.
// A boolean is said either way — "No" driving gloves is something an
// instructor wants to know before the first session.
export function profileValueText(field, value) {
  if (value == null || value === "") return null;
  switch (field.kind) {
    case "bool":
      return value ? "Yes" : "No";
    case "select":
      return optionLabel(field.options, value) ?? String(value);
    case "year":
      return String(value);
    default: {
      const s = String(value).trim();
      return s || null;
    }
  }
}

// The profile as grouped lines: `[{ title, rows: [{ key, label, value }] }]`,
// with empty fields and then empty groups left out, so a half-filled profile
// reads as what it says rather than as a form full of blanks.
export function profileSections(profile) {
  if (!profile) return [];
  return PROFILE_GROUPS.map((g) => ({
    title: g.title,
    rows: g.fields
      .map((f) => ({ key: f.key, label: f.label, value: profileValueText(f, profile[f.key]) }))
      .filter((r) => r.value != null),
  })).filter((g) => g.rows.length);
}

// The request body from a form's raw values (strings from inputs and selects,
// booleans from checkboxes): blanks become null — which the server reads as
// "not set" — and the year becomes a number. Validation stays the server's.
export function profileBody(values) {
  const out = {};
  for (const f of PROFILE_FIELDS) {
    const raw = values[f.key];
    if (f.kind === "bool") {
      // A three-way choice on the form (not said / yes / no), because an
      // unticked box would say "No" about something the driver never answered.
      out[f.key] = raw === true || raw === "yes" ? true : raw === false || raw === "no" ? false : null;
    } else if (f.kind === "year") {
      const s = String(raw ?? "").trim();
      out[f.key] = s === "" ? null : Number(s);
    } else {
      const s = String(raw ?? "").trim();
      out[f.key] = s === "" ? null : s;
    }
  }
  return out;
}
