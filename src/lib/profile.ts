// The driver profile (NS-38): what a driver tells their instructor or coach
// about themselves — age, occupation, who to call, how much they have driven,
// what they wear, and what they want to work on. Stored as JSON in
// `users.profile` (migration 0031), seen by its owner and the owner's coaches
// only.
//
// Every field is optional, and a profile with none set is stored as NULL.
// Validation is the `sanitizeSetup` shape: unknown keys are dropped, a present
// field that fails its rule rejects the whole body — but unlike a setup sheet
// the answer carries *which* rule, because a birth date refused for being
// under 13 needs to say so rather than "invalid profile".
//
// public/js/profile.js is the client-side field spec the three forms render;
// keep the two in step.

export const HELMET_RATINGS = ["SA2020", "SA2025", "SAH2020", "FIA8859", "M", "other"] as const;
export type HelmetRating = (typeof HELMET_RATINGS)[number];

export const HEAD_NECK = ["none", "hans", "hybrid", "other"] as const;
export type HeadNeck = (typeof HEAD_NECK)[number];

export type DriverProfile = {
  date_of_birth?: string;
  occupation?: string;
  emergency_name?: string;
  emergency_phone?: string;
  first_track_year?: number;
  experience?: string;
  license?: string;
  instruction?: string;
  helmet?: string;
  helmet_rating?: HelmetRating;
  head_neck?: HeadNeck;
  suit?: string;
  gloves?: boolean;
  shoes?: boolean;
  gear_notes?: string;
  goals?: string;
  for_instructor?: string;
};

// Short fields are a name, a phone number or a helmet model; long ones are the
// free-text boxes.
export const SHORT_TEXT_MAX = 200;
export const LONG_TEXT_MAX = 1000;

const SHORT_TEXT = ["occupation", "emergency_name", "emergency_phone", "license", "helmet", "suit"] as const;
const LONG_TEXT = ["experience", "instruction", "gear_notes", "goals", "for_instructor"] as const;
const BOOLEANS = ["gloves", "shoes"] as const;

// The privacy policy says the app is not directed at children under 13, and a
// typed birth date is actual knowledge of age — so one under 13 is refused
// rather than stored. Whether *coaching* needs an older minimum is a terms
// decision, not this one.
export const MIN_PROFILE_AGE = 13;
export const MAX_PROFILE_AGE = 120;

const isIsoDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

// Whole years between a yyyy-mm-dd birth date and `today` (also yyyy-mm-dd).
// Compared as strings so no time zone is involved: a birthday has happened
// when today's month-day has reached it. A 29 February birthday therefore
// comes round on 1 March in a common year.
export function ageOn(dob: string, today: string): number {
  const years = Number(today.slice(0, 4)) - Number(dob.slice(0, 4));
  return today.slice(5) >= dob.slice(5) ? years : years - 1;
}

export type ProfileResult = { profile: DriverProfile | null } | { error: string };

export function sanitizeProfile(v: unknown, today: string): ProfileResult {
  if (v == null) return { profile: null };
  if (typeof v !== "object" || Array.isArray(v)) return { error: "profile must be an object" };
  const o = v as Record<string, unknown>;
  const out: DriverProfile = {};

  const text = (key: string, max: number): string | undefined | { error: string } => {
    const raw = o[key];
    if (raw == null) return undefined;
    if (typeof raw !== "string") return { error: `${key} must be text` };
    const s = raw.trim();
    if (s.length > max) return { error: `${key} must be at most ${max} characters` };
    return s || undefined;
  };

  for (const [keys, max] of [[SHORT_TEXT, SHORT_TEXT_MAX], [LONG_TEXT, LONG_TEXT_MAX]] as const) {
    for (const key of keys) {
      const r = text(key, max);
      if (typeof r === "object") return r;
      if (r !== undefined) out[key] = r;
    }
  }

  if (o.date_of_birth != null && o.date_of_birth !== "") {
    const dob = o.date_of_birth;
    if (!isIsoDate(dob)) return { error: "date_of_birth must be a yyyy-mm-dd date" };
    if (dob > today) return { error: "date_of_birth can't be in the future" };
    const age = ageOn(dob, today);
    if (age < MIN_PROFILE_AGE) return { error: `Track Evolution isn't for anyone under ${MIN_PROFILE_AGE}` };
    if (age > MAX_PROFILE_AGE) return { error: "date_of_birth is too far in the past" };
    out.date_of_birth = dob;
  }

  if (o.first_track_year != null && o.first_track_year !== "") {
    const y = o.first_track_year;
    if (typeof y !== "number" || !Number.isInteger(y) || y < 1900 || y > Number(today.slice(0, 4)))
      return { error: "first_track_year must be a year no later than this one" };
    out.first_track_year = y;
  }

  if (o.helmet_rating != null && o.helmet_rating !== "") {
    if (!(HELMET_RATINGS as readonly unknown[]).includes(o.helmet_rating))
      return { error: `helmet_rating must be one of ${HELMET_RATINGS.join(", ")}` };
    out.helmet_rating = o.helmet_rating as HelmetRating;
  }
  if (o.head_neck != null && o.head_neck !== "") {
    if (!(HEAD_NECK as readonly unknown[]).includes(o.head_neck))
      return { error: `head_neck must be one of ${HEAD_NECK.join(", ")}` };
    out.head_neck = o.head_neck as HeadNeck;
  }

  for (const key of BOOLEANS) {
    const b = o[key];
    if (b == null) continue;
    if (typeof b !== "boolean") return { error: `${key} must be true or false` };
    out[key] = b;
  }

  return { profile: Object.keys(out).length ? out : null };
}

// A stored profile back out of its column. Malformed JSON, or a row that no
// longer passes today's rules, degrades to null rather than making the page
// that shows it fail (the parseTemplate rule in routes/me.ts).
export function parseProfile(raw: unknown, today: string): DriverProfile | null {
  if (typeof raw !== "string") return null;
  try {
    const r = sanitizeProfile(JSON.parse(raw), today);
    return "profile" in r ? r.profile : null;
  } catch {
    return null;
  }
}
