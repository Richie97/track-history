// The per-session stats strip on the event page: a row of small labelled
// figures — plus a sparkline of the session's lap times — in place of the one
// " · "-joined sentence it used to be, which read as a paragraph of numbers.
//
// `lapStatItems` is the pure half (the three figures the lap times alone
// give); the caller appends what the channel data adds (theoretical best,
// upshifts, limits, balance, car health) as more items of the same shape:
//   { key, label, value, note?, tone?, text? }
// `text: true` marks a value that is a sentence ("ABS in 3 places") rather
// than a figure, drawn as a labelled line under the strip.
//
// The phones build the same items under the same names (`Session.statItems`
// in each `EventModel`) and draw them as `SessionStatsStrip`.

import { esc, fmtDelta, fmtMs } from "./format.js";
import { bestNAvg, paceSlope, warmupLapCount } from "./lap-stats.js";

// A tenth and a half per lap either way is drift, not a story.
export const FADING_MS_PER_LAP = 150;

// "fading" | "improving" | null (steady) for a pace slope in ms per lap.
export function paceTrend(slope) {
  if (slope == null) return null;
  return slope > FADING_MS_PER_LAP ? "fading" : slope < -FADING_MS_PER_LAP ? "improving" : null;
}

export function lapStatItems(lapsMs) {
  const items = [];
  const b3 = bestNAvg(lapsMs, 3);
  if (b3 != null) items.push({ key: "best3", label: "Best 3 avg", value: fmtMs(b3) });
  const warm = warmupLapCount(lapsMs);
  if (warm != null) items.push({ key: "warmup", label: "Up to speed", value: `Lap ${warm}` });
  const slope = paceSlope(lapsMs);
  if (slope != null) {
    const trend = paceTrend(slope);
    const item = { key: "pace", label: "Pace", value: `${fmtDelta(Math.round(slope))}/lap` };
    if (trend) {
      item.note = trend;
      item.tone = trend === "fading" ? "warn" : "good";
    }
    items.push(item);
  }
  return items;
}

// The sparkline's geometry: one point per lap, x by lap number, y by lap time
// with **slower plotted higher** (the progress chart's rule: down is faster).
// Null under three laps — two points are a line, not a shape.
export const SPARK_MIN_LAPS = 3;
export function sparkPoints(lapsMs, width, height, pad = 3) {
  if (!Array.isArray(lapsMs) || lapsMs.length < SPARK_MIN_LAPS) return null;
  const lo = Math.min(...lapsMs);
  const hi = Math.max(...lapsMs);
  const span = hi - lo || 1;
  const stepX = (width - pad * 2) / (lapsMs.length - 1);
  const points = lapsMs.map((ms, i) => ({
    x: pad + i * stepX,
    y: pad + (1 - (ms - lo) / span) * (height - pad * 2),
  }));
  return { points, best: lapsMs.indexOf(lo) };
}

const SPARK_W = 96;
const SPARK_H = 20;

export function sparklineSvg(lapsMs) {
  const spark = sparkPoints(lapsMs, SPARK_W, SPARK_H);
  if (!spark) return "";
  const { points, best } = spark;
  const path = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const b = points[best];
  return `<svg class="s-spark" viewBox="0 0 ${SPARK_W} ${SPARK_H}" width="${SPARK_W}" height="${SPARK_H}" role="img"
    aria-label="Lap times across the session, ${lapsMs.length} laps; best was lap ${best + 1}">
    <polyline points="${path}" fill="none" stroke="var(--chart-dim)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="3" fill="var(--chart-line)"/>
  </svg>`;
}

// Figures go in a strip of equal-height cells; sentences (`text` items) go on
// their own lines under it, so one long sentence can't make a cell taller than
// its neighbours.
export function sessionStatsHtml(items, lapsMs = []) {
  const spark = sparklineSvg(lapsMs);
  const figures = items.filter((it) => !it.text);
  const notes = items.filter((it) => it.text);
  if (!items.length && !spark) return "";
  const cell = (it) =>
    `<div class="s-stat${it.tone ? ` tone-${it.tone}` : ""}" role="listitem">
      <span class="k">${esc(it.label)}</span>
      <span class="v">${esc(it.value)}${it.note ? ` <span class="n">${esc(it.note)}</span>` : ""}</span>
    </div>`;
  const strip =
    spark || figures.length
      ? `<div class="s-stats" role="list">
    ${spark ? `<div class="s-stat spark" role="listitem"><span class="k">Lap times</span>${spark}</div>` : ""}
    ${figures.map(cell).join("")}
  </div>`
      : "";
  const lines = notes.length
    ? `<div class="s-notes" role="list">${notes
        .map((it) => `<div class="s-note" role="listitem"><span class="k">${esc(it.label)}</span><span class="v">${esc(it.value)}</span></div>`)
        .join("")}</div>`
    : "";
  return strip + lines;
}
