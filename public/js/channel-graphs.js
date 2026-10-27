// Lap chips + per-lap channel graphs for an imported session. The chips are
// the session's lap list (rendered from the stored lap rows), and stacked
// small-multiple SVG charts (speed / throttle / brake / steering / rpm /
// lateral G / yaw rate, whichever the session stored — a channel no lap carries renders
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
import { DEFAULT_UNITS, convSpeedKph, currentUnits, distAxisTicks, fmtDist as fmtDistIn, speedUnit } from "./units.js";
// Re-exported for the unit tests that pin the axis alongside the charts.
export { distAxisTicks };
import { ordinal } from "./gears.js";
import { LIMIT_KINDS, activeLimitLabels, limitRuns, sideColorVar } from "./limits.js";
import { DEFAULT_AXIS, axisAtGrid, axisFrame, axisPlaces, axisWord, fmtAxisValue } from "./lap-axis.js";
import { renderTrackMap } from "./trackmap.js";

const SLOTS = ["var(--chart-line)", "var(--chart-line-b)", "var(--chart-line-c)"];

// The channel specs in the user's unit system: stored speed is km/h, shown as
// mph or km/h; every other channel reads the same in both. Exported for the
// cross-event compare view (app.js viewLapCompare), which renders these charts
// outside bindChannelGraphs and needs the defs for its own tooltip readouts,
// and for unit tests. CHANNEL_DEFS is the imperial (default) table.
export const channelDefs = (units) => [
  { key: "speed", label: "Speed", unit: speedUnit(units), conv: (v) => convSpeedKph(v, units), dp: 0, floor0: false },
  { key: "throttle", label: "Throttle", unit: "%", conv: (v) => v, dp: 0, floor0: true },
  { key: "brake", label: "Brake", unit: "%", conv: (v) => v, dp: 0, floor0: true },
  { key: "steering", label: "Steering", unit: "°", conv: (v) => v, dp: 0, floor0: false },
  { key: "rpm", label: "RPM", unit: "rpm", conv: (v) => v, dp: 0, floor0: false },
  { key: "latG", label: "Lateral G", unit: "G", conv: (v) => v, dp: 2, floor0: true },
  // Yaw rate is the honest baseline for the balance read-out (js/balance.js,
  // #189): signed, so it swings both ways around zero like steering does.
  { key: "yaw", label: "Yaw rate", unit: "°/s", conv: (v) => v, dp: 0, floor0: false },
];
export const CHANNEL_DEFS = channelDefs(DEFAULT_UNITS);


// One channel's overlay chart. laps: the stored entries; lit: Map(lapIdx ->
// slot color). `axis` — an axisFrame (js/lap-axis.js) to lay the laps out
// on; distance when omitted. Returns "" when no lap carries this channel.
// Exported for unit tests.
export function channelChartSvg(def, channels, lit, { width = 900, height = 190, units = currentUnits(), axis = null } = {}) {
  const dStep = channels.dStepM;
  const laps = channels.laps;
  const frame = axis ?? axisFrame(laps, dStep, DEFAULT_AXIS, units);
  const withCh = laps
    .map((l, i) => ({ l, i, xs: frame.xsOf(i) }))
    .filter(({ l, xs }) => Array.isArray(l[def.key]) && xs);
  if (!withCh.length) return "";
  const pad = { l: 56, r: 14, t: 20, b: 22 };

  let y0 = Infinity, y1 = -Infinity;
  for (const { l } of withCh) {
    for (const raw of l[def.key]) {
      const v = def.conv(raw);
      if (v < y0) y0 = v;
      if (v > y1) y1 = v;
    }
  }
  if (def.floor0) y0 = Math.min(0, y0);
  const ypad = Math.max((y1 - y0) * 0.08, 1e-6);
  y0 -= def.floor0 ? 0 : ypad;
  y1 += ypad;
  const x1 = frame.x1;
  const X = (x) => pad.l + (x / Math.max(1e-9, x1)) * (width - pad.l - pad.r);
  const Y = (v) => pad.t + ((y1 - v) / (y1 - y0)) * (height - pad.t - pad.b);

  let grid = "", labels = "";
  for (const tv of niceNumTicks(y0, y1, 3)) {
    const y = Y(tv).toFixed(1);
    grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y}" y2="${y}" stroke="var(--chart-grid)" stroke-width="1"/>`;
    labels += `<text x="${pad.l - 8}" y="${y}" dy="0.35em" text-anchor="end" fill="var(--text-faint)" font-size="11" style="font-variant-numeric:tabular-nums">${tv.toFixed(def.dp)}</text>`;
  }
  for (const { x, label } of frame.ticks) {
    labels += `<text x="${X(x).toFixed(1)}" y="${height - 6}" text-anchor="middle" fill="var(--text-faint)" font-size="11">${esc(label)}</text>`;
  }
  grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${height - pad.b}" y2="${height - pad.b}" stroke="var(--border-strong)" stroke-width="1"/>`;
  labels += `<text class="ch-title" x="${pad.l}" y="12" fill="var(--text-muted)" font-size="11" font-weight="600">${esc(def.label)} (${esc(def.unit)})</text>`;

  // Limit bands (js/limits.js): the kinds this chart's trace explains — ABS
  // and lockup on the brake trace, traction control and wheelspin on the
  // throttle, stability control on steering — shaded at the distances they
  // were active on each highlighted lap, behind the traces.
  let bands = "";
  const bandKinds = LIMIT_KINDS.filter((k) => k.channel === def.key);
  const bandsUsed = new Set();
  for (const { l, i, xs } of withCh) {
    if (!bandKinds.length || !lit.get(i)) continue;
    for (const r of limitRuns(l)) {
      const kd = bandKinds.find((k) => k.key === r.kind);
      if (!kd) continue;
      bandsUsed.add(kd.label);
      const xa = X(axisAtGrid(xs, r.k0 - 0.5)), xb = X(axisAtGrid(xs, r.k1 + 0.5));
      bands += `<rect x="${xa.toFixed(1)}" y="${pad.t}" width="${(xb - xa).toFixed(1)}" height="${height - pad.t - pad.b}" fill="var(${sideColorVar(kd.side)})" fill-opacity="${kd.filled ? 0.22 : 0.12}" data-limit="${kd.key}"/>`;
    }
  }
  if (bandsUsed.size) {
    labels += `<text x="${width - pad.r}" y="12" text-anchor="end" fill="var(--text-faint)" font-size="11">shaded: ${esc([...bandsUsed].join(" / "))}</text>`;
  }

  const pathFor = (arr, xs) =>
    arr
      .slice(0, xs.length)
      .map((raw, k) => `${k ? "L" : "M"}${X(xs[k]).toFixed(1)},${Y(def.conv(raw)).toFixed(1)}`)
      .join(" ");
  // dim context first, then highlighted laps on top (slot order, best last)
  let dimPaths = "", litPaths = "";
  for (const { l, i, xs } of withCh) {
    const color = lit.get(i);
    if (!color) {
      dimPaths += `<path d="${pathFor(l[def.key], xs)}" fill="none" stroke="var(--chart-dim)" stroke-width="1.25" stroke-linejoin="round"/>`;
    } else {
      litPaths += `<path d="${pathFor(l[def.key], xs)}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
  }

  // The y-scale rides on the element beside the x-axis geometry, so the
  // playhead (showPlayhead) can put a dot on a trace without re-rendering it.
  // Every channel's display conversion is linear through zero, so one factor
  // carries it.
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(def.label)} by ${axisWord(frame.mode)}, per lap" data-channel="${def.key}" data-axis="${frame.mode}" data-x1="${x1}" data-padl="${pad.l}" data-padr="${pad.r}" data-padt="${pad.t}" data-padb="${pad.b}" data-y0="${y0}" data-y1="${y1}" data-vscale="${def.conv(1)}" data-dp="${def.dp}">
    ${grid}${labels}${bands}${dimPaths}${litPaths}
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
export const DELTA_MIN_KPH = 3;

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
// highlight selection), on the same axis as the channel charts. Positive is
// slower than the reference, so a climbing trace is time slipping away.
// refLabel is the reference's display lap number. On a time axis the delta
// at each grid point sits at the reference lap's elapsed time there — the
// zero line is the reference lap. Returns "" when fewer than one comparable
// lap is highlighted. Exported for unit tests.
export function deltaChartSvg(channels, lit, refIdx, refLabel, { width = 900, height = 190, units = currentUnits(), axis = null } = {}) {
  const dStep = channels.dStepM;
  const laps = channels.laps;
  const ref = laps[refIdx];
  if (!Array.isArray(ref?.speed)) return "";
  const frame = axis ?? axisFrame(laps, dStep, DEFAULT_AXIS, units);
  const refXs = frame.xsOf(refIdx);
  if (!refXs) return "";
  const rows = [...lit.entries()]
    .filter(([i]) => i !== refIdx)
    .map(([i, color]) => ({ i, color, d: deltaSeries(laps[i], ref, dStep) }))
    .filter((r) => r.d);
  if (!rows.length) return "";
  const pad = { l: 56, r: 14, t: 20, b: 22 };

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
  // Same x-extent as the channel charts, so the charts align.
  const x1 = frame.x1;
  const X = (x) => pad.l + (x / Math.max(1e-9, x1)) * (width - pad.l - pad.r);
  const Y = (v) => pad.t + ((y1 - v) / (y1 - y0)) * (height - pad.t - pad.b);

  let grid = "", labels = "";
  for (const tv of niceNumTicks(y0, y1, 3)) {
    const y = Y(tv).toFixed(1);
    grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y}" y2="${y}" stroke="var(--chart-grid)" stroke-width="1"/>`;
    labels += `<text x="${pad.l - 8}" y="${y}" dy="0.35em" text-anchor="end" fill="var(--text-faint)" font-size="11" style="font-variant-numeric:tabular-nums">${tv > 0 ? "+" : ""}${tv.toFixed(1)}</text>`;
  }
  for (const { x, label } of frame.ticks) {
    labels += `<text x="${X(x).toFixed(1)}" y="${height - 6}" text-anchor="middle" fill="var(--text-faint)" font-size="11">${esc(label)}</text>`;
  }
  // The zero line is the reference lap — everything is measured against it.
  const zy = Y(0).toFixed(1);
  grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${zy}" y2="${zy}" stroke="var(--text-faint)" stroke-width="1" stroke-dasharray="4 3"/>`;
  grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${height - pad.b}" y2="${height - pad.b}" stroke="var(--border-strong)" stroke-width="1"/>`;
  labels += `<text class="ch-title" x="${pad.l}" y="12" fill="var(--text-muted)" font-size="11" font-weight="600">Delta (s) vs lap ${esc(String(refLabel))} — above the line is slower</text>`;

  let paths = "";
  for (const { color, d } of rows) {
    const n = Math.min(d.length, refXs.length);
    const path = d.slice(0, n).map((v, k) => `${k ? "L" : "M"}${X(refXs[k]).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    paths += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Time delta to lap ${esc(String(refLabel))} by ${axisWord(frame.mode)} — above the zero line is slower" data-channel="delta" data-axis="${frame.mode}" data-ref="${refIdx}" data-x1="${x1}" data-padl="${pad.l}" data-padr="${pad.r}" data-padt="${pad.t}" data-padb="${pad.b}" data-y0="${y0}" data-y1="${y1}" data-vscale="1" data-dp="2">
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

// A vertical mark at one place on the lap across every chart in `root` — the
// friction circle's and balance scatter's hovers (js/grip.js, js/balance.js)
// use it to answer "where on the lap is this dot" on the charts that do have
// a lap axis. `d` is the driven distance in metres, for distance-axis charts;
// `t` the elapsed seconds, for time-axis ones (a time chart with no `t` gets
// no mark). Passing null clears it. Reads the axis geometry back off the data
// attributes every chart already carries, so it needs to know nothing about
// how they were drawn.
export function showDistanceMark(root, d, t = null) {
  root.querySelectorAll("svg[data-channel]").forEach((svgEl) => {
    let line = svgEl.querySelector(".ch-dmark");
    const x = svgEl.dataset.axis === "time" ? t : d;
    if (x == null) {
      line?.remove();
      return;
    }
    const x1 = Number(svgEl.dataset.x1) || 1;
    const padL = Number(svgEl.dataset.padl), padR = Number(svgEl.dataset.padr);
    const vb = svgEl.viewBox.baseVal;
    const px = padL + Math.max(0, Math.min(1, x / x1)) * (vb.width - padL - padR);
    if (!line) {
      line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("class", "ch-dmark");
      line.setAttribute("stroke", "var(--text-faint)");
      line.setAttribute("stroke-width", "1.5");
      line.setAttribute("stroke-dasharray", "3 3");
      line.setAttribute("pointer-events", "none");
      svgEl.appendChild(line);
    }
    line.setAttribute("x1", px.toFixed(1));
    line.setAttribute("x2", px.toFixed(1));
    line.setAttribute("y1", "0");
    line.setAttribute("y2", String(vb.height));
  });
}

// The lap stage's playhead (NS-51) across every chart in `root`: a solid line
// at the master's driven distance, a dot on each marked lap's trace at that
// lap's own grid index (in "Same time" the two dots sit apart, which is the
// gap), and the values in each chart's title. The friction circle and balance
// scatter ring each marked lap's sample, and the sector table lights the
// sector the line is in. `mark` is null (remove it all) or
// { dStepM, k, n, laps: [{ chIdx, k, color, entry, delta }], axis?, x? } — n the master lap's grid length, chIdx the lap's
// index in the charts' own lap list, `delta` its value on the delta chart
// (null for the reference). The line sits at the first lap's place unless
// `x` names a value on the `axis` the charts are drawn on (the panel's
// cursor, which is a value on the axis rather than a lap's place). A chart
// the panel drew carries `_xsOf(chIdx)`, each lap's axis series, which is how
// a dot finds its x on a time axis. Attributes only: no chart re-renders
// because the playhead moved, which is what lets it run at the video's frame
// rate.
const SVGNS = "http://www.w3.org/2000/svg";
const svgNode = (tag, attrs) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const at = (arr, k) => {
  if (!Array.isArray(arr) || !arr.length) return null;
  const kk = Math.max(0, Math.min(arr.length - 1, k));
  const i0 = Math.floor(kk);
  return i0 >= arr.length - 1 ? arr[arr.length - 1] : arr[i0] + (arr[i0 + 1] - arr[i0]) * (kk - i0);
};

export function showPlayhead(root, mark) {
  if (!root) return;
  root.querySelectorAll("svg[data-channel]").forEach((svg) => {
    let line = svg.querySelector(".ch-playhead");
    let dots = svg.querySelector(".ch-playdots");
    const title = svg.querySelector(".ch-title");
    let readout = title?.querySelector(".ch-readout");
    if (!mark) {
      line?.remove();
      dots?.remove();
      readout?.remove();
      return;
    }
    const vb = svg.viewBox.baseVal;
    const x1 = Number(svg.dataset.x1) || 1;
    const padL = Number(svg.dataset.padl), padR = Number(svg.dataset.padr);
    const Xv = (v) => padL + Math.max(0, Math.min(1, v / x1)) * (vb.width - padL - padR);
    const axisOf = (chIdx, k) => {
      const xs = svg._xsOf?.(chIdx);
      return xs ? axisAtGrid(xs, k) : k * mark.dStepM;
    };
    const X = (l) => Xv(axisOf(l.chIdx, l.k) ?? 0);
    if (!line) {
      line = svgNode("line", { class: "ch-playhead", stroke: "var(--text-strong)", "stroke-width": "1.5", "pointer-events": "none" });
      svg.appendChild(line);
    }
    const lineAt = mark.x != null && (svg.dataset.axis ?? "distance") === (mark.axis ?? "distance") ? mark.x : mark.laps[0] ? axisOf(mark.laps[0].chIdx, mark.k) : mark.k * mark.dStepM;
    const x = Xv(lineAt ?? 0).toFixed(1);
    line.setAttribute("x1", x);
    line.setAttribute("x2", x);
    line.setAttribute("y1", "16");
    line.setAttribute("y2", String(vb.height - (Number(svg.dataset.padb) || 0)));
    if (svg.dataset.y0 == null) return; // the gear ribbon: the line, no values
    const key = svg.dataset.channel;
    const y0 = Number(svg.dataset.y0), y1 = Number(svg.dataset.y1);
    const padT = Number(svg.dataset.padt), padB = Number(svg.dataset.padb);
    const scale = Number(svg.dataset.vscale) || 1;
    const dp = Number(svg.dataset.dp) || 0;
    const Y = (v) => padT + ((y1 - v) / (y1 - y0 || 1)) * (vb.height - padT - padB);
    const points = mark.laps
      .map((l) => ({ l, v: key === "delta" ? l.delta : at(l.entry?.[key], l.k) }))
      .filter((p) => p.v != null && Number.isFinite(p.v))
      .map((p) => ({ ...p, v: key === "delta" ? p.v : p.v * scale }));
    if (!dots) {
      dots = svgNode("g", { class: "ch-playdots", "pointer-events": "none" });
      svg.appendChild(dots);
    }
    while (dots.childNodes.length > points.length) dots.lastChild.remove();
    points.forEach((p, i) => {
      const c = dots.childNodes[i] ?? dots.appendChild(svgNode("circle", { r: "4", stroke: "var(--surface-card)", "stroke-width": "1.5" }));
      c.setAttribute("cx", X(p.l).toFixed(1));
      c.setAttribute("cy", Y(p.v).toFixed(1));
      c.setAttribute("fill", p.l.color);
    });
    if (!title) return;
    if (!readout) {
      readout = svgNode("tspan", { class: "ch-readout", "font-weight": "400" });
      title.appendChild(readout);
    }
    readout.textContent = points.length
      ? `  ${points.map((p) => `${key === "delta" && p.v > 0 ? "+" : ""}${p.v.toFixed(dp)}`).join(" · ")}`
      : "";
  });

  // The two scatters: a ring round each marked lap's sample at its grid index.
  for (const [svgSel, lapAttr, kAttr] of [
    ["svg[data-grip]", "gripLap", "gk"],
    ["svg[data-balance]", "balanceLap", "bk"],
  ]) {
    root.querySelectorAll(svgSel).forEach((svg) => {
      svg.querySelectorAll(".ch-playring").forEach((r) => r.remove());
      if (!mark) return;
      for (const l of mark.laps) {
        const g = [...svg.querySelectorAll("g")].find((el) => el.dataset[lapAttr] === String(l.chIdx));
        const dot = g?.querySelector(`circle[data-${kAttr}="${Math.round(l.k)}"]`);
        if (!dot) continue;
        svg.appendChild(
          svgNode("circle", {
            class: "ch-playring",
            cx: dot.getAttribute("cx"),
            cy: dot.getAttribute("cy"),
            r: "6",
            fill: "none",
            stroke: l.color,
            "stroke-width": "2.5",
            "pointer-events": "none",
          })
        );
      }
    });
  }

  // The sector table: the column of the sector the line is in. Sectors are
  // equal thirds of each lap's own distance (js/sectors.js), so the master's
  // fraction of its own lap picks the column.
  root.querySelectorAll("table.sectors").forEach((table) => {
    const heads = [...table.querySelectorAll("thead th")].slice(1, -1);
    const n = heads.length;
    const frac = mark && mark.n > 1 ? mark.k / (mark.n - 1) : null;
    const now = frac == null ? -1 : Math.min(n - 1, Math.floor(frac * n));
    heads.forEach((th, i) => th.classList.toggle("sec-now", i === now));
  });
}

// Tapping or clicking a distance-axis chart seeks the lap stage (NS-51), and
// so do the scatters' samples. A touch only seeks, on the tap's click, so a
// finger that starts a scroll on a chart never moves the video: dragging is
// the scrubber's job. A mouse may press and drag across a chart to scrub.
// `onSeek(k, { final })` — k the fractional grid index, final false while a
// mouse drags. A chart on a time axis has no grid index of its own: `timeToK`
// turns its elapsed seconds into the master lap's (null skips the seek).
// Bound once per root; a second call replaces the callback, which is how the
// event page's re-renders keep one listener.
export function bindChartSeek(root, dStepM, onSeek, { timeToK = null } = {}) {
  if (!root) return;
  const prev = root._chartSeek;
  root._chartSeek = { dStepM, onSeek, timeToK };
  root.classList.toggle("chart-seek", !!onSeek);
  if (prev) return;
  const kAt = (svg, clientX) => {
    const rect = svg.getBoundingClientRect();
    const vbW = svg.viewBox.baseVal.width;
    const padL = Number(svg.dataset.padl), padR = Number(svg.dataset.padr);
    const frac = Math.max(0, Math.min(1, (((clientX - rect.left) / rect.width) * vbW - padL) / (vbW - padL - padR)));
    const x = frac * Number(svg.dataset.x1);
    if (svg.dataset.axis === "time") return root._chartSeek.timeToK?.(x) ?? null;
    return x / root._chartSeek.dStepM;
  };
  const seekAt = (svg, clientX, opts) => {
    const k = kAt(svg, clientX);
    if (k != null) root._chartSeek.onSeek?.(k, opts);
  };
  const scatterK = (target) => {
    const dot = target.closest?.("svg[data-grip] circle[data-gk], svg[data-balance] circle[data-bk]");
    return dot ? Number(dot.dataset.gk ?? dot.dataset.bk) : null;
  };
  let dragging = null;
  root.addEventListener("pointerdown", (evt) => {
    if (evt.pointerType !== "mouse" || evt.button !== 0 || !root._chartSeek.onSeek) return;
    const svg = evt.target.closest?.("svg[data-channel]");
    if (!svg) return;
    dragging = svg;
    svg.setPointerCapture?.(evt.pointerId);
    evt.preventDefault();
    seekAt(svg, evt.clientX, { final: false });
  });
  root.addEventListener("pointermove", (evt) => {
    if (dragging && evt.pointerType === "mouse") seekAt(dragging, evt.clientX, { final: false });
  });
  const end = (evt) => {
    if (!dragging) return;
    const svg = dragging;
    dragging = null;
    seekAt(svg, evt.clientX, { final: true });
    root._chartSeekSwallow = true; // the click that follows is this drag's
  };
  root.addEventListener("pointerup", end);
  root.addEventListener("pointercancel", () => (dragging = null));
  root.addEventListener("click", (evt) => {
    if (root._chartSeekSwallow) {
      root._chartSeekSwallow = false;
      return;
    }
    const seek = root._chartSeek.onSeek;
    if (!seek) return;
    const sk = scatterK(evt.target);
    if (sk != null) return seek(sk, { final: true });
    const svg = evt.target.closest?.("svg[data-channel]");
    if (svg) seekAt(svg, evt.clientX, { final: true });
  });
}

// The panel's tabs (epic #193): the analysis area holds more views without
// becoming a page nobody scrolls to the bottom of. The first tab is the
// data-logger view — the delta, speed and the driver's inputs stacked on one
// axis, because the question a trace answers is almost always "what was I
// doing with my feet and hands while the speed did that". Grip and Car are
// the two questions that need a chart of their own kind. A chart lands on the
// tab its channel answers for; only tabs with content render, and a single
// populated tab renders flat without a tab bar. Pinned for the ports by
// contracts/logic/lap-axis.json.
export const TABS = [
  { key: "traces", label: "Traces" },
  { key: "grip", label: "Grip" },
  { key: "car", label: "Car" },
];
export const TAB_OF = { delta: "traces", speed: "traces", throttle: "traces", brake: "traces", steering: "traces", rpm: "traces", latG: "grip", yaw: "grip" };

// A slot colour as the track map wants it: the custom property's name.
const slotVarName = (color) => /^var\((--[\w-]+)\)$/.exec(color)?.[1] ?? "--accent";

// Render + wire the whole panel into `container`: the lap chips (always
// visible — they are the session's lap list) and the charts inside a
// collapsible <details>, rendered lazily on first expand. Chips toggle laps
// into the highlight slots (max 3 at once; oldest is evicted). The fastest
// lap starts highlighted. `renderExtras(litMap, dispN)` — litMap being
// Map(chIdx -> slot color) and dispN the display lap number per channel lap —
// returns HTML rendered with the charts and re-rendered with them — either
// a string (goes above the Traces tab's charts) or { [tabKey]: html } to
// place markup per tab, where a tab's value may be { before, after } to put
// markup under its charts as well. `renderAfter` — { [channelKey]: (litMap,
// dispN, axis) => svg } — slots a chart straight under that channel's chart
// on the same axis (`axis` is the panel's axisFrame from js/lap-axis.js):
// app.js hangs the gear ribbon from js/gears.js under the RPM trace.
// `memory` — a plain object the caller keeps across re-renders — is read for
// the panel's initial state (`open`, `tab`, `lit`, `axis`, `pin`) and written
// back on every change, so a route() re-render after a save (recording hot
// pressures on a setup sheet from the Car tab, say) lands back on the same
// tab with the same laps lit rather than on a collapsed panel.
// Returns { rerender }, which redraws the charts with the current selection
// — for a caller whose extras depend on state the panel doesn't own.
// `units` — the unit system to label speed and distance in (defaults to the
// account's cached choice).
// `chipAfter(lap)` — markup joined to the end of a session lap's chip (the
// lap's ▶ video control, NS-50), re-run with every chip re-render; a chip
// with something after it is wrapped in a `.lap-group`. `afterChips` — markup
// placed once between the chips and the charts (the session's lap video
// player, so it opens next to the ▶ that asked for it); the chips' re-renders
// never touch it.
// `onRender(chartsEl)` — called after every render of the charts, which
// rebuilds them whole: the lap stage (NS-51) re-applies its playhead from it.
// `onSelect(lit)` — called with the lit channel-lap indexes, oldest first,
// whenever a chip changes them; the stage re-picks its sides from it.
// `pro` — whether the account gets the Pro half of the panel (#264). A free
// account's `channels` already arrive with only the free traces (the server
// strips the rest), but the delta chart and the caller's extras — sectors,
// shift points, the friction circle, the Car tab — derive from what is left,
// so they are the panel's own gate; with `pro: false` none of them render and
// `lockedHtml` (the caller's Pro note) is appended under the charts instead.
// The cursor: pointing at a chart marks that place on every chart — a line,
// a dot and the value on each lit lap's trace — and, when `trace` (the
// session's best-lap polyline) is given, a dot per lit lap on a track map
// beside the Traces tab's charts. A click or tap pins it there until Clear.
// `onCursor(cursor)` hears every change, cursor being null or { axis, x,
// places: [{ chIdx, k, frac, color }] } (color a custom property name), so
// the event page can move the dots on its own map too. `cursorEnabled()` —
// false while the lap stage owns the playhead, when a pointer marks nothing
// and a click seeks the stage instead (bindChartSeek).
export function bindChannelGraphs(container, channels, sessionLaps, { renderExtras, renderAfter, memory, units = currentUnits(), pro = true, lockedHtml = "", chipAfter, afterChips = "", onRender, onSelect, trace = null, onCursor, cursorEnabled = () => true } = {}) {
  const CHANNEL_DEFS = channelDefs(units);
  const chLaps = channels.laps;
  const dStep = channels.dStepM;
  const rows = matchLapsToChannels(sessionLaps, chLaps);
  const bestMs = Math.min(...sessionLaps.map((l) => l.time_ms));
  // Chart tooltips label laps by the session's lap numbers, same as the chips.
  const dispN = chLaps.map((cl) => cl.n);
  for (const { lap, chIdx } of rows) if (chIdx >= 0) dispN[chIdx] = lap.lap_num;

  const matched = rows.filter((r) => r.chIdx >= 0);
  const bestRow = matched.length
    ? matched.reduce((a, b) => (b.lap.time_ms < a.lap.time_ms ? b : a))
    : null;
  // A time axis needs a speed trace to integrate; every stored lap has one
  // today, but an entry without it simply has no time series.
  const canTime = chLaps.some((l) => Array.isArray(l.speed) && l.speed.length >= 2);
  const remembered = memory?.lit?.filter((i) => Number.isInteger(i) && i >= 0 && i < chLaps.length);
  const state = {
    lit: remembered?.length ? remembered.slice(0, SLOTS.length) : bestRow ? [bestRow.chIdx] : [], // channel-lap indexes in slot order
    tab: memory?.tab ?? null,
    axis: canTime && memory?.axis === "time" ? "time" : DEFAULT_AXIS,
    pin: Number.isFinite(memory?.pin) ? memory.pin : null, // a value on state.axis
  };
  const hasMap = Array.isArray(trace) && trace.length >= 10;

  const litMap = () => new Map(state.lit.map((lapIdx, slot) => [lapIdx, SLOTS[slot]]));

  const chanNames = CHANNEL_DEFS.filter((def) => chLaps.some((l) => l[def.key]))
    .map((def) => def.label.toLowerCase())
    .join(" · ");
  container.innerHTML = `
    <div class="laps ch-chips"></div>
    ${afterChips}
    <details class="ch-details"${memory?.open ? " open" : ""}>
      <summary>Channel graphs <span class="hint">${chanNames} vs <span class="ch-axis-word">${axisWord(state.axis)}</span></span></summary>
      <div class="ch-head">
        <div class="hint">Tap laps to compare (up to 3). Point at a chart to mark the place on every chart${hasMap ? " and the track map" : ""}; tap or click to pin it.${
          pro ? " With 2+ laps selected, the delta chart shows where time is gained or lost vs the fastest." : ""
        }</div>
        ${
          canTime
            ? `<div class="ch-axis seg" role="group" aria-label="Plot the laps against">${["distance", "time"]
                .map((m) => `<button type="button" data-ch-axis="${m}" aria-pressed="${m === state.axis}">${m === "time" ? "Time" : "Distance"}</button>`)
                .join("")}</div>`
            : ""
        }
      </div>
      <div class="ch-cursor-bar" hidden><span class="ch-cursor-text"></span> <button type="button" class="linklike" data-ch-unpin>Clear</button></div>
      <div class="ch-graphs"></div>
    </details>`;
  const chipsEl = container.querySelector(".ch-chips");
  const details = container.querySelector(".ch-details");
  const chartsEl = container.querySelector(".ch-graphs");
  const pinBar = container.querySelector(".ch-cursor-bar");
  let chartsDirty = true;
  let mapHandle = null;
  let deltaByIdx = new Map();
  let refIdx = null;
  let frame = null;
  const remember = () => {
    if (memory) Object.assign(memory, { open: details.open, tab: state.tab, lit: [...state.lit], axis: state.axis, pin: state.pin });
  };

  // The cursor at axis value x (null clears it): every lit lap's place there,
  // drawn on the charts by showPlayhead and on the maps as dots.
  let cursorShown = false;
  // While the stage owns the playhead the places are still worked out (the
  // tooltip reads them) but nothing is drawn.
  const setCursor = (x) => {
    const places = x == null ? [] : axisPlaces(chLaps, dStep, state.axis, x, state.lit);
    const lit = litMap();
    const colored = places.map((p) => ({ ...p, color: slotVarName(lit.get(p.chIdx)) }));
    if (!cursorEnabled()) return colored;
    if (!colored.length) {
      if (cursorShown) showPlayhead(chartsEl, null);
      mapHandle?.setPlayhead(null);
      if (cursorShown) onCursor?.(null);
      cursorShown = false;
      return colored;
    }
    const first = places[0];
    showPlayhead(chartsEl, {
      dStepM: dStep,
      k: first.k,
      n: frame.xsOf(first.chIdx).length,
      axis: state.axis,
      x,
      laps: places.map((p) => ({
        chIdx: p.chIdx,
        k: p.k,
        color: lit.get(p.chIdx),
        entry: chLaps[p.chIdx],
        delta: p.chIdx === refIdx || !deltaByIdx.has(p.chIdx) ? null : at(deltaByIdx.get(p.chIdx), p.k),
      })),
    });
    const dots = colored.map((p) => ({ frac: p.frac, color: p.color }));
    mapHandle?.setPlayhead(dots);
    cursorShown = true;
    onCursor?.({ axis: state.axis, x, places: colored });
    return colored;
  };
  const showPin = () => {
    const on = state.pin != null && cursorEnabled();
    pinBar.hidden = !on;
    if (on) pinBar.querySelector(".ch-cursor-text").textContent = `Marked at ${fmtAxisValue(state.pin, state.axis, units)}`;
  };
  pinBar.querySelector("[data-ch-unpin]").onclick = () => {
    state.pin = null;
    remember();
    showPin();
    setCursor(null);
  };

  const renderChips = () => {
    const lit = litMap();
    chipsEl.innerHTML = rows
      .map(({ lap, chIdx }) => {
        const label = `Lap ${lap.lap_num} · ${fmtMs(lap.time_ms)}${lap.time_ms === bestMs ? " ★" : ""}`;
        const after = chipAfter?.(lap) ?? "";
        const group = (chip) => (after ? `<span class="lap-group">${chip}${after}</span>` : chip);
        if (chIdx < 0) return group(`<span class="lap">${label}</span>`);
        const color = lit.get(chIdx);
        return group(`<button type="button" class="lap ch-chip${color ? " on" : ""}" data-ch-lap="${chIdx}" ${color ? `style="border-color:${color}"` : ""}>
          <span class="dot" style="background:${color ?? "var(--chart-dim)"}"></span>${label}
        </button>`);
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
        changed();
      };
    });
  };
  const changed = () => {
    remember();
    renderChips();
    if (details.open) renderCharts();
    else chartsDirty = true;
    onSelect?.([...state.lit]);
  };

  container.querySelectorAll("[data-ch-axis]").forEach((btn) => {
    btn.onclick = () => {
      if (btn.dataset.chAxis === state.axis) return;
      state.axis = btn.dataset.chAxis;
      // A pinned place is a value on the old axis; it means nothing on the new one.
      state.pin = null;
      remember();
      container.querySelectorAll("[data-ch-axis]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      container.querySelector(".ch-axis-word").textContent = axisWord(state.axis);
      if (details.open) renderCharts();
      else chartsDirty = true;
    };
  });

  // Charts render lazily on first expand — laps × 3 SVGs is wasted work for
  // a collapsed panel — and re-render only while open.
  const renderCharts = () => {
    chartsDirty = false;
    const lit = litMap();
    frame = axisFrame(chLaps, dStep, state.axis, units);
    // Delta chart first when 2+ laps are highlighted: reference is the
    // fastest of the selection, deltas cached for the tooltip.
    refIdx = null;
    deltaByIdx = new Map();
    if (pro && state.lit.length >= 2) {
      refIdx = state.lit.reduce((a, b) => (chLaps[b].timeMs < chLaps[a].timeMs ? b : a));
      for (const i of state.lit) {
        if (i === refIdx) continue;
        const d = deltaSeries(chLaps[i], chLaps[refIdx], dStep);
        if (d) deltaByIdx.set(i, d);
      }
    }
    const deltaSvg = refIdx != null ? deltaChartSvg(channels, lit, refIdx, dispN[refIdx], { units, axis: frame }) : "";
    const chart = (c) => `<div class="ch-chart">${c}</div>`;
    const byTab = new Map(TABS.map((t) => [t.key, []]));
    const tailByTab = new Map(TABS.map((t) => [t.key, []]));
    const extras = pro && renderExtras ? renderExtras(lit, dispN) : "";
    const extraByTab = typeof extras === "string" ? { traces: extras } : (extras ?? {});
    for (const t of TABS) {
      const ex = extraByTab[t.key];
      if (!ex) continue;
      if (typeof ex === "string") byTab.get(t.key).push(ex);
      else {
        if (ex.before) byTab.get(t.key).push(ex.before);
        if (ex.after) tailByTab.get(t.key).push(ex.after);
      }
    }
    if (deltaSvg) byTab.get("traces").push(chart(deltaSvg));
    for (const def of CHANNEL_DEFS) {
      const list = byTab.get(TAB_OF[def.key]);
      const svg = channelChartSvg(def, channels, lit, { units, axis: frame });
      if (svg) list.push(chart(svg));
      const after = pro ? renderAfter?.[def.key]?.(lit, dispN, frame) : "";
      if (after) list.push(chart(after));
    }
    for (const t of TABS) byTab.get(t.key).push(...tailByTab.get(t.key));
    const tabs = TABS.filter((t) => byTab.get(t.key).length);
    if (!tabs.some((t) => t.key === state.tab)) state.tab = tabs[0]?.key ?? null;
    // The track map rides beside the Traces tab's charts (under them is no
    // use: the place is wanted while reading the trace).
    const withMap = (key, html) =>
      hasMap && key === "traces"
        ? `<div class="ch-cursor-layout"><div class="ch-cursor-charts">${html}</div><div class="ch-cursor-map chart-card"><canvas role="img" aria-label="Racing line of the best lap — the marked place shows as a dot per lap"></canvas><div class="hint">The marked place, one dot per lap, on the best lap's line.</div></div></div>`
        : html;
    if (tabs.length <= 1) {
      chartsEl.innerHTML = tabs.map((t) => withMap(t.key, byTab.get(t.key).join(""))).join("");
    } else {
      chartsEl.innerHTML =
        `<div class="ch-tabs" role="tablist">${tabs
          .map((t) => `<button type="button" role="tab" aria-selected="${t.key === state.tab}" data-ch-tab="${t.key}">${t.label}</button>`)
          .join("")}</div>` +
        tabs
          .map((t) => `<div class="ch-tabpanel" role="tabpanel" data-ch-panel="${t.key}"${t.key === state.tab ? "" : " hidden"}>${withMap(t.key, byTab.get(t.key).join(""))}</div>`)
          .join("");
      // Switching tabs only toggles visibility — every tab is rendered, so
      // the selection and the tooltips survive the switch.
      chartsEl.querySelectorAll("[data-ch-tab]").forEach((btn) => {
        btn.onclick = () => {
          state.tab = btn.dataset.chTab;
          remember();
          chartsEl.querySelectorAll("[data-ch-tab]").forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
          chartsEl.querySelectorAll("[data-ch-panel]").forEach((p) => (p.hidden = p.dataset.chPanel !== state.tab));
        };
      });
    }
    // The locked note sits under every tab rather than on one of them: what
    // Pro adds is spread across all of them.
    if (!pro && lockedHtml) chartsEl.insertAdjacentHTML("beforeend", lockedHtml);

    // Each chart learns its laps' axis series, so a dot on it (cursor or
    // stage playhead) finds its x on a time axis. The delta chart is drawn
    // against the reference lap's series.
    chartsEl.querySelectorAll("svg[data-channel]").forEach((svgEl) => {
      svgEl._xsOf = svgEl.dataset.channel === "delta" ? () => frame.xsOf(refIdx) : frame.xsOf;
    });
    const canvas = chartsEl.querySelector(".ch-cursor-map canvas");
    mapHandle = canvas ? renderTrackMap(canvas, trace, { width: 340 }) : null;

    // Pointing: the cursor follows the pointer and the tooltip names the
    // place and each lit lap's value; a click pins the cursor there.
    const $tooltip = document.getElementById("tooltip");
    chartsEl.querySelectorAll("svg[data-channel]").forEach((svgEl) => {
      const def = CHANNEL_DEFS.find((d) => d.key === svgEl.dataset.channel);
      const x1 = Number(svgEl.dataset.x1);
      const padL = Number(svgEl.dataset.padl), padR = Number(svgEl.dataset.padr);
      const vbW = svgEl.viewBox.baseVal.width;
      const xAt = (evt) => {
        const rect = svgEl.getBoundingClientRect();
        const frac = (((evt.clientX - rect.left) / rect.width) * vbW - padL) / (vbW - padL - padR);
        return Math.max(0, Math.min(1, frac)) * x1;
      };
      svgEl.addEventListener("mousemove", (evt) => {
        const x = xAt(evt);
        const places = setCursor(x);
        const tipRows = places
          .map((p) => {
            const color = litMap().get(p.chIdx);
            const k = Math.round(p.k);
            const lapIdx = p.chIdx;
            if (svgEl.dataset.channel === "delta") {
              const arr = deltaByIdx.get(lapIdx);
              if (!arr || k >= arr.length) return "";
              const v = arr[k];
              return `<div class="t-sub"><span style="color:${color}">●</span> Lap ${dispN[lapIdx]} — ${v >= 0 ? "+" : ""}${v.toFixed(2)} s vs lap ${dispN[refIdx]}</div>`;
            }
            if (svgEl.dataset.channel === "gear") {
              const arr = chLaps[lapIdx]?.gear;
              if (!arr || k >= arr.length) return "";
              return `<div class="t-sub"><span style="color:${color}">●</span> Lap ${dispN[lapIdx]} — ${esc(ordinal(arr[k]))}</div>`;
            }
            const arr = chLaps[lapIdx]?.[def.key];
            if (!arr || k >= arr.length) return "";
            const lim = activeLimitLabels(chLaps[lapIdx], k);
            const where = state.axis === "time" ? ` at ${esc(fmtDistIn(Math.round(k * dStep), units))}` : "";
            return `<div class="t-sub"><span style="color:${color}">●</span> Lap ${dispN[lapIdx]} — ${def.conv(arr[k]).toFixed(def.dp)} ${esc(def.unit)}${where}${lim.length ? ` · ${esc(lim.join(", "))}` : ""}</div>`;
          })
          .join("");
        if (!tipRows) { $tooltip.hidden = true; return; }
        $tooltip.innerHTML = `<div class="t-val">${esc(fmtAxisValue(x, state.axis, units))}</div>${tipRows}`;
        $tooltip.hidden = false;
        const tw = $tooltip.offsetWidth;
        let left = evt.clientX + 14;
        if (left + tw > window.innerWidth - 8) left = evt.clientX - tw - 14;
        $tooltip.style.left = `${left}px`;
        $tooltip.style.top = `${evt.clientY - 12}px`;
      });
      svgEl.addEventListener("mouseleave", () => {
        $tooltip.hidden = true;
        setCursor(state.pin);
      });
      svgEl.addEventListener("click", (evt) => {
        if (!cursorEnabled()) return; // the stage's seek has this click
        state.pin = xAt(evt);
        remember();
        showPin();
        setCursor(state.pin);
      });
    });
    showPin();
    setCursor(state.pin);
    onRender?.(chartsEl);
  };

  details.addEventListener("toggle", () => {
    remember();
    if (details.open && chartsDirty) renderCharts();
  });
  renderChips();
  if (details.open) renderCharts();
  return {
    rerender: () => {
      if (details.open) renderCharts();
      else chartsDirty = true;
    },
    // The lit laps, oldest first, and a way to light one — a lap's ▶ opens
    // the stage on that lap, so it joins the charts too.
    lit: () => [...state.lit],
    light: (chIdx) => {
      if (state.lit.includes(chIdx) || chIdx < 0 || chIdx >= chLaps.length) return;
      state.lit.push(chIdx);
      if (state.lit.length > SLOTS.length) state.lit.shift();
      changed();
    },
    slotColor: (chIdx) => litMap().get(chIdx) ?? null,
    // The axis the charts are on, and a lap's series on it — for a caller
    // that has to turn a chart's time into a grid index (the stage's seek).
    axis: () => state.axis,
    axisSeries: (chIdx) => (frame ?? axisFrame(chLaps, dStep, state.axis, units)).xsOf(chIdx),
    // Re-read cursorEnabled(): the stage opening hides the cursor, its
    // closing brings a pinned one back.
    refreshCursor: () => {
      showPin();
      if (cursorEnabled()) setCursor(state.pin);
      else {
        mapHandle?.setPlayhead(null);
        if (cursorShown) onCursor?.(null);
        cursorShown = false;
      }
    },
    chartsEl,
    details,
  };
}
