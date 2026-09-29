// The driver profile (NS-38): what a driver tells their instructor or coach
// about themselves — occupation, how much they have driven, what they wear,
// and what they want to work on. Deliberately no birth date or emergency
// contact: an instructor asks for those at the track, and a logbook that
// never holds them never has to protect them. Stored as JSON in
// `users.profile` (migration 0031), seen by its owner and the owner's coaches
// only.
//
// Every field is optional, and a profile with none set is stored as NULL.
// Validation is the `sanitizeSetup` shape: unknown keys are dropped, a present
// field that fails its rule rejects the whole body — but unlike a setup sheet
// the answer carries *which* rule, so a form can say what to fix rather than
// "invalid profile".
//
// public/js/profile.js is the client-side field spec the three forms render;
// keep the two in step.

export const HELMET_RATINGS = ["SA2020", "SA2025", "SAH2020", "FIA8859", "M", "other"] as const;
export type HelmetRating = (typeof HELMET_RATINGS)[number];

export const HEAD_NECK = ["none", "hans", "hybrid", "other"] as const;
export type HeadNeck = (typeof HEAD_NECK)[number];

export type DriverProfile = {
  occupation?: string;
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

// Short fields are an occupation, a licence or a helmet model; long ones are
// the free-text boxes.
export const SHORT_TEXT_MAX = 200;
export const LONG_TEXT_MAX = 1000;

const SHORT_TEXT = ["occupation", "license", "helmet", "suit"] as const;
const LONG_TEXT = ["experience", "instruction", "gear_notes", "goals", "for_instructor"] as const;
const BOOLEANS = ["gloves", "shoes"] as const;

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
