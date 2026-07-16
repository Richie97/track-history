// Lap chips + per-lap channel graphs for an imported session. The chips are
// the session's lap list (rendered from the stored lap rows), and stacked
// small-multiple SVG charts (speed / rpm / lateral G, whichever the session
// stored) sit under them in a collapsible <details>, every lap overlaid on a
// shared driven-distance axis so laps line up corner-for-corner. Unselected
// laps draw as a dim context envelope; up to three laps at a time are
// highlighted in the chart series colors, picked via the lap chips (which
// double as the legend — identity is never color-alone).
// Channel data shape is sessions.channels (see js/import/channels.js).
//
// Same conventions as chart.js: pure string building for the SVG, one bind
// step for hover; axes recessive, marks thin, one y-axis per chart.

import { esc, fmtMs } from "./format.js";
import { niceNumTicks } from "./chart.js";

const SLOTS = ["var(--chart-line)", "var(--chart-line-b)", "var(--chart-line-c)"];
const KPH_TO_MPH = 0.621371;

const CHANNEL_DEFS = [
  { key: "speed", label: "Speed", unit: "mph", conv: (v) => v * KPH_TO_MPH, dp: 0, floor0: false },
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
// lap starts highlighted.
export function bindChannelGraphs(container, channels, sessionLaps) {
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

  const chanNames = ["speed", chLaps.some((l) => l.rpm) && "rpm", chLaps.some((l) => l.latG) && "lateral G"]
    .filter(Boolean)
    .join(" · ");
  container.innerHTML = `
    <div class="laps ch-chips"></div>
    <details class="ch-details">
      <summary>Channel graphs <span class="hint">${chanNames} vs distance</span></summary>
      <div class="hint" style="margin:2px 0 6px">Laps on a shared distance axis — tap laps to compare (up to 3)</div>
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
    const charts = CHANNEL_DEFS.map((def) => channelChartSvg(def, channels, lit)).filter(Boolean);
    chartsEl.innerHTML = charts.map((c) => `<div class="ch-chart">${c}</div>`).join("");

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
