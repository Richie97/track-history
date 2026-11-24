// Which track was this driven at, and which event does it belong to (NS-57,
// docs/specs/native/NS-57-auto-place-laps.md).
//
// Pure, and run on the device: no coordinate is sent anywhere to be matched.
// A recording's place — the centre of its best lap and that lap's length — is
// compared with the driver's own tracks first (any track with one anchored
// session is a known place, catalog or not) and then with the seeded catalog.
// Location finds the venue; only the lap's length tells one layout of a venue
// from another, so a match that length cannot settle is offered, never made.
//
// To be ported as `TrackLocate` to the iOS Kit and Android `:core` under the
// same names; contracts/logic/track-locate.json is generated from this file
// and is what the ports are asserted against.

import { KX, KY, unprojectTrace } from "./geo.js";

// Both sides of an own-track match are measured the same way (the bounding-box
// centre of a driven lap), so the radius is tight. The catalog's centre is a
// curated point for the layout, so its radius is the venue's.
export const OWN_RADIUS_M = 400;
export const VENUE_RADIUS_M = 2000;
// How far a driven lap's length may sit from a track's and still be that
// layout: a stored trace cuts corners (300 points) and a driven line is not
// the surveyed centreline. This is the own-track tolerance, where both sides
// are driven laps and may differ either way.
export const LENGTH_TOLERANCE = 0.04;
// Against the catalog's published length the error is one-sided: on real
// footage a best lap's trace ran 0.7–4.0 % short of the published figure at
// every venue tried and never long, so the short side is the wide one. The
// two together must stay narrower than the gap between any two layouts at one
// venue (test/unit/locate.test.js checks the catalog for that).
export const CATALOG_SHORT_TOLERANCE = 0.06;
export const CATALOG_LONG_TOLERANCE = 0.02;
// A file's date is local on some sources and UTC on others, so an event's day
// range is widened by this much on each side before a file is matched to it.
export const DATE_SLACK_DAYS = 1;

const usable = (lat, lon) =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180 &&
  !(Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01);

// Metres between two coordinates, on projectTrace's own constants.
export function distanceM(a, b) {
  const dy = (a.lat - b.lat) * KY;
  const dx = (a.lon - b.lon) * KX((a.lat + b.lat) / 2);
  return Math.hypot(dx, dy);
}

// A closed polyline's length in metres — the server's `polylineLength`.
export function traceLengthM(trace) {
  if (!Array.isArray(trace) || trace.length < 2) return null;
  let total = 0;
  for (let i = 0; i < trace.length; i++) {
    const a = trace[i];
    const b = trace[(i + 1) % trace.length];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total > 0 ? total : null;
}

// Where a parsed file was driven: `{ lat, lon, lengthM }`. With laps, the
// centre of the best lap's bounding box and its closed length. Without laps
// yet (a source waiting for its start/finish line), the centre of the raw
// trace and no length — enough for the venue, never for the layout. Null when
// the file carries no usable position.
export function recordingPlace(parsed) {
  const trace = parsed?.bestLapTrace;
  const geo = parsed?.traceGeo;
  if (Array.isArray(trace) && trace.length >= 2 && geo && usable(geo.lat, geo.lon)) {
    const centre = boxCentre(unprojectTrace(trace, geo));
    return centre ? { ...centre, lengthM: traceLengthM(trace) } : null;
  }
  const centre = boxCentre(parsed?.gps ?? []);
  return centre ? { ...centre, lengthM: null } : null;
}

function boxCentre(points) {
  let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
  for (const p of points) {
    if (!usable(p?.lat, p?.lon)) continue;
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
    if (p.lon < w) w = p.lon;
    if (p.lon > e) e = p.lon;
  }
  return Number.isFinite(s) ? { lat: (s + n) / 2, lon: (w + e) / 2 } : null;
}

const lengthOff = (lengthM, trackM) =>
  lengthM != null && trackM != null && trackM > 0 ? Math.abs(lengthM - trackM) / trackM : null;

// Whether a driven lap could be a catalog layout of published length `trackM`.
export function fitsCatalogLength(lengthM, trackM) {
  if (lengthM == null || trackM == null || !(trackM > 0)) return true; // nothing to rule it out by
  const signed = (lengthM - trackM) / trackM;
  return signed >= -CATALOG_SHORT_TOLERANCE && signed <= CATALOG_LONG_TOLERANCE;
}

// The tracks a place could be, best first, and how sure that is:
//   exact  — one candidate and its length agrees: pre-fill it
//   choose — several, or one whose length could not be checked: ask
//   none   — nothing known is here
// `venueOnly` is true for the one `choose` where the place is a venue we know
// but the lap fits none of its layouts (a configuration the catalog lacks):
// the venue's rows are offered so the driver is not asked to name a place the
// app plainly recognises, and nothing is pre-filled.
// `ownTracks` are GET /api/tracks rows (`geo` null without an anchored
// session), `catalog` GET /api/catalog rows. A candidate is
// `{ source: "own" | "catalog", id, name, distM, lengthOff }`; a catalog row the
// driver already has a track for comes back as that own track.
export function locateTrack(place, ownTracks, catalog) {
  const NONE = { confidence: "none", candidates: [], venueOnly: false };
  if (!place || !usable(place.lat, place.lon)) return NONE;
  const measured = place.lengthM != null;
  const byOrder = (a, b) =>
    (a.lengthOff == null) - (b.lengthOff == null) || (a.lengthOff ?? 0) - (b.lengthOff ?? 0) || a.distM - b.distM || a.id - b.id;

  // Your own tracks: the same place and, once there is a lap, the same length.
  const own = [];
  for (const t of ownTracks ?? []) {
    if (!t?.geo || !usable(t.geo.lat, t.geo.lon)) continue;
    const distM = distanceM(place, t.geo);
    const off = lengthOff(place.lengthM, t.geo.length_m);
    if (measured ? distM <= OWN_RADIUS_M && off != null && off <= LENGTH_TOLERANCE : distM <= VENUE_RADIUS_M) {
      own.push({ source: "own", id: t.id, name: t.name, distM, lengthOff: off });
    }
  }
  own.sort(byOrder);
  if (measured && own.length) return { confidence: own.length === 1 ? "exact" : "choose", candidates: own, venueOnly: false };

  // Then the catalog: every layout at the venue the lap's length does not rule out.
  const ownByCatalog = new Map();
  for (const t of ownTracks ?? []) if (t?.catalog_id != null && !ownByCatalog.has(t.catalog_id)) ownByCatalog.set(t.catalog_id, t);
  const found = [...own];
  const offLayout = []; // at the venue, but the lap's length rules the layout out
  const seen = new Set(own.map((c) => c.id));
  const seenOff = new Set();
  for (const row of catalog ?? []) {
    if (!usable(row?.lat, row?.lon)) continue;
    const distM = distanceM(place, row);
    if (distM > VENUE_RADIUS_M) continue;
    const off = lengthOff(place.lengthM, row.length_m);
    const fits = fitsCatalogLength(place.lengthM, row.length_m);
    const into = fits ? found : offLayout;
    const ids = fits ? seen : seenOff;
    const mine = ownByCatalog.get(row.id);
    if (mine) {
      if (!ids.has(mine.id)) into.push({ source: "own", id: mine.id, name: mine.name, distM, lengthOff: off });
      ids.add(mine.id);
    } else {
      into.push({ source: "catalog", id: row.id, name: row.name, distM, lengthOff: off });
    }
  }
  found.sort(byOrder);
  if (found.length) {
    return { confidence: found.length === 1 && found[0].lengthOff != null ? "exact" : "choose", candidates: found, venueOnly: false };
  }
  if (!offLayout.length) return NONE;
  offLayout.sort(byOrder);
  return { confidence: "choose", candidates: offLayout, venueOnly: true };
}

// --- grouping a batch into events ---------------------------------------------

// Date-only arithmetic in UTC, so a DST change cannot skip or repeat a day.
export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const dayGap = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// The event a file dated `date` at own track `trackId` joins: one at that
// track whose days cover the date — or, failing that, cover it once widened by
// DATE_SLACK_DAYS. Never an event at another track. Overlaps go to the one
// that started most recently (pickRecordingEvent's rule), then the higher id.
export function eventForDate(events, trackId, date) {
  for (const slack of [0, DATE_SLACK_DAYS]) {
    let best = null;
    for (const e of events ?? []) {
      if (e?.track_id !== trackId || !e.start_date) continue;
      const days = Math.max(1, Math.trunc(Number(e.days)) || 1);
      if (date < addDays(e.start_date, -slack) || date > addDays(e.start_date, days - 1 + slack)) continue;
      if (!best || e.start_date > best.start_date || (e.start_date === best.start_date && e.id > best.id)) best = e;
    }
    if (best) return best;
  }
  return null;
}

// The review's cards. `items` are `{ id, date, time, place, located }` — one per
// file that has laps, `located` being locateTrack's answer for its place.
// `choices` maps an item id to `{ name }`, the driver's own answer, which
// outranks the match. Each group is
//   { key, eventId, track: { source, id, name } | null, confidence,
//     candidates, venueOnly, start, days, itemIds }
// with confidence "exact", "chosen", "choose" or "none"; `track` is null until
// a choose / none group is answered. A group either joins an existing event
// (`eventId`) or is one track over one run of consecutive dates.
export function groupImports(items, events, { choices = {}, ownTracks = [], today } = {}) {
  const rows = (items ?? []).map((it) => {
    const date = it.date || today;
    const choice = choices[it.id];
    const located = it.located ?? { confidence: "none", candidates: [], venueOnly: false };
    let track = null;
    let confidence = located.confidence;
    let trackKey;
    if (choice?.name?.trim()) {
      const mine = (ownTracks ?? []).find((t) => sameName(t.name, choice.name));
      track = mine ? { source: "own", id: mine.id, name: mine.name } : { source: "new", id: null, name: choice.name.trim() };
      confidence = "chosen";
      trackKey = mine ? `own:${mine.id}` : `new:${choice.name.trim().toLowerCase()}`;
    } else if (located.candidates.length) {
      const top = located.candidates[0];
      if (confidence === "exact") track = { source: top.source, id: top.id, name: top.name };
      trackKey = `${top.source}:${top.id}${confidence === "exact" ? "" : "?"}`;
    } else {
      trackKey = null; // clustered by place below
    }
    return { it, date, track, confidence, trackKey, located };
  });

  // Files nothing is known about group by where they are.
  const clusters = [];
  for (const r of rows) {
    if (r.trackKey != null) continue;
    const place = r.it.place;
    let idx = place ? clusters.findIndex((c) => c && distanceM(c, place) <= VENUE_RADIUS_M) : -1;
    if (idx < 0 && place) idx = clusters.push(place) - 1;
    r.trackKey = place ? `place:${idx}` : "nowhere";
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || String(a.it.time ?? "").localeCompare(String(b.it.time ?? "")));

  const groups = [];
  const open = new Map(); // trackKey -> the newest new-event group for it
  const attached = new Map(); // event id -> group
  for (const r of rows) {
    const event = r.track?.source === "own" ? eventForDate(events, r.track.id, r.date) : null;
    if (event) {
      let g = attached.get(event.id);
      if (!g) {
        g = {
          key: `event:${event.id}`,
          eventId: event.id,
          track: r.track,
          confidence: r.confidence,
          candidates: r.located.candidates,
        venueOnly: r.located.venueOnly === true,
          venueOnly: r.located.venueOnly === true,
          start: event.start_date,
          days: Math.max(1, Math.trunc(Number(event.days)) || 1),
          itemIds: [],
        };
        attached.set(event.id, g);
        groups.push(g);
      }
      if (r.confidence === "chosen") g.confidence = "chosen";
      g.itemIds.push(r.it.id);
      continue;
    }
    let g = open.get(r.trackKey);
    if (!g || dayGap(addDays(g.start, g.days - 1), r.date) > 1) {
      g = {
        key: `${r.trackKey}@${r.date}`,
        eventId: null,
        track: r.track,
        confidence: r.confidence,
        candidates: r.located.candidates,
        venueOnly: r.located.venueOnly === true,
        start: r.date,
        days: 1,
        itemIds: [],
      };
      open.set(r.trackKey, g);
      groups.push(g);
    }
    g.days = Math.max(g.days, dayGap(g.start, r.date) + 1);
    g.itemIds.push(r.it.id);
  }
  groups.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return groups;
}

// The `POST /events` body for a new-event group whose track is known.
export function eventBodyFor(group, defaultCar = null) {
  return { track_name: group.track.name, start_date: group.start, days: group.days, car: defaultCar || null };
}

// For a file imported onto an event the driver picked: the name of another
// track it was certainly driven at, or null. Only an `exact` match that is not
// this event's track says anything — the event is the driver's answer, and a
// doubtful match must not argue with it.
export function otherTrackHere(located, track) {
  if (located?.confidence !== "exact") return null;
  const top = located.candidates[0];
  if (top.source === "own" ? top.id === track?.id : top.id === track?.catalog_id) return null;
  return top.name;
}

// "14 Mar 2026" needs a locale; the cards take the caller's formatter.
export function groupDatesText(group, fmtDate) {
  return group.days > 1 ? `${fmtDate(group.start)} – ${fmtDate(addDays(group.start, group.days - 1))}` : fmtDate(group.start);
}
