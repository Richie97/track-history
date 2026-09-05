// Gear ribbon and shift points (issue #187): the pure half plus the web
// rendering.
//
// A PDR import stores `gear` per lap on the driven-distance grid
// (js/import/channels.js) — 1–8, with 0 meaning clutch-in / no gear, sampled
// by holding the last value because it is an enum, not a measurement. Wrong
// gear in a corner is the most common correctable mistake an amateur makes
// and it is invisible in a lap time; as a step change on the distance axis it
// is instantly visible, and against a second lap it becomes a sentence:
// "T5 in 3rd on the best lap, 4th on this one".
//
// Three things live here. `gearSegments` cuts a lap into runs of one gear (the
// ribbon's blocks); `lapShifts` finds where the gear steps and reads the rpm
// at the sample *before* the step — mind the 20 m grid: a shift takes ~0.3 s,
// about one grid point at speed, so the figure is a touch low and is labelled
// approximate; `shiftPoints` reduces a session's upshifts to min / median /
// max rpm per gear, which is what turns short-shifting and bouncing off the
// limiter into a number each. `gearDisagreements` is the comparison rule:
// the grid runs where highlighted laps sit in different gears, ignoring runs
// shorter than MIN_DISAGREE_POINTS so a shift landing a point later on one
// lap isn't outlined as a disagreement.
//
// Pinned for the native ports by contracts/logic/gears.json, generated from
// this file — a port asserts against this output, never against another port.

import { esc } from "./format.js";
import { niceNumTicks } from "./chart.js";

// A run of differing gears shorter than this (3 points = 60 m at the 20 m
// grid) is a shift that landed on a different sample, not a different gear
// choice. Display semantics, not physics — tune against real footage.
export const MIN_DISAGREE_POINTS = 3;

// An upshift more than this many rpm below the session's highest per-gear
// median is worth a sentence ("shifting earlier from 4th than from 2nd").
export const SHORT_SHIFT_RPM = 500;

// A gear whose latest upshift comes within this of the session's highest rpm
// sample was taken to the top of the rev range.
export const REV_LIMIT_MARGIN_RPM = 100;

// Fewer upshifts than this from one gear is not a pattern.
export const MIN_SHIFTS_FOR_NOTE = 2;

// "3rd", "4th" … — gear 0 is "no gear".
export function ordinal(gear) {
  if (!(gear > 0)) return "no gear";
  const s = gear % 10 === 1 && gear !== 11 ? "st" : gear % 10 === 2 && gear !== 12 ? "nd" : gear % 10 === 3 && gear !== 13 ? "rd" : "th";
  return `${gear}${s}`;
}

// Whole rpm with thousands separators, locale-independent so tests and the
// fixture are deterministic.
export function fmtRpm(v) {
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Runs of one gear along a lap's grid: [{gear, k0, k1}], k0..k1 inclusive
// grid indexes, in order and covering every point. Gear 0 runs are kept —
// the ribbon renders them as gaps, and the disagreement rule needs to know
// they are there.
export function gearSegments(gear) {
  if (!Array.isArray(gear) || !gear.length) return [];
  const out = [];
  let k0 = 0;
  for (let k = 1; k <= gear.length; k++) {
    if (k === gear.length || gear[k] !== gear[k0]) {
      out.push({ gear: gear[k0], k0, k1: k - 1 });
      k0 = k;
    }
  }
  return out;
}

// Every gear change in one stored lap: [{k, from, to, up, rpm}] — k the first
// grid point in the new gear, rpm the reading at the last point in the old
// gear (null when the lap stored no rpm). A clutch-in stretch (gear 0)
// between two gears is skipped over, so 3 → 0 → 4 is one shift from 3rd to
// 4th, read at the last sample that was still in 3rd.
export function lapShifts(entry) {
  const gear = entry?.gear;
  if (!Array.isArray(gear)) return [];
  const rpm = Array.isArray(entry.rpm) ? entry.rpm : null;
  const out = [];
  let last = 0, lastK = -1;
  for (let k = 0; k < gear.length; k++) {
    const g = gear[k];
    if (!(g > 0)) continue;
    if (last > 0 && g !== last) {
      out.push({
        k,
        from: last,
        to: g,
        up: g > last,
        rpm: rpm && lastK < rpm.length && Number.isFinite(rpm[lastK]) ? rpm[lastK] : null,
      });
    }
    last = g;
    lastK = k;
  }
  return out;
}

const median = (sorted) => {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};

// A session's upshifts reduced to rpm per gear: { gears: [{gear, count,
// minRpm, medianRpm, maxRpm}] by gear, medianRpm over every upshift, maxRpm
// the highest rpm sample in any lap with gear data }. Only laps carrying both
// `gear` and `rpm` count; null when none does or none of them upshifts.
// Rounded to whole rpm — the stored samples are, and a median of two is the
// only place a half can appear.
export function shiftPoints(channels) {
  const byGear = new Map();
  const all = [];
  let maxRpm = null;
  for (const l of channels?.laps ?? []) {
    if (!Array.isArray(l?.gear) || !Array.isArray(l.rpm)) continue;
    for (const v of l.rpm) if (Number.isFinite(v) && (maxRpm == null || v > maxRpm)) maxRpm = v;
    for (const s of lapShifts(l)) {
      if (!s.up || s.rpm == null) continue;
      all.push(s.rpm);
      if (!byGear.has(s.from)) byGear.set(s.from, []);
      byGear.get(s.from).push(s.rpm);
    }
  }
  if (!all.length) return null;
  const gears = [...byGear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([gear, rpms]) => {
      const sorted = [...rpms].sort((a, b) => a - b);
      return {
        gear,
        count: sorted.length,
        minRpm: sorted[0],
        medianRpm: Math.round(median(sorted)),
        maxRpm: sorted[sorted.length - 1],
      };
    });
  return { gears, medianRpm: Math.round(median([...all].sort((a, b) => a - b))), maxRpm };
}

// What the shift points say, as short factual sentences — facts about this
// session, never a verdict: "ABS active" is a fact, "you're braking too hard"
// is a guess (#188), and the same rule holds here. Two patterns are worth a
// line each: a gear taken to the top of the rev range seen today, and a gear
// shifted out of markedly earlier than the gear shifted latest. Empty when
// neither shows.
export function shiftNotes(sp) {
  if (!sp?.gears?.length) return [];
  const notes = [];
  const counted = sp.gears.filter((g) => g.count >= MIN_SHIFTS_FOR_NOTE);
  if (!counted.length) return notes;
  const top = counted.reduce((a, b) => (b.medianRpm > a.medianRpm ? b : a));
  const atLimit = counted.filter((g) => g.maxRpm >= sp.maxRpm - REV_LIMIT_MARGIN_RPM);
  if (atLimit.length) {
    notes.push(
      `Upshifts from ${atLimit.map((g) => ordinal(g.gear)).join(" and ")} run to the top of the rev range seen today (≈${fmtRpm(sp.maxRpm)} rpm).`
    );
  }
  for (const g of counted) {
    if (g === top) continue;
    const gap = top.medianRpm - g.medianRpm;
    if (gap >= SHORT_SHIFT_RPM) {
      notes.push(`Upshifts from ${ordinal(g.gear)} come ≈${fmtRpm(gap)} rpm earlier than from ${ordinal(top.gear)}.`);
    }
  }
  return notes;
}

// Grid runs where two or more laps sit in different gears: [{k0, k1}] over
// `gears` (one array per lap). A point counts only where at least two laps
// report a gear above 0 and those gears aren't all equal; runs shorter than
// `minRun` points are dropped (see MIN_DISAGREE_POINTS).
export function gearDisagreements(gears, minRun = MIN_DISAGREE_POINTS) {
  const arrs = (gears ?? []).filter((a) => Array.isArray(a));
  if (arrs.length < 2) return [];
  const n = Math.max(...arrs.map((a) => a.length));
  const out = [];
  let k0 = -1;
  for (let k = 0; k <= n; k++) {
    let differs = false;
    if (k < n) {
      let seen = 0;
      for (const a of arrs) {
        const g = a[k];
        if (!(g > 0)) continue;
        if (seen && g !== seen) differs = true;
        seen = seen || g;
      }
    }
    if (differs) {
      if (k0 < 0) k0 = k;
    } else if (k0 >= 0) {
      if (k - k0 >= minRun) out.push({ k0, k1: k - 1 });
      k0 = -1;
    }
  }
  return out;
}

// --- web rendering (not ported) --------------------------------------------

const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km` : `${m} m`);

// The gear ribbon: one band per highlighted lap (lit: Map(chIdx -> slot
// color), slot order), one block per gear run filled in the lap's color with
// the gear number where the block is wide enough, gear 0 as a gap. Sits under
// the speed chart on the same distance axis (same padding and x-extent as
// channelChartSvg, so the charts align), and with two or more laps the runs
// where they disagree are outlined. `labelFor(chIdx)` names a lap. Returns ""
// when no highlighted lap stored a gear series. Exported for unit tests.
export function gearRibbonSvg(channels, lit, labelFor, { width = 900 } = {}) {
  const dStep = channels.dStepM;
  const laps = channels.laps;
  const rows = [...lit.entries()]
    .map(([i, color]) => ({ i, color, gear: laps[i]?.gear }))
    .filter((r) => Array.isArray(r.gear) && r.gear.length);
  if (!rows.length) return "";
  const pad = { l: 56, r: 14, t: 20, b: 22 };
  const rowH = 24, gap = 6;
  const height = pad.t + rows.length * rowH + (rows.length - 1) * gap + pad.b + 4;
  // Same x-extent as the channel charts: the longest lap's speed series.
  let maxN = 0;
  for (const l of laps) {
    const n = Array.isArray(l.speed) ? l.speed.length : Array.isArray(l.gear) ? l.gear.length : 0;
    if (n > maxN) maxN = n;
  }
  const x1 = (maxN - 1) * dStep;
  const X = (d) => pad.l + (d / Math.max(1, x1)) * (width - pad.l - pad.r);
  const rowY = (r) => pad.t + r * (rowH + gap);

  let labels = "", grid = "";
  for (const tv of niceNumTicks(0, x1, 6)) {
    labels += `<text x="${X(tv).toFixed(1)}" y="${height - 6}" text-anchor="middle" fill="var(--text-faint)" font-size="11">${esc(fmtDist(tv))}</text>`;
  }
  grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${height - pad.b}" y2="${height - pad.b}" stroke="var(--border-strong)" stroke-width="1"/>`;
  labels += `<text x="${pad.l}" y="12" fill="var(--text-muted)" font-size="11" font-weight="600">Gear${rows.length >= 2 ? " — dashed boxes: laps disagree" : ""}</text>`;

  let blocks = "";
  rows.forEach((r, ri) => {
    const y = rowY(ri);
    const last = r.gear.length - 1;
    labels += `<text x="${pad.l - 8}" y="${(y + rowH / 2).toFixed(1)}" dy="0.35em" text-anchor="end" fill="${r.color}" font-size="11" font-weight="600">${esc(labelFor(r.i))}</text>`;
    for (const seg of gearSegments(r.gear)) {
      if (!(seg.gear > 0)) continue; // no gear: a gap
      const xa = X(Math.max(0, seg.k0 - 0.5) * dStep) + 1;
      const xb = X(Math.min(last, seg.k1 + 0.5) * dStep) - 1;
      const w = xb - xa;
      if (w <= 0) continue;
      blocks += `<rect x="${xa.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${rowH}" rx="2" fill="${r.color}"/>`;
      if (w >= 14) {
        blocks += `<text x="${((xa + xb) / 2).toFixed(1)}" y="${(y + rowH / 2).toFixed(1)}" dy="0.35em" text-anchor="middle" fill="var(--surface-card)" font-size="11" font-weight="700">${seg.gear}</text>`;
      }
    }
  });

  let outlines = "";
  if (rows.length >= 2) {
    const y0 = rowY(0) - 2, y1 = rowY(rows.length - 1) + rowH + 2;
    for (const run of gearDisagreements(rows.map((r) => r.gear))) {
      const xa = X(Math.max(0, run.k0 - 0.5) * dStep);
      const xb = X((run.k1 + 0.5) * dStep);
      outlines += `<rect x="${xa.toFixed(1)}" y="${y0}" width="${(xb - xa).toFixed(1)}" height="${y1 - y0}" rx="3" fill="none" stroke="var(--danger)" stroke-width="1.5" stroke-dasharray="3 2"/>`;
    }
  }

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Gear by distance, per lap${rows.length >= 2 ? " — outlined where the laps disagree" : ""}" data-channel="gear" data-x1="${x1}" data-padl="${pad.l}" data-padr="${pad.r}">
    ${grid}${labels}${blocks}${outlines}
  </svg>`;
}


// The shift-point read-out: upshift rpm per gear across the session, with
// the notes under it. Returns "" when the session has no upshift with an rpm
// reading.
export function shiftTableHtml(channels) {
  const sp = shiftPoints(channels);
  if (!sp) return "";
  const body = sp.gears
    .map(
      (g) =>
        `<tr><td>From ${esc(ordinal(g.gear))}</td><td class="num">${g.count}</td><td class="num">${fmtRpm(g.minRpm)}</td><td class="num shift-med">${fmtRpm(g.medianRpm)}</td><td class="num">${fmtRpm(g.maxRpm)}</td></tr>`
    )
    .join("");
  const notes = shiftNotes(sp);
  return `<div class="ch-shifts">
    <div class="sec-head">Upshifts <span class="t">≈${fmtRpm(sp.medianRpm)} rpm</span>
      <span class="hint">— rpm at the last sample before each shift, so figures read a touch low</span></div>
    <div class="table-wrap"><table class="shifts">
      <thead><tr><th>Upshift</th><th class="num">Count</th><th class="num">Earliest</th><th class="num">Typical</th><th class="num">Latest</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${notes.length ? `<div class="shift-notes">${notes.map((n) => `<div>${esc(n)}</div>`).join("")}</div>` : ""}
  </div>`;
}
