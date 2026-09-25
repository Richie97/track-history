// Season Wrapped (NS-36) — the season's numbers, pure over plain rows, no I/O.
// The route (routes/wrapped.ts) fetches; this decides. Every rule here is the
// spec's, and each has a case in test/unit/wrapped.test.ts.
//
// The season is the calendar year, past events only (`start_date <= today`,
// UTC) — the userTotals rule, and year in review's `eventYear`.

import type { ComputedEvent } from "./stats";
import { type HoursEvent, type Mount, eventHours, eventsInWindow } from "./wear";

export const METRES_PER_MILE = 1609.344;

// The event columns Wrapped reads. A ComputedEvent satisfies it; tests build
// the narrow shape directly.
export type WrappedEvent = Pick<
  ComputedEvent,
  "id" | "track_id" | "track_name" | "start_date" | "days" | "best_ms" | "lap_count" | "hours" | "temp_f" | "ambient_hi_c"
>;

export type WrappedInputs = {
  name: string | null;
  // Every event of the user's, any year, any date — filtered here.
  events: WrappedEvent[];
  // The seeded catalog length of each user track (track_catalog.length_m via
  // tracks.catalog_id), null when the track isn't in the catalog or the
  // catalog doesn't know its length.
  catalogLengths: { track_id: number; length_m: number | null }[];
  // One row per channel-carrying lap at a track, any year: dStepM × the grid
  // length, which is a gridded lap's driven distance by construction.
  channelLaps: { track_id: number; length_m: number }[];
  // Best-lap polylines ([x, y, v] in local metres) at a track, any year.
  traces: { track_id: number; trace: unknown }[];
};

export type Wrapped = {
  year: number;
  years: number[];
  through: string | null;
  name: string | null;
  totals: {
    events: number;
    track_days: number;
    tracks: number;
    laps: number;
    hours: number;
    miles: number;
    miles_tracks_counted: number;
  };
  most_driven: {
    track_id: number;
    track_name: string;
    track_days: number;
    laps: number;
    best_ms: number | null;
  } | null;
  improvement: {
    track_id: number;
    track_name: string;
    best_before: number;
    best_this_year: number;
    gain_ms: number;
    baseline: "prior_years" | "first_event";
  } | null;
  fastest: { track_id: number; track_name: string; best_ms: number; event_id: number; date: string } | null;
  new_tracks: { track_id: number; track_name: string }[];
  hottest: { event_id: number; track_name: string; date: string; temp_c: number } | null;
};

const yearOf = (e: { start_date: string }) => Number(e.start_date.slice(0, 4));
const round1 = (v: number) => Math.round(v * 10) / 10;
const byDate = (a: WrappedEvent, b: WrappedEvent) =>
  a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : a.id - b.id;

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// The length of a stored best-lap trace, closing the loop back to its first
// point: a lap starts and ends at the line, so the closing segment is the few
// metres the recorder's gate left out, never a chord across the infield.
// Null for anything that isn't a plausible trace.
export function polylineLength(trace: unknown): number | null {
  let pts = trace;
  if (typeof pts === "string") {
    try {
      pts = JSON.parse(pts);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(pts) || pts.length < 2) return null;
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (!Array.isArray(a) || !Array.isArray(b)) return null;
    const dx = Number(b[0]) - Number(a[0]);
    const dy = Number(b[1]) - Number(a[1]);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    total += Math.hypot(dx, dy);
  }
  return total > 0 ? total : null;
}

// One track's lap length in metres, first hit winning:
//   1. the catalog's seeded length;
//   2. the driver's own telemetry there — the median gridded lap distance,
//      else the median best-lap trace length;
//   3. unknown (null): the track counts zero miles and is counted out of
//      miles_tracks_counted, so the card can say "across N of M tracks".
export function lapLengthM(catalogM: number | null, channelLapsM: number[], tracesM: number[]): number | null {
  if (catalogM != null && catalogM > 0) return catalogM;
  return median(channelLapsM.filter((v) => v > 0)) ?? median(tracesM.filter((v) => v > 0));
}

// Every year with a past event, newest first — the picker.
export function wrappedYears(events: WrappedEvent[], today: string): number[] {
  return [...new Set(events.filter((e) => e.start_date <= today).map(yearOf))].sort((a, b) => b - a);
}

// The season, or null when the year has no past events (the route's 404).
export function seasonWrapped(inputs: WrappedInputs, year: number, today: string): Wrapped | null {
  const past = inputs.events.filter((e) => e.start_date <= today).sort(byDate);
  const inYear = past.filter((e) => yearOf(e) === year);
  if (!inYear.length) return null;
  const before = past.filter((e) => yearOf(e) < year);

  // --- per track -----------------------------------------------------------
  type TrackYear = {
    track_id: number;
    track_name: string;
    events: WrappedEvent[];
    track_days: number;
    laps: number;
  };
  const tracks = new Map<number, TrackYear>();
  for (const e of inYear) {
    let t = tracks.get(e.track_id);
    if (!t) {
      t = { track_id: e.track_id, track_name: e.track_name, events: [], track_days: 0, laps: 0 };
      tracks.set(e.track_id, t);
    }
    t.events.push(e);
    t.track_days += e.days ?? 0;
    t.laps += e.lap_count ?? 0;
  }
  const bestOf = (evs: WrappedEvent[]) => {
    const b = evs.map((e) => e.best_ms).filter((v): v is number => v != null);
    return b.length ? Math.min(...b) : null;
  };
  const byName = (a: { track_name: string }, b: { track_name: string }) => a.track_name.localeCompare(b.track_name);

  // --- miles ---------------------------------------------------------------
  const catalog = new Map(inputs.catalogLengths.map((r) => [r.track_id, r.length_m]));
  const lengths = new Map<number, number | null>();
  for (const id of tracks.keys()) {
    const channelM = inputs.channelLaps.filter((r) => r.track_id === id).map((r) => r.length_m);
    const traceM = inputs.traces
      .filter((r) => r.track_id === id)
      .map((r) => polylineLength(r.trace))
      .filter((v): v is number => v != null);
    lengths.set(id, lapLengthM(catalog.get(id) ?? null, channelM, traceM));
  }
  let metres = 0;
  for (const e of inYear) metres += (e.lap_count ?? 0) * (lengths.get(e.track_id) ?? 0);

  // --- most driven: most track days; ties by laps, then events -------------
  const ranked = [...tracks.values()].sort(
    (a, b) => b.track_days - a.track_days || b.laps - a.laps || b.events.length - a.events.length || byName(a, b)
  );
  const top = ranked[0];

  // --- biggest improvement -------------------------------------------------
  // Year review's gains rule first: best before the year against best in it,
  // the largest positive gain. Failing that, a first year at a track: its
  // first timed event of the year against its best that year — only for a
  // track with no prior timed baseline, since the card says "first year".
  type Gain = NonNullable<Wrapped["improvement"]>;
  const pickGain = (gains: Gain[]) =>
    gains.filter((g) => g.gain_ms > 0).sort((a, b) => b.gain_ms - a.gain_ms || byName(a, b))[0] ?? null;
  const prior: Gain[] = [];
  const firstYear: Gain[] = [];
  for (const t of tracks.values()) {
    const best = bestOf(t.events);
    if (best == null) continue;
    const priorBest = bestOf(before.filter((e) => e.track_id === t.track_id));
    if (priorBest != null) {
      prior.push({ track_id: t.track_id, track_name: t.track_name, best_before: priorBest, best_this_year: best, gain_ms: priorBest - best, baseline: "prior_years" });
    } else {
      const first = t.events.find((e) => e.best_ms != null)!;
      firstYear.push({ track_id: t.track_id, track_name: t.track_name, best_before: first.best_ms!, best_this_year: best, gain_ms: first.best_ms! - best, baseline: "first_event" });
    }
  }
  const improvement = pickGain(prior) ?? pickGain(firstYear);

  // --- fastest lap: the year's lowest best_ms, earliest on a tie -----------
  const timed = inYear.filter((e) => e.best_ms != null);
  const fastestEv = timed.reduce<WrappedEvent | null>((f, e) => (f == null || e.best_ms! < f.best_ms! ? e : f), null);

  // --- hottest day ---------------------------------------------------------
  // Each event's recorded high (the sessions' ambient_hi_c) wins over its
  // typed temp_f — eventAmbient's rule, never one written from the other — and
  // the hottest event of the year is the card. Earliest on a tie.
  let hottest: Wrapped["hottest"] = null;
  for (const e of inYear) {
    const c = e.ambient_hi_c ?? (e.temp_f != null ? ((e.temp_f - 32) * 5) / 9 : null);
    if (c == null) continue;
    if (hottest == null || round1(c) > hottest.temp_c)
      hottest = { event_id: e.id, track_name: e.track_name, date: e.start_date, temp_c: round1(c) };
  }

  const priorTracks = new Set(before.map((e) => e.track_id));

  return {
    year,
    years: wrappedYears(inputs.events, today),
    through: year === yearOf({ start_date: today }) ? today : null,
    name: inputs.name,
    totals: {
      events: inYear.length,
      track_days: inYear.reduce((s, e) => s + (e.days ?? 0), 0),
      tracks: tracks.size,
      laps: inYear.reduce((s, e) => s + (e.lap_count ?? 0), 0),
      hours: round1(inYear.reduce((s, e) => s + (e.hours ?? 0), 0)),
      miles: round1(metres / METRES_PER_MILE),
      miles_tracks_counted: [...lengths.values()].filter((v) => v != null).length,
    },
    most_driven: top
      ? { track_id: top.track_id, track_name: top.track_name, track_days: top.track_days, laps: top.laps, best_ms: bestOf(top.events) }
      : null,
    improvement,
    fastest: fastestEv
      ? { track_id: fastestEv.track_id, track_name: fastestEv.track_name, best_ms: fastestEv.best_ms!, event_id: fastestEv.id, date: fastestEv.start_date }
      : null,
    new_tracks: [...tracks.values()]
      .filter((t) => !priorTracks.has(t.track_id))
      .map((t) => ({ track_id: t.track_id, track_name: t.track_name })),
    hottest,
  };
}

// The link preview's description for a shared wrapped — the poster's headline
// in words, in the owner's unit system: "14 track days · 6 tracks · 1,923 laps
// · 4,281 track miles · most driven VIR (Full)". Mirrors posterLines in
// public/js/wrapped.js (the backend and frontend share no code); the distance
// is left out when no track's length was known, as the poster leaves it out.
export function wrappedSummary(w: Wrapped, units: "imperial" | "metric" = "imperial"): string {
  const t = w.totals;
  const n = (v: number) => Math.round(v).toLocaleString("en-US");
  const days = Number.isInteger(t.track_days) ? n(t.track_days) : t.track_days.toFixed(1);
  const s = (v: number, one: string) => `${one}${v === 1 ? "" : "s"}`;
  const parts = [`${days} ${s(t.track_days, "track day")}`, `${n(t.tracks)} ${s(t.tracks, "track")}`, `${n(t.laps)} ${s(t.laps, "lap")}`];
  if (t.miles_tracks_counted)
    parts.push(units === "metric" ? `${n(t.miles * 1.609344)} track km` : `${n(t.miles)} track miles`);
  if (w.most_driven) parts.push(`most driven ${w.most_driven.track_name}`);
  return parts.join(" · ");
}

// ---------- the Pro cards (NS-36 ticket 4) -----------------------------------

export type TirePart = {
  id: number;
  vehicle_id: number;
  vehicle_name: string;
  name: string;
  installed_on: string;
  retired_on: string | null;
  mounts?: Mount[]; // the stretches it was on the car (wear.ts)
};

// A past, vehicle-linked event with eventHours' inputs — vehicleHoursEvents'
// rows, which is what the garage's wear math runs over.
export type VehicleEvent = HoursEvent & { vehicle_id: number };

export type TopSpeedRow = { kph: number; track_id: number; track_name: string; event_id: number; date: string };

export type WrappedPro = {
  tire: { part_id: number; vehicle_id: number; vehicle_name: string; name: string; track_days: number; hours: number } | null;
  top_speed: TopSpeedRow | null;
};

// The tyre the season was driven on: for every tyre part (a full set or a
// front or rear pair), the year's events on its vehicle while it was on the
// car — eventsInWindow, the rule the garage's wear already believes — summed
// by days. Most days wins; ties go to
// the most hours, then the part installed later (the fresher set). An event
// counts toward a vehicle only through events.vehicle_id, so a day whose car
// isn't in the garage counts toward no tyre. The setup sheet's `tires_id` is
// deliberately not consulted in v1.
export function favouriteTire(parts: TirePart[], events: VehicleEvent[], year: number, today: string): WrappedPro["tire"] {
  let best: WrappedPro["tire"] & { installed_on: string } | null = null;
  for (const p of parts) {
    const onCar = events.filter((e) => e.vehicle_id === p.vehicle_id && yearOf(e) === year);
    const driven = eventsInWindow(p, onCar, today);
    if (!driven.length) continue;
    const days = driven.reduce((sum, e) => sum + (e.days ?? 0), 0);
    const hours = round1(driven.reduce((sum, e) => sum + eventHours(e), 0));
    const beats =
      best == null ||
      days > best.track_days ||
      (days === best.track_days && (hours > best.hours || (hours === best.hours && p.installed_on > best.installed_on)));
    if (beats)
      best = { part_id: p.id, vehicle_id: p.vehicle_id, vehicle_name: p.vehicle_name, name: p.name, track_days: days, hours, installed_on: p.installed_on };
  }
  if (!best) return null;
  const { installed_on, ...tire } = best;
  return tire;
}

export function wrappedPro(
  inputs: { tireParts: TirePart[]; vehicleEvents: VehicleEvent[]; topSpeed: TopSpeedRow | null },
  year: number,
  today: string
): WrappedPro {
  const top = inputs.topSpeed;
  return {
    tire: favouriteTire(inputs.tireParts, inputs.vehicleEvents, year, today),
    top_speed: top && top.kph > 0 ? { ...top, kph: round1(top.kph) } : null,
  };
}
