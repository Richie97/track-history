// Sector analysis and the theoretical best lap (issue #146): the pure half.
//
// Imported sessions and phone recordings store per-lap channels on a driven-
// distance grid (sessions.channels, see js/import/channels.js), and every
// stored lap carries a speed series — which is enough to split each lap into
// sectors without asking the driver to define them. Each lap is cut into N
// equal slices of *its own* driven distance and the time spent in each slice
// is read off the lap's elapsed-time series (lapTimeSeries in
// channel-graphs.js, scaled to the timed lap). Splitting by fractions of the
// lap's own length rather than by absolute metres is deliberate: laps differ
// by a percent or two in driven distance (line choice, GPS drift), so fractions
// keep the same corner in the same sector and — the property a driver will
// check — make every lap's sectors add up to exactly its lap time.
//
// Per session, the best time in each sector across all laps sums to the
// theoretical best lap; the gap to the actual best lap is what consistency
// would have been worth.
//
// Ported to iOS (TrackEvolutionKit Sectors.swift) and Android (:core
// Sectors.kt) with the same function names, pinned by
// contracts/logic/sectors.json — the ports assert against this file's output,
// so behavior changes here regenerate the fixture and flow to both.

import { lapTimeSeries } from "./channel-graphs.js";
import { esc, fmtDelta, fmtMs } from "./format.js";

// Thirds by default: coarse enough to be robust at the 20 m grid, fine enough
// to say which part of the lap the time lives in.
export const SECTOR_COUNT = 3;

// Sector split times, integer milliseconds, for one stored channel-lap entry:
// n equal slices of the lap's own driven distance. The first n−1 sectors are
// rounded and the last absorbs the residual so the splits sum exactly to the
// lap time. null when the lap stored no speed series or too few grid points
// to place a boundary.
export function sectorTimes(entry, dStepM, n = SECTOR_COUNT) {
  const speed = entry?.speed;
  if (!Array.isArray(speed) || speed.length < 2 || !(n >= 1)) return null;
  const t = lapTimeSeries(speed, dStepM, entry.timeMs);
  const last = speed.length - 1;
  const lapMs =
    entry.timeMs != null && Number.isFinite(entry.timeMs) ? entry.timeMs : Math.round(t[last] * 1000);
  // Elapsed seconds at a fractional grid position, linearly interpolated.
  const tAt = (p) => {
    const i = Math.min(last - 1, Math.floor(p));
    return t[i] + (t[i + 1] - t[i]) * (p - i);
  };
  const out = new Array(n);
  let acc = 0;
  for (let k = 0; k < n - 1; k++) {
    const ms = Math.round((tAt(((k + 1) * last) / n) - tAt((k * last) / n)) * 1000);
    out[k] = ms;
    acc += ms;
  }
  out[n - 1] = lapMs - acc;
  return out;
}

// Every lap of a session (or an aligned pair from compare-laps.js — same
// shape) split into sectors, plus the best of each sector and what they sum
// to. Laps without a usable speed series are left out. null when no lap can
// be split. `laps[i].chIdx` indexes channels.laps; `bestSectorLap[k]` is the
// chIdx owning sector k's best (the earliest lap on a tie, matching the
// strict `<`).
export function sessionSectors(channels, n = SECTOR_COUNT) {
  const dStepM = channels?.dStepM;
  const laps = [];
  (channels?.laps ?? []).forEach((entry, chIdx) => {
    const sectors = sectorTimes(entry, dStepM, n);
    if (sectors) laps.push({ chIdx, timeMs: sectors.reduce((s, v) => s + v, 0), sectors });
  });
  if (!laps.length) return null;
  const bestSectors = new Array(n);
  const bestSectorLap = new Array(n);
  for (let k = 0; k < n; k++) {
    let best = laps[0];
    for (const l of laps) if (l.sectors[k] < best.sectors[k]) best = l;
    bestSectors[k] = best.sectors[k];
    bestSectorLap[k] = best.chIdx;
  }
  const bestLap = laps.reduce((a, b) => (b.timeMs < a.timeMs ? b : a));
  const theoreticalBestMs = bestSectors.reduce((s, v) => s + v, 0);
  return {
    n,
    laps,
    bestSectors,
    bestSectorLap,
    theoreticalBestMs,
    bestLapMs: bestLap.timeMs,
    bestLapIdx: bestLap.chIdx,
    gapMs: bestLap.timeMs - theoreticalBestMs,
  };
}

// --- web rendering (not ported) --------------------------------------------
// The sector table under the lap chips: one row per highlighted lap (lit:
// Map(chIdx -> slot color); labelFor(chIdx) names the lap), each sector
// colored when it is the session's best and annotated with its gap to that
// best otherwise, and — with two or more laps to draw on — a closing
// "best sectors" row that is the theoretical best lap. Returns "" when no
// highlighted lap could be split.
export function sectorTableHtml(channels, lit, labelFor) {
  const sec = sessionSectors(channels);
  if (!sec) return "";
  const rows = [...lit.entries()]
    .map(([chIdx, color]) => ({ color, lap: sec.laps.find((l) => l.chIdx === chIdx) }))
    .filter((r) => r.lap);
  if (!rows.length) return "";
  const heads = sec.bestSectors.map((_, k) => `<th class="num">S${k + 1}</th>`).join("");
  const cell = (ms, k) => {
    const gap = ms - sec.bestSectors[k];
    return gap === 0
      ? `<td class="num sec-best">${fmtMs(ms)}</td>`
      : `<td class="num">${fmtMs(ms)} <small class="sec-gap">${esc(fmtDelta(gap))}</small></td>`;
  };
  const body = rows
    .map(
      ({ color, lap }) =>
        `<tr><td><span class="dot" style="background:${color}"></span> ${esc(labelFor(lap.chIdx))}</td>${lap.sectors
          .map(cell)
          .join("")}<td class="num">${fmtMs(lap.timeMs)}</td></tr>`
    )
    .join("");
  const theo =
    sec.laps.length >= 2
      ? `<tr class="sec-theo"><td>Best sectors</td>${sec.bestSectors
          .map((ms) => `<td class="num">${fmtMs(ms)}</td>`)
          .join("")}<td class="num">${fmtMs(sec.theoreticalBestMs)}</td></tr>`
      : "";
  const head =
    sec.laps.length >= 2
      ? `<div class="sec-head">Theoretical best <span class="t">${fmtMs(sec.theoreticalBestMs)}</span>
          <span class="hint">— ${
            sec.gapMs > 0
              ? `the best sectors of ${sec.laps.length} laps strung together, ${esc(fmtDelta(sec.gapMs).replace(/^\+/, ""))} quicker than the best lap`
              : "the best lap already strings together the session's best sectors"
          }</span></div>`
      : "";
  return `<div class="ch-sectors">${head}
    <div class="table-wrap"><table class="sectors">
      <thead><tr><th></th>${heads}<th class="num">Lap</th></tr></thead>
      <tbody>${body}${theo}</tbody>
    </table></div></div>`;
}
