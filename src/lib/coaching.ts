// What a coach can read of a student's logbook (NS-38).
//
// A coach reads through /api/students/:id/*, which runs the ordinary /api
// routes as the student (routes/coaching.ts). This module is the rule for
// which of those routes a coach may reach and what each answers them, kept
// pure so it is unit-tested rather than inspected.
//
// The paths and the views are **one table**, so a route cannot be reachable
// without a view deciding its fields. And every view is an **allow-list**: it
// copies the fields a coach may see rather than deleting the ones they may
// not — the rule `publicLapChannels` follows in lib/leaderboard.ts — so a
// column added to `events` later stays out of a coach's reach until someone
// adds it here on purpose.
//
// What is hidden but still has a place in the shape (notes, the checklist, the
// cost line items, the setup sheets) is sent *empty* — null, or [] for a list —
// rather than dropped, so the native Event / Session / Track models decode a
// coach's response with no second model. Anything neither allowed nor hidden
// is dropped.
//
// Shared: the lap data (events, sessions, laps, the trace, `channels` — already
// stripped to the *student's* tier by stripProFields — and the recorded
// conditions), the vehicle list (the car and its modifications, which live in
// the vehicle's notes), the measured steering ratio, the driver profile and
// the two seeded catalogs. Not shared, because they are not on this table:
// /me (email, billing, consents), /me/connections, /garage (parts, wear, costs,
// odometer), the setup routes, the leaderboards, Season Wrapped and anything
// that writes.

type Json = Record<string, unknown>;
export type CoachView = (body: unknown) => unknown;

function pick(row: unknown, fields: readonly string[], hidden: Json = {}): Json {
  const src = (row && typeof row === "object" ? row : {}) as Json;
  const out: Json = {};
  for (const f of fields) if (Object.hasOwn(src, f)) out[f] = src[f];
  for (const [f, empty] of Object.entries(hidden)) if (Object.hasOwn(src, f)) out[f] = empty;
  return out;
}

const list = (view: (row: unknown) => Json): CoachView => (body) => (Array.isArray(body) ? body.map(view) : []);
const pass: CoachView = (body) => body;

// An event row, as /events lists it and /events/:id heads it.
export const COACH_EVENT_FIELDS = [
  "id", "track_id", "track_name", "start_date", "days", "club", "run_group", "car", "vehicle_id",
  "conditions", "temp_f", "best_time_ms", "track_hours", "updated_at",
  "best_ms", "lap_best_ms", "lap_count", "session_count", "consistency", "hours",
  "ambient_lo_c", "ambient_hi_c", "elevation_m",
] as const;
const EVENT_HIDDEN: Json = {
  notes: null,
  checklist: null,
  cost_entry_cents: null,
  cost_fuel_cents: null,
  cost_travel_cents: null,
  cost_misc_cents: null,
  cost_cents: null,
};

export const COACH_SESSION_FIELDS = ["id", "label", "sort", "trace", "channels", "ambient_c", "elevation_m"] as const;
export const COACH_LAP_FIELDS = ["id", "session_id", "lap_num", "time_ms"] as const;
export const COACH_TRACK_FIELDS = [
  "id", "name", "catalog_id", "goal_ms", "updated_at", "best_ms", "event_count", "track_days", "last_date", "series",
] as const;
// The whole vehicle row: the car, its modifications (in `notes`, which the
// form labels "modifications & notes"), and its geometry.
export const COACH_VEHICLE_FIELDS = [
  "id", "name", "notes", "is_default", "target_hot_psi", "catalog_id", "wheelbase_mm", "steering_ratio",
] as const;

// A session's channel blob, rebuilt by allow-list like everything else here.
// The per-lap entries are the lap data a coach is invited to read — every
// trace and the per-lap scalars behind the Car tab, already cut to the
// student's tier by stripProFields — so they are copied whole. The recording's
// `meta` is not: `odometerKm` is the car's lifetime odometer, which the spec
// keeps out of a coach's reach with the rest of the garage (the leaderboard
// drops it for the same reason, in publicLapChannels), and `intakeC` is the
// car's condition, which nothing in a coach's view reads. What stays is the
// weather the conditions tag shows.
export const COACH_CHANNEL_FIELDS = ["v", "dStepM", "laps"] as const;
export const COACH_META_FIELDS = ["ambientC", "elevationM"] as const;
function coachChannels(channels: unknown): unknown {
  if (!channels || typeof channels !== "object") return channels ?? null;
  const out = pick(channels, COACH_CHANNEL_FIELDS);
  const meta = pick((channels as Json).meta, COACH_META_FIELDS);
  if (Object.keys(meta).length) out.meta = meta;
  return out;
}

const coachEvent = (row: unknown) => pick(row, COACH_EVENT_FIELDS, EVENT_HIDDEN);
const coachLap = (row: unknown) => pick(row, COACH_LAP_FIELDS);
const coachSession = (row: unknown) => {
  const out = pick(row, COACH_SESSION_FIELDS, { notes: null });
  if (Object.hasOwn(out, "channels")) out.channels = coachChannels(out.channels);
  const laps = (row as Json | null)?.laps;
  out.laps = Array.isArray(laps) ? laps.map(coachLap) : [];
  return out;
};
const coachEventDetail: CoachView = (body) => {
  const out = coachEvent(body);
  const sessions = (body as Json | null)?.sessions;
  out.sessions = Array.isArray(sessions) ? sessions.map(coachSession) : [];
  out.setups = [];
  return out;
};
const coachTrack = (row: unknown) => pick(row, COACH_TRACK_FIELDS, { notes: null });
const coachVehicle = (row: unknown) => pick(row, COACH_VEHICLE_FIELDS);
// The driver profile under the mount: the student's name, picture and tier
// beside the profile, which parseProfile has already rebuilt from its own
// field list.
export const COACH_PROFILE_FIELDS = ["id", "name", "picture", "pro", "profile"] as const;
const coachProfile: CoachView = (body) => pick(body, COACH_PROFILE_FIELDS);
export const COACH_FIT_FIELDS = ["session_id", "event_id", "start_date", "gain0", "K", "samples", "r2"] as const;
const coachFits: CoachView = (body) => {
  const fits = (body as Json | null)?.fits;
  return { fits: Array.isArray(fits) ? fits.map((f) => pick(f, COACH_FIT_FIELDS)) : [] };
};

// Paths are relative to the mount — what the route itself is registered as.
// GET only; the mount refuses every other method before looking here.
export const COACH_ROUTES: readonly { path: RegExp; view: CoachView }[] = [
  { path: /^\/me\/profile$/, view: coachProfile },
  { path: /^\/events$/, view: list(coachEvent) },
  { path: /^\/events\/\d+$/, view: coachEventDetail },
  { path: /^\/tracks$/, view: list(coachTrack) },
  { path: /^\/vehicles$/, view: list(coachVehicle) },
  // Per-session fits (ids, dates and two numbers) — Pro, so under the
  // student's tier it is the 402 the student would get.
  { path: /^\/vehicles\/\d+\/steering-fit$/, view: coachFits },
  // The two seeded catalogs: shared reference data, nothing of the student's.
  { path: /^\/catalog$/, view: pass },
  { path: /^\/car-catalog$/, view: pass },
];

export function coachRoute(method: string, path: string): CoachView | null {
  if (method !== "GET") return null;
  return COACH_ROUTES.find((r) => r.path.test(path))?.view ?? null;
}

// Invite and grant limits. An invite link is 256 random bits, so guessing one
// is not the threat these guard against; a runaway client minting links, or a
// logbook shared with a crowd, is.
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_OPEN_INVITES = 10;
export const MAX_COACHES = 10;
// last_viewed_at is a courtesy for the student ("viewed 2h ago"), not an
// audit log — an hour's resolution keeps it off every read's critical path.
export const VIEW_TOUCH_MS = 60 * 60 * 1000;
