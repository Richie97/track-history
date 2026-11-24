// Where a best-lap trace lies on Earth (NS-53).
//
// `sessions.trace` is [x, y, v] in local metres, projected by `projectTrace`
// in public/js/import/geo.js from an origin the client now sends beside it as
// `trace_geo`. This module is the server's half: validating that anchor,
// inverting the projection, and lending an anchor to a trace saved before
// anchors were kept. Pure, so the rules are unit-tested rather than inspected.

export type TraceGeo = { lat: number; lon: number; approx?: true };
type Trace = [number, number, number][];

// projectTrace's two constants, restated. They are approximations of metres
// per degree, and **the inverse must use the same two numbers**: the
// projection is then its own exact inverse and a point comes back to within
// the trace's 0.1 m rounding. A "more correct" figure here would move the far
// end of a long lap by metres.
export const KY = 110540;
export const KX = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

const round7 = (v: number) => Math.round(v * 1e7) / 1e7;

// The anchor a session save stores. Null — never a 400 — for anything that
// isn't a plausible coordinate: the session is the irreplaceable thing, and a
// map backdrop is not worth refusing one over. Null too without a trace, since
// an anchor describes one. (0, 0) is what a GPS that never got a fix reports.
export function sanitizeTraceGeo(v: unknown, trace: unknown): TraceGeo | null {
  if (!Array.isArray(trace) || !v || typeof v !== "object" || Array.isArray(v)) return null;
  const { lat, lon } = v as { lat?: unknown; lon?: unknown };
  if (typeof lat !== "number" || !Number.isFinite(lat) || Math.abs(lat) > 85) return null;
  if (typeof lon !== "number" || !Number.isFinite(lon) || Math.abs(lon) > 180) return null;
  if (Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01) return null;
  return { lat: round7(lat), lon: round7(lon) };
}

// A stored `sessions.trace_geo`. Malformed JSON degrades to null, as every
// other stored-JSON read does.
export function parseTraceGeo(raw: unknown): TraceGeo | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const v = JSON.parse(raw) as { lat?: unknown; lon?: unknown } | null;
    if (!v || typeof v.lat !== "number" || typeof v.lon !== "number") return null;
    return { lat: v.lat, lon: v.lon };
  } catch {
    return null;
  }
}

export function parseTrace(raw: unknown): Trace | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) && v.length >= 2 ? (v as Trace) : null;
  } catch {
    return null;
  }
}

// One trace point back to degrees.
export function unproject(x: number, y: number, geo: TraceGeo): { lat: number; lon: number } {
  return { lat: geo.lat + y / KY, lon: geo.lon + x / KX(geo.lat) };
}

type Box = { cx: number; cy: number; w: number; h: number };
function bbox(trace: Trace): Box | null {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of trace) {
    if (!Array.isArray(p) || typeof p[0] !== "number" || typeof p[1] !== "number") return null;
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}

// The bounding box's centre, in the trace's own metres.
export function traceCentre(trace: Trace): [number, number] | null {
  const b = bbox(trace);
  return b ? [b.cx, b.cy] : null;
}

// Two best laps of one layout have nearly the same outline. Past this in
// either dimension it is a different layout, or a lap that wasn't whole.
export const BORROW_MAX_MISMATCH = 0.15;

// An anchor for a trace that has none, lent by an anchored trace of the same
// track: the origin that puts this trace's bounding-box centre on the donor's.
// Both traces are north-up in metres, so a translation is the whole fit. The
// result is an estimate — two laps' outlines differ by the lines driven and by
// GPS error — and says so with `approx`.
export function borrowAnchor(trace: unknown, donorTrace: unknown, donorGeo: TraceGeo | null): TraceGeo | null {
  if (!donorGeo || !Array.isArray(trace) || !Array.isArray(donorTrace)) return null;
  const a = bbox(trace as Trace);
  const d = bbox(donorTrace as Trace);
  if (!a || !d) return null;
  const off = (p: number, q: number) => Math.abs(p - q) > BORROW_MAX_MISMATCH * Math.max(p, q);
  if (off(a.w, d.w) || off(a.h, d.h)) return null;
  const centre = unproject(d.cx, d.cy, donorGeo);
  const lat = centre.lat - a.cy / KY;
  const lon = centre.lon - a.cx / KX(lat);
  return { lat: round7(lat), lon: round7(lon), approx: true };
}

// The newest anchored session at a track, as the event detail and the
// leaderboard lap read it: the donor for every unanchored trace there.
export type DonorRow = { trace: string | null; trace_geo: string | null };

// A session's anchor as a response carries it: its own, else one borrowed
// from the donor, else null. `trace` is the session's parsed trace.
export function resolveTraceGeo(trace: unknown, stored: unknown, donor: DonorRow | null | undefined): TraceGeo | null {
  if (!Array.isArray(trace)) return null;
  const own = parseTraceGeo(stored);
  if (own) return own;
  if (!donor) return null;
  return borrowAnchor(trace, parseTrace(donor.trace), parseTraceGeo(donor.trace_geo));
}

// Where a track is and how long its lap is (NS-57), from one anchored best-lap
// trace: the centre of its bounding box in degrees and its closed length. What
// the owner's GET /tracks carries as `geo`, so an import can recognise the
// place. Null for anything unreadable.
export type TrackPlace = { lat: number; lon: number; length_m: number };
export function trackPlace(traceRaw: unknown, geoRaw: unknown): TrackPlace | null {
  const trace = parseTrace(traceRaw);
  const geo = parseTraceGeo(geoRaw);
  if (!trace || !geo) return null;
  const c = traceCentre(trace);
  if (!c) return null;
  let length = 0;
  for (let i = 0; i < trace.length; i++) {
    const a = trace[i];
    const b = trace[(i + 1) % trace.length];
    length += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  if (!Number.isFinite(length) || length <= 0) return null;
  const centre = unproject(c[0], c[1], geo);
  return { lat: round7(centre.lat), lon: round7(centre.lon), length_m: Math.round(length) };
}
