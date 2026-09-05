// Lap chips + per-lap channel graphs for an imported session. The chips are
// the session's lap list (rendered from the stored lap rows), and stacked
// small-multiple SVG charts (speed / throttle / brake / steering / rpm /
// lateral G, whichever the session stored — a channel no lap carries renders
// no chart) sit under them in a collapsible <details>, every lap overlaid on a
// shared driven-distance axis so laps line up corner-for-corner. Unselected
// laps draw as a dim context envelope; up to three laps at a time are
// highlighted in the chart series colors, picked via the lap chips (which
// double as the legend — identity is never color-alone). With two or more
// laps highlighted, a time-delta chart (vs the fastest of the selection)
// renders above the channels — see the "lap delta" section below. The caller
// can slot extra markup above the charts that re-renders with the selection
// (`renderExtras`): app.js uses it for the sector table from js/sectors.js.
// Channel data shape is sessions.channels (see js/import/channels.js).
//
// Same conventions as chart.js: pure string building for the SVG, one bind
// step for hover; axes recessive, marks thin, one y-axis per chart.

import { esc, fmtMs } from "./format.js";
import { niceNumTicks } from "./chart.js";
import { ordinal } from "./gears.js";

const SLOTS = ["var(--chart-line)", "var(--chart-line-b)", "var(--chart-line-c)"];
const KPH_TO_MPH = 0.621371;

// Exported for the cross-event compare view (app.js viewLapCompare), which
// renders these charts outside bindChannelGraphs and needs the defs for its
// own tooltip readouts.
export const CHANNEL_DEFS = [
  { key: "speed", label: "Speed", unit: "mph", conv: (v) => v * KPH_TO_MPH, dp: 0, floor0: false },
  { key: "throttle", label: "Throttle", unit: "%", conv: (v) => v, dp: 0, floor0: true },
  { key: "brake", label: "Brake", unit: "%", conv: (v) => v, dp: 0, floor0: true },
  { key: "steering", label: "Steering", unit: "°", conv: (v) => v, dp: 0, floor0: false },
  { key: "rpm", label: "RPM", unit: "rpm", conv: (v) => v, dp: 0, floor0: false },
  { key: "latG", label: "Lateral G", unit: "G", conv: (v) => v, dp: 2, floor0: true },
];

const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km` : `${m} m`);

// One channel's overlay chart. laps: the stored entries; lit: Map(lapIdx ->
// slot color). Returns "" when no lap carries this channel.
// Exported for unit tests.
export function channelChartSvg(def, channels, lit, { width = 900, height = 190 } = {}) {
  const dStep = channels.dStepM;
  const laps = channels.laps;
  const withCh = laps.map((l, i) => ({ l, i })).filter(({ l }) => Array.isArray(l[def.key]));
  if (!withCh.length) return "";
  const pad = { l: 56, r: 14, t: 20, b: 22 };

  let y0 = Infinity, y1 = -Infinity, maxN = 0;
  for (const { l } of withCh) {
    const arr = l[def.key];
    if (arr.length > maxN) maxN = arr.length;
    for (const raw of arr) {
      const v = def.conv(raw);
      if (v < y0) y0 = v;
      if (v > y1) y1 = v;
    }
  }
  if (def.floor0) y0 = Math.min(0, y0);
  const ypad = Math.max((y1 - y0) * 0.08, 1e-6);
  y0 -= def.floor0 ? 0 : ypad;
  y1 += ypad;
  const x1 = (maxN - 1) * dStep;
  const X = (d) => pad.l + (d / Math.max(1, x1)) * (width - pad.l - pad.r);
  const Y = (v) => pad.t + ((y1 - v) / (y1 - y0)) * (height - pad.t - pad.b);

  let grid = "", labels = "";
  for (const tv of niceNumTicks(y0, y1, 3)) {
    const y = Y(tv).toFixed(1);
    grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y}" y2="${y}" stroke="var(--chart-grid)" stroke-width="1"/>`;
    labels += `<text x="${pad.l - 8}" y="${y}" dy="0.35em" text-anchor="end" fill="var(--text-faint)" font-size="11" style="font-variant-numeric:tabular-nums">${tv.toFixed(def.dp)}</text>`;
  }
  for (const tv of niceNumTicks(0, x1, 6)) {
    labels += `<text x="${X(tv).toFixed(1)}" y="${height - 6}" text-anchor="middle" fill="var(--text-faint)" font-size="11">${esc(fmtDist(tv))}</text>`;
  }
  grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${height - pad.b}" y2="${height - pad.b}" stroke="var(--border-strong)" stroke-width="1"/>`;
  labels += `<text x="${pad.l}" y="12" fill="var(--text-muted)" font-size="11" font-weight="600">${esc(def.label)} (${esc(def.unit)})</text>`;

  const pathFor = (arr) =>
    arr.map((raw, k) => `${k ? "L" : "M"}${X(k * dStep).toFixed(1)},${Y(def.conv(raw)).toFixed(1)}`).join(" ");
  // dim context first, then highlighted laps on top (slot order, best last)
  let dimPaths = "", litPaths = "";
  for (const { l, i } of withCh) {
    const color = lit.get(i);
    if (!color) {
      dimPaths += `<path d="${pathFor(l[def.key])}" fill="none" stroke="var(--chart-dim)" stroke-width="1.25" stroke-linejoin="round"/>`;
    } else {
      litPaths += `<path d="${pathFor(l[def.key])}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
  }

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(def.label)} by distance, per lap" data-channel="${def.key}" data-x1="${x1}" data-padl="${pad.l}" data-padr="${pad.r}">
    ${grid}${labels}${dimPaths}${litPaths}
  </svg>`;
}

// --- lap delta -----------------------------------------------------------
// Time delta between laps on the shared distance grid. Every stored channel
// lap carries a speed array (buildLapChannels synthesizes one when the source
// had none), so elapsed time at each grid point can be integrated from speed
// (trapezoidal dt per cell) and scaled so the total lands exactly on the
// lap's timed duration — the speed integral alone drifts a little, and the
// timed duration is the ground truth. Subtracting two laps' series gives the
// classic "where is the time gained or lost" delta trace.

// A 0 km/h sample would make its grid cell take near-forever; clamp the cell
// average to walking pace instead. The end-scale to timeMs absorbs the error.
const DELTA_MIN_KPH = 3;

// Cumulative elapsed seconds at each grid point (d = 0, dStepM, 2*dStepM …)
// from a lap's speed samples (km/h). Scaled so the last point equals
// timeMs/1000 when a timed duration is given. Exported for unit tests.
export function lapTimeSeries(speedKph, dStepM, timeMs) {
  const t = new Array(speedKph.length);
  t[0] = 0;
  for (let k = 1; k < speedKph.length; k++) {
    const vAvg = Math.max(DELTA_MIN_KPH, (speedKph[k - 1] + speedKph[k]) / 2) / 3.6; // m/s
    t[k] = t[k - 1] + dStepM / vAvg;
  }
  const total = t[t.length - 1];
  if (timeMs != null && Number.isFinite(timeMs) && total > 0) {
    const scale = timeMs / 1000 / total;
    for (let k = 0; k < t.length; k++) t[k] = t[k] * scale;
  }
  return t;
}

// Delta seconds (lap − ref, positive = lap is slower) at each shared grid
// point, over the grid points both laps cover. null when either lap has no
// speed data or the overlap is too short to mean anything.
export function deltaSeries(lap, ref, dStepM) {
  if (!Array.isArray(lap?.speed) || !Array.isArray(ref?.speed)) return null;
  const a = lapTimeSeries(lap.speed, dStepM, lap.timeMs);
  const b = lapTimeSeries(ref.speed, dStepM, ref.timeMs);
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
  const out = new Array(n);
  for (let k = 0; k < n; k++) out[k] = a[k] - b[k];
  return out;
}

// The delta chart: highlighted laps vs the reference lap (the fastest of the
// highlight selection), on the same distance axis as the channel charts.
// Positive is slower than the reference, so a climbing trace is time slipping
// away. refLabel is the reference's display lap number. Returns "" when
// fewer than one comparable lap is highlighted. Exported for unit tests.
export function deltaChartSvg(channels, lit, refIdx, refLabel, { width = 900, height = 190 } = {}) {
  const dStep = channels.dStepM;
  const laps = channels.laps;
  const ref = laps[refIdx];
  if (!Array.isArray(ref?.speed)) return "";
  const rows = [...lit.entries()]
    .filter(([i]) => i !== refIdx)
    .map(([i, color]) => ({ i, color, d: deltaSeries(laps[i], ref, dStep) }))
    .filter((r) => r.d);
  if (!rows.length) return "";
  const pad = { l: 56, r: 14, t: 20, b: 22 };

  // Same x-axis as the channel charts (longest lap), so the charts align.
  let maxN = 0;
  for (const l of laps) if (Array.isArray(l.speed) && l.speed.length > maxN) maxN = l.speed.length;
  let y0 = 0, y1 = 0;
  for (const { d } of rows) {
    for (const v of d) {
      if (v < y0) y0 = v;
      if (v > y1) y1 = v;
    }
  }
  const ypad = Math.max((y1 - y0) * 0.08, 0.05);
  y0 -= ypad;
  y1 += ypad;
  const x1 = (maxN - 1) * dStep;
  const X = (d) => pad.l + (d / Math.max(1, x1)) * (width - pad.l - pad.r);
  const Y = (v) => pad.t + ((y1 - v) / (y1 - y0)) * (height - pad.t - pad.b);

  let grid = "", labels = "";
  for (const tv of niceNumTicks(y0, y1, 3)) {
    const y = Y(tv).toFixed(1);
    grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y}" y2="${y}" stroke="var(--chart-grid)" stroke-width="1"/>`;
    labels += `<text x="${pad.l - 8}" y="${y}" dy="0.35em" text-anchor="end" fill="var(--text-faint)" font-size="11" style="font-variant-numeric:tabular-nums">${tv > 0 ? "+" : ""}${tv.toFixed(1)}</text>`;
  }
  for (const tv of niceNumTicks(0, x1, 6)) {
    labels += `<text x="${X(tv).toFixed(1)}" y="${height - 6}" text-anchor="middle" fill="var(--text-faint)" font-size="11">${esc(fmtDist(tv))}</text>`;
  }
  // The zero line is the reference lap — everything is measured against it.
  const zy = Y(0).toFixed(1);
  grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${zy}" y2="${zy}" stroke="var(--text-faint)" stroke-width="1" stroke-dasharray="4 3"/>`;
  grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${height - pad.b}" y2="${height - pad.b}" stroke="var(--border-strong)" stroke-width="1"/>`;
  labels += `<text x="${pad.l}" y="12" fill="var(--text-muted)" font-size="11" font-weight="600">Delta (s) vs lap ${esc(String(refLabel))} — above the line is slower</text>`;

  let paths = "";
  for (const { color, d } of rows) {
    const path = d.map((v, k) => `${k ? "L" : "M"}${X(k * dStep).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    paths += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Time delta to lap ${esc(String(refLabel))} by distance — above the zero line is slower" data-channel="delta" data-x1="${x1}" data-padl="${pad.l}" data-padr="${pad.r}">
    ${grid}${labels}${paths}
  </svg>`;
}

// Match the session's stored lap rows ({lap_num, time_ms}, chronological) to
// the channel entries ({n, timeMs}, same order). Both come from the same
// parsed laps at import time, but a lap can lack channel data (no distance
// window) and laps hand-added later have none — an in-order greedy match on
// the exact millisecond time pairs them up. Returns [{lap, chIdx}] with
// chIdx -1 for laps without channel data. Exported for unit tests.
export function matchLapsToChannels(sessionLaps, chLaps) {
  let j = 0;
  return sessionLaps.map((lap) => {
    const k = chLaps.findIndex((cl, idx) => idx >= j && cl.timeMs === lap.time_ms);
    if (k < 0) return { lap, chIdx: -1 };
    j = k + 1;
    return { lap, chIdx: k };
  });
}

// Render + wire the whole panel into `container`: the lap chips (always
// visible — they are the session's lap list) and the charts inside a
// collapsible <details>, rendered lazily on first expand. Chips toggle laps
// into the highlight slots (max 3 at once; oldest is evicted). The fastest
// lap starts highlighted. `renderExtras(litMap, dispN)` — litMap being
// Map(chIdx -> slot color) and dispN the display lap number per channel lap —
// returns HTML rendered above the charts and re-rendered with them.
// `renderAfter` — { [channelKey]: (litMap, dispN) => svg } — slots a chart
// straight under that channel's chart on the same distance axis: app.js hangs
// the gear ribbon from js/gears.js under the speed trace.
export function bindChannelGraphs(container, channels, sessionLaps, { renderExtras, renderAfter } = {}) {
  const chLaps = channels.laps;
  const rows = matchLapsToChannels(sessionLaps, chLaps);
  const bestMs = Math.min(...sessionLaps.map((l) => l.time_ms));
  // Chart tooltips label laps by the session's lap numbers, same as the chips.
  const dispN = chLaps.map((cl) => cl.n);
  for (const { lap, chIdx } of rows) if (chIdx >= 0) dispN[chIdx] = lap.lap_num;

  const matched = rows.filter((r) => r.chIdx >= 0);
  const bestRow = matched.length
    ? matched.reduce((a, b) => (b.lap.time_ms < a.lap.time_ms ? b : a))
    : null;
  const state = { lit: bestRow ? [bestRow.chIdx] : [] }; // channel-lap indexes in slot order

  const litMap = () => new Map(state.lit.map((lapIdx, slot) => [lapIdx, SLOTS[slot]]));

  const chanNames = CHANNEL_DEFS.filter((def) => chLaps.some((l) => l[def.key]))
    .map((def) => def.label.toLowerCase())
    .join(" · ");
  container.innerHTML = `
    <div class="laps ch-chips"></div>
    <details class="ch-details">
      <summary>Channel graphs <span class="hint">${chanNames} vs distance</span></summary>
      <div class="hint" style="margin:2px 0 6px">Laps on a shared distance axis — tap laps to compare (up to 3). With 2+ selected, the delta chart shows where time is gained or lost vs the fastest.</div>
      <div class="ch-graphs"></div>
    </details>`;
  const chipsEl = container.querySelector(".ch-chips");
  const details = container.querySelector(".ch-details");
  const chartsEl = container.querySelector(".ch-graphs");
  let chartsDirty = true;

  const renderChips = () => {
    const lit = litMap();
    chipsEl.innerHTML = rows
      .map(({ lap, chIdx }) => {
        const label = `Lap ${lap.lap_num} · ${fmtMs(lap.time_ms)}${lap.time_ms === bestMs ? " ★" : ""}`;
        if (chIdx < 0) return `<span class="lap">${label}</span>`;
        const color = lit.get(chIdx);
        return `<button type="button" class="lap ch-chip${color ? " on" : ""}" data-ch-lap="${chIdx}" ${color ? `style="border-color:${color}"` : ""}>
          <span class="dot" style="background:${color ?? "var(--chart-dim)"}"></span>${label}
        </button>`;
      })
      .join("");

    chipsEl.querySelectorAll("[data-ch-lap]").forEach((btn) => {
      btn.onclick = () => {
        const i = Number(btn.dataset.chLap);
        const at = state.lit.indexOf(i);
        if (at >= 0) state.lit.splice(at, 1);
        else {
          state.lit.push(i);
          if (state.lit.length > SLOTS.length) state.lit.shift(); // evict oldest
        }
        renderChips();
        if (details.open) renderCharts();
        else chartsDirty = true;
      };
    });
  };

  // Charts render lazily on first expand — laps × 3 SVGs is wasted work for
  // a collapsed panel — and re-render only while open.
  const renderCharts = () => {
    chartsDirty = false;
    const lit = litMap();
    // Delta chart first when 2+ laps are highlighted: reference is the
    // fastest of the selection, deltas cached for the tooltip.
    let refIdx = null;
    const deltaByIdx = new Map();
    if (state.lit.length >= 2) {
      refIdx = state.lit.reduce((a, b) => (chLaps[b].timeMs < chLaps[a].timeMs ? b : a));
      for (const i of state.lit) {
        if (i === refIdx) continue;
        const d = deltaSeries(chLaps[i], chLaps[refIdx], channels.dStepM);
        if (d) deltaByIdx.set(i, d);
      }
    }
    const deltaSvg = refIdx != null ? deltaChartSvg(channels, lit, refIdx, dispN[refIdx]) : "";
    const charts = [deltaSvg];
    for (const def of CHANNEL_DEFS) {
      charts.push(channelChartSvg(def, channels, lit));
      charts.push(renderAfter?.[def.key]?.(lit, dispN) ?? "");
    }
    const extras = renderExtras ? renderExtras(lit, dispN) : "";
    chartsEl.innerHTML = extras + charts.filter(Boolean).map((c) => `<div class="ch-chart">${c}</div>`).join("");

    // Tooltip: nearest grid point by x; one row per highlighted lap.
    const $tooltip = document.getElementById("tooltip");
    chartsEl.querySelectorAll("svg[data-channel]").forEach((svgEl) => {
      const def = CHANNEL_DEFS.find((d) => d.key === svgEl.dataset.channel);
      const x1 = Number(svgEl.dataset.x1);
      const padL = Number(svgEl.dataset.padl), padR = Number(svgEl.dataset.padr);
      const vbW = svgEl.viewBox.baseVal.width;
      svgEl.addEventListener("mousemove", (evt) => {
        const rect = svgEl.getBoundingClientRect();
        const frac = (((evt.clientX - rect.left) / rect.width) * vbW - padL) / (vbW - padL - padR);
        const k = Math.round((Math.max(0, Math.min(1, frac)) * x1) / channels.dStepM);
        const d = Math.round(k * channels.dStepM);
        const tipRows = state.lit
          .map((lapIdx, slot) => {
            if (svgEl.dataset.channel === "delta") {
              const arr = deltaByIdx.get(lapIdx);
              if (!arr || k >= arr.length) return "";
              const v = arr[k];
              return `<div class="t-sub"><span style="color:${SLOTS[slot]}">●</span> Lap ${dispN[lapIdx]} — ${v >= 0 ? "+" : ""}${v.toFixed(2)} s vs lap ${dispN[refIdx]}</div>`;
            }
            if (svgEl.dataset.channel === "gear") {
              const arr = chLaps[lapIdx]?.gear;
              if (!arr || k >= arr.length) return "";
              return `<div class="t-sub"><span style="color:${SLOTS[slot]}">●</span> Lap ${dispN[lapIdx]} — ${esc(ordinal(arr[k]))}</div>`;
            }
            const arr = chLaps[lapIdx]?.[def.key];
            if (!arr || k >= arr.length) return "";
            return `<div class="t-sub"><span style="color:${SLOTS[slot]}">●</span> Lap ${dispN[lapIdx]} — ${def.conv(arr[k]).toFixed(def.dp)} ${esc(def.unit)}</div>`;
          })
          .join("");
        if (!tipRows) { $tooltip.hidden = true; return; }
        $tooltip.innerHTML = `<div class="t-val">${esc(fmtDist(d))}</div>${tipRows}`;
        $tooltip.hidden = false;
        const tw = $tooltip.offsetWidth;
        let left = evt.clientX + 14;
        if (left + tw > window.innerWidth - 8) left = evt.clientX - tw - 14;
        $tooltip.style.left = `${left}px`;
        $tooltip.style.top = `${evt.clientY - 12}px`;
      });
      svgEl.addEventListener("mouseleave", () => ($tooltip.hidden = true));
    });
  };

  details.addEventListener("toggle", () => {
    if (details.open && chartsDirty) renderCharts();
  });
  renderChips();
}
