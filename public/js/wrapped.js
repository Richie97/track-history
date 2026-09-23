// Season Wrapped (NS-36) — the pure half of the story: which cards a season
// gets, in what order, and the words on them. The numbers are the server's
// (GET /api/wrapped/:year, src/lib/wrapped.ts); nothing here recomputes them.
// The DOM half is wrapped-story.js.

import { fmtMs } from "./format.js";
import { isMetric } from "./units.js";
import { tempText } from "./conditions.js";

export const KM_PER_MILE = 1.609344;

// The year the dashboard promotes, or null outside the reveal: the running
// year from 1 November to 31 December, the one just ended through 31 January.
// `today` is an ISO date (yyyy-mm-dd) or a Date, read as the viewer's local day.
export function wrappedSeason(today = new Date()) {
  const iso =
    typeof today === "string"
      ? today
      : `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  if (month >= 11) return year;
  if (month === 1) return year - 1;
  return null;
}

// The ordered card list for one season. A card with no data is left out, never
// drawn empty. The two Pro cards follow `data.pro`: `null` (a free account)
// draws them locked, an object draws whichever has data, and a payload with no
// `pro` key at all — the public share — has no Pro cards, locked or not.
export function wrappedCards(data) {
  const cards = [{ kind: "cover" }, { kind: "numbers" }];
  if (data.most_driven) cards.push({ kind: "most_driven" });
  if (data.improvement) cards.push({ kind: "improvement" });
  if (data.fastest) cards.push({ kind: "fastest" });
  if (data.new_tracks?.length) cards.push({ kind: "new_tracks" });
  cards.push({ kind: "hours" });
  if (data.hottest) cards.push({ kind: "hottest" });
  if ("pro" in data) {
    if (data.pro === null) {
      cards.push({ kind: "tire", locked: true }, { kind: "top_speed", locked: true });
    } else {
      if (data.pro.tire) cards.push({ kind: "tire" });
      if (data.pro.top_speed) cards.push({ kind: "top_speed" });
    }
  }
  cards.push({ kind: "poster" });
  return cards;
}

// What each card is called, for the progress dots and the live region.
export const CARD_TITLES = {
  cover: "Cover",
  numbers: "The numbers",
  most_driven: "Most driven",
  improvement: "Biggest improvement",
  fastest: "Fastest lap",
  new_tracks: "New tracks",
  hours: "Hours behind the wheel",
  hottest: "Hottest day",
  tire: "Favourite tyre",
  top_speed: "Top speed",
  poster: "Your season",
};

const int = (n) => Math.round(n).toLocaleString("en-US");
export const plural = (n, one, many = `${one}s`) => `${n === 1 ? one : many}`;

// Track days are REAL — a half day is 0.5 — so they are shown to one decimal
// only when they aren't whole.
export const fmtDays = (d) => (Number.isInteger(d) ? int(d) : d.toFixed(1));

// "4,281" and its unit, in the account's system.
export function trackDistance(miles, units) {
  const metric = isMetric(units);
  return { value: int(metric ? miles * KM_PER_MILE : miles), unit: metric ? "track km" : "track miles" };
}

// Seconds found, as the card says it: "4.83 s".
export const fmtGain = (ms) => `${(ms / 1000).toFixed(2)} s`;

export function fmtHoursWord(h) {
  const v = Math.round(h * 10) / 10;
  return `${Number.isInteger(v) ? int(v) : v.toFixed(1)}`;
}

// "Sep 23" / "Jul 19, 2026" — the story names days without the weekday.
export function fmtDay(iso, withYear = false) {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
}

export const fmtWrappedTemp = (c, units) => tempText(c, isMetric(units) ? "metric" : "us");

// The poster's lines — the summary card and (ticket 3) the image draw the same
// rows, so the two never disagree about what a season said. The owner's own
// poster says "My"; a public share names the driver.
export function posterLines(data, units, { share = false } = {}) {
  const t = data.totals;
  const dist = trackDistance(t.miles, units);
  const headline = [
    `${fmtDays(t.track_days)} ${plural(t.track_days, "track day")}`,
    `${int(t.tracks)} ${plural(t.tracks, "track")}`,
    `${int(t.laps)} ${plural(t.laps, "lap")}`,
    ...(t.miles_tracks_counted ? [`${dist.value} ${dist.unit}`] : []),
  ];
  const rows = [];
  if (data.most_driven) rows.push(["Most driven", data.most_driven.track_name]);
  if (data.improvement) rows.push(["Biggest improvement", `${data.improvement.track_name}, −${fmtGain(data.improvement.gain_ms)}`]);
  if (data.fastest) rows.push(["Fastest lap", `${data.fastest.track_name}, ${fmtMs(data.fastest.best_ms)}`]);
  if (data.pro?.tire) rows.push(["Favourite tyre", data.pro.tire.name]);
  const who = share ? `${data.name || "A driver"}'s` : "My";
  return { title: `${who} ${data.year} Track Evolution`, headline, rows };
}
