// Session conditions (issue #191): the pure half plus the web rendering.
//
// Lap times across a day are confounded by air temperature. A morning session
// and an afternoon session are not comparable, and a progress chart that plots
// them as if they were invites the wrong conclusion: a line that ticks upward
// after lunch reads as "I got worse" when what happened is that the track got
// hotter. Showing the temperature is the cheapest honesty in the app.
//
// Three rules shape everything here.
//
// **Recorded beats typed, and never overwrites it.** Every PDR import stores
// `meta.ambientC` — the recording's median outside-air temperature — which
// migration 0020 lifts into `sessions.ambient_c` and the event query
// aggregates into `ambient_lo_c` / `ambient_hi_c`. Events also carry a manual
// `temp_f` the driver typed. `eventAmbient` prefers the recorded value and
// falls back to the typed one, and nothing anywhere writes one from the other:
// the two reconcile at display time, so a user's number is still their number.
//
// **Per session, only what was measured.** A session chip shows the ambient
// that session's own recording saw, never the event's typed figure repeated
// down the page — that would be one number wearing four hats. The manual
// fallback is an *event*-level idea, because that is the level it was entered
// at.
//
// **Context is a band, not a series.** Behind the progress chart the
// temperature is a faint wash per event, deepening with heat. A second line
// would read as a comparison — "lap time versus temperature" — which is not
// the claim; the claim is only that these two events were not run in the same
// air. That is also why `conditionsBand` returns null when the spread is under
// `BAND_MIN_SPAN_C`: a uniform wash shows nothing and implies something.
//
// Temperatures are °C and elevations metres throughout the pure half — the
// units the channel meta stores — and conversion is a separate step
// (`ambientText`, `elevationText`) so a port can pin the numbers without
// pinning a locale. `intakeC` deliberately has no place here: intake air is a
// heat-soak signal about the car, not weather.

import { esc } from "./format.js";

export const cToF = (c) => c * 1.8 + 32;
export const fToC = (f) => (f - 32) / 1.8;
export const mToFt = (m) => m / 0.3048;

// The band needs at least this many events carrying a temperature, spanning at
// least this many °C, before it is worth drawing. Under either, the shading
// would be a uniform wash that says "there was weather" and nothing more.
export const BAND_MIN_EVENTS = 2;
export const BAND_MIN_SPAN_C = 3;

// The wash, coolest to hottest. Faint on purpose: this sits *behind* the lap
// times and must never compete with the line for attention.
export const BAND_MIN_ALPHA = 0.05;
export const BAND_MAX_ALPHA = 0.3;

// The opacity of one band cell. Linear in the normalized temperature, so the
// coolest event in view is barely tinted and the hottest is unmistakable.
export const bandAlpha = (intensity) =>
  BAND_MIN_ALPHA + (BAND_MAX_ALPHA - BAND_MIN_ALPHA) * Math.min(1, Math.max(0, intensity));

// The ambient a session's own telemetry recorded, in °C, or null. The column
// (migration 0020) is the denormalization of the blob, so it is read first and
// the blob is the fallback — which matters for a response cached before the
// column existed, and for a free account, whose `channels` are stripped while
// the column is not.
export function sessionAmbientC(session) {
  const col = session?.ambient_c;
  if (typeof col === "number" && Number.isFinite(col)) return col;
  const meta = session?.channels?.meta?.ambientC;
  return typeof meta === "number" && Number.isFinite(meta) ? meta : null;
}

// The elevation *range* a session's recording saw, in metres — max minus min
// altitude, i.e. how much the track climbs and falls, not its height above the
// sea (`sessionMeta` in public/pdr.js).
export function sessionElevationM(session) {
  const col = session?.elevation_m;
  if (typeof col === "number" && Number.isFinite(col)) return col;
  const meta = session?.channels?.meta?.elevationM;
  return typeof meta === "number" && Number.isFinite(meta) ? meta : null;
}

// An event's ambient temperature, reconciled: the range its sessions recorded
// if any did, else the number the driver typed, else nothing. `loC === hiC` for
// a single session and for the manual case. `source` is which of the two it
// came from — the view says so rather than presenting a typed number as a
// measurement.
export function eventAmbient(event) {
  const lo = event?.ambient_lo_c;
  const hi = event?.ambient_hi_c;
  if (typeof lo === "number" && typeof hi === "number" && Number.isFinite(lo) && Number.isFinite(hi))
    return { loC: Math.min(lo, hi), hiC: Math.max(lo, hi), source: "recorded" };
  const f = event?.temp_f;
  if (typeof f === "number" && Number.isFinite(f)) {
    const c = fToC(f);
    return { loC: c, hiC: c, source: "manual" };
  }
  return null;
}

// The midpoint of an event's ambient range — the single number the band shades
// by, where the text keeps the range.
export const ambientMidC = (amb) => (amb ? (amb.loC + amb.hiC) / 2 : null);

// The largest elevation range recorded at a track, in metres, over its events.
// A range, so the figure is a maximum rather than a sum: two events at one
// track saw the same hill.
export function trackElevationM(events) {
  const vals = (events ?? [])
    .map((e) => e?.elevation_m)
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  return vals.length ? Math.max(...vals) : null;
}

// A temperature in the given system, rounded to whole degrees: "84 °F".
export function tempText(c, units = "metric") {
  const v = units === "us" ? cToF(c) : c;
  return `${Math.round(v)} ${units === "us" ? "°F" : "°C"}`;
}

// An event's ambient as words: one figure, or the day's range when its
// sessions disagree. Rounding collapses the range first, so 21.4–21.8 °C reads
// as one number rather than "71–71 °F".
export function ambientText(amb, units = "metric") {
  if (!amb) return "";
  const conv = (c) => Math.round(units === "us" ? cToF(c) : c);
  const unit = units === "us" ? "°F" : "°C";
  const lo = conv(amb.loC);
  const hi = conv(amb.hiC);
  return lo === hi ? `${lo} ${unit}` : `${lo}–${hi} ${unit}`;
}

// The elevation line: "126 ft of elevation change" / "38 m of elevation
// change". Context, not coaching — one line, and no more.
export function elevationText(m, units = "metric") {
  if (m == null) return "";
  const v = units === "us" ? mToFt(m) : m;
  return `${Math.round(v)} ${units === "us" ? "ft" : "m"} of elevation change`;
}

// The band behind the progress chart, aligned one cell per plotted event, in
// the order given. A cell is null where that event has no temperature at all —
// an unknown day must draw nothing, not the coolest shade, which would claim a
// measurement that was never made.
//
// Null overall when fewer than BAND_MIN_EVENTS carry a temperature or they
// span less than BAND_MIN_SPAN_C: see the header — a uniform wash implies a
// difference that isn't there.
export function conditionsBand(events) {
  const mids = (events ?? []).map((e) => ambientMidC(eventAmbient(e)));
  const known = mids.filter((v) => v != null);
  if (known.length < BAND_MIN_EVENTS) return null;
  const loC = Math.min(...known);
  const hiC = Math.max(...known);
  if (hiC - loC < BAND_MIN_SPAN_C) return null;
  return {
    loC,
    hiC,
    cells: mids.map((c) =>
      c == null ? null : { c, intensity: (c - loC) / (hiC - loC), alpha: bandAlpha((c - loC) / (hiC - loC)) }
    ),
  };
}

// The chart's spoken description of the shading — the part a screen-reader
// user cannot see, same reason the charts say which way the trend goes.
export function bandLabel(band, units = "metric") {
  if (!band) return "";
  return `shaded by ambient temperature, ${tempText(band.loC, units)} to ${tempText(band.hiC, units)}`;
}

// --- web rendering (not ported) ---------------------------------------------

// The session header's ambient chip: what this session's own recording saw.
// Nothing for a hand-entered or GPS-recorded session — see the header on why
// the event's typed figure is not repeated here.
export function conditionsChipHtml(session, units = "us") {
  const c = sessionAmbientC(session);
  if (c == null) return "";
  return `<span class="s-cond" title="Ambient air temperature recorded with this session">${esc(tempText(c, units))}</span>`;
}

// The band's key, under the chart: pale is the coolest event in view, deep the
// hottest. Same shape as the track map's speed ramp.
export function conditionsLegendHtml(band, units = "us") {
  if (!band) return "";
  return `<div class="chart-legend heat-legend"><span>${esc(tempText(band.loC, units))}</span><span class="ramp" aria-hidden="true"></span><span>${esc(tempText(band.hiC, units))}</span></div>`;
}
