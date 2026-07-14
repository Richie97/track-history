// Hand-rolled SVG lap-time line charts: 2px line, >=8px markers with a 2px
// surface ring, hairline gridlines, hover tooltip. Lower = faster.
// lineChart() is pure string building; only bind() touches the DOM.

import { esc, fmtMs } from "./format.js";

export function niceTimeTicks(min, max, count = 4) {
  const span = Math.max(1, max - min);
  const rawStep = span / count;
  const steps = [100, 200, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000];
  const step = steps.find((s) => s >= rawStep) ?? 300000;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(v);
  return ticks;
}

// Entrance animation for a bound chart: the line sweeps in left-to-right,
// markers fade in behind it, and the newest point gets a brief pulse ring.
// Decorative only — skipped entirely under prefers-reduced-motion.
function animateDraw(svgEl, pts) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const path = svgEl.querySelector("path"); // the data line; grid/goal are <line>s
  if (!path || !path.getTotalLength) return;
  const len = path.getTotalLength();
  if (!len) return;
  path.style.strokeDasharray = String(len);
  path.style.strokeDashoffset = String(len);
  const circles = [...svgEl.querySelectorAll("circle[data-i]")];
  circles.forEach((c) => (c.style.opacity = "0"));

  const last = pts[pts.length - 1];
  const pulse = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  pulse.setAttribute("cx", last.px.toFixed(1));
  pulse.setAttribute("cy", last.py.toFixed(1));
  pulse.setAttribute("r", "5");
  pulse.setAttribute("fill", "none");
  pulse.setAttribute("stroke", "var(--accent)");
  pulse.setAttribute("stroke-width", "2");
  pulse.setAttribute("class", "chart-pulse");
  svgEl.appendChild(pulse);

  // double rAF so the initial dashoffset paints before the transition starts
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      path.style.transition = "stroke-dashoffset 1000ms cubic-bezier(0.22, 1, 0.36, 1)";
      path.style.strokeDashoffset = "0";
      circles.forEach((c, i) => {
        c.style.transition = `opacity 240ms ease ${120 + (i / Math.max(1, circles.length - 1)) * 800}ms`;
        c.style.opacity = "1";
      });
    })
  );
}

// points: [{x: epochMs, y: lapMs, ...meta}]
// goal: optional target lap time (ms) drawn as a horizontal reference line —
// red while unbeaten, green once a point meets or beats it.
export function lineChart(points, { width = 900, height = 300, sparkline = false, goal = null } = {}) {
  if (!points.length) return { svg: "", bind: () => {} };
  const hasGoal = !sparkline && typeof goal === "number" && Number.isFinite(goal);
  const goalMet = hasGoal && Math.min(...points.map((p) => p.y)) <= goal;
  const pad = sparkline
    ? { l: 2, r: 6, t: 4, b: 4 }
    : { l: 64, r: 20, t: 12, b: 28 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  // Keep the goal line inside the plotted range so it's always visible.
  if (hasGoal) { y0 = Math.min(y0, goal); y1 = Math.max(y1, goal); }
  if (x0 === x1) { x0 -= 1; x1 += 1; }
  const ypad = Math.max((y1 - y0) * 0.12, 500);
  y0 -= ypad; y1 += ypad;
  const X = (v) => pad.l + ((v - x0) / (x1 - x0)) * (width - pad.l - pad.r);
  // Invert: faster (smaller) lap times sit lower on the chart, so improvement trends downward.
  const Y = (v) => pad.t + ((y1 - v) / (y1 - y0)) * (height - pad.t - pad.b);

  const pts = points.map((p) => ({ ...p, px: X(p.x), py: Y(p.y) }));
  const path = pts.map((p, i) => `${i ? "L" : "M"}${p.px.toFixed(1)},${p.py.toFixed(1)}`).join(" ");

  let grid = "", labels = "", dots = "";
  if (!sparkline) {
    for (const tv of niceTimeTicks(y0, y1)) {
      const y = Y(tv).toFixed(1);
      grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y}" y2="${y}" stroke="var(--chart-grid)" stroke-width="1"/>`;
      labels += `<text x="${pad.l - 8}" y="${y}" dy="0.35em" text-anchor="end" fill="var(--text-faint)" font-size="11" style="font-variant-numeric:tabular-nums">${fmtMs(tv)}</text>`;
    }
    // x labels: first, last, and up to 2 between
    const n = pts.length;
    const idxs = [...new Set([0, Math.floor((n - 1) / 3), Math.floor(((n - 1) * 2) / 3), n - 1])];
    for (const i of idxs) {
      const p = pts[i];
      const anchor = n === 1 ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle";
      labels += `<text x="${p.px.toFixed(1)}" y="${height - 8}" text-anchor="${anchor}" fill="var(--text-faint)" font-size="11">${esc(p.xlabel ?? "")}</text>`;
    }
    grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${height - pad.b}" y2="${height - pad.b}" stroke="var(--border-strong)" stroke-width="1"/>`;
    dots = pts
      .map(
        (p, i) =>
          `<circle data-i="${i}" cx="${p.px.toFixed(1)}" cy="${p.py.toFixed(1)}" r="4.5" fill="var(--chart-line)" stroke="var(--surface-card)" stroke-width="2" style="cursor:${p.href ? "pointer" : "default"}"/>`
      )
      .join("");
  } else {
    const last = pts[pts.length - 1];
    dots = `<circle cx="${last.px.toFixed(1)}" cy="${last.py.toFixed(1)}" r="3" fill="var(--accent)" stroke="var(--surface-card)" stroke-width="2"/>`;
  }

  let goalLayer = "";
  if (hasGoal) {
    const gy = Y(goal).toFixed(1);
    const col = goalMet ? "var(--positive)" : "var(--danger)";
    goalLayer = `<line x1="${pad.l}" x2="${width - pad.r}" y1="${gy}" y2="${gy}" stroke="${col}" stroke-width="1.5" stroke-dasharray="6 5"/>
      <text x="${width - pad.r}" y="${(Number(gy) - 6).toFixed(1)}" text-anchor="end" fill="${col}" font-size="11" font-weight="600">Goal ${fmtMs(goal)}${goalMet ? " ✓" : ""}</text>`;
  }

  const strokeCol = sparkline ? "var(--text-faint)" : "var(--chart-line)";
  const svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Lap time trend">
    ${grid}${labels}${goalLayer}
    <path d="${path}" fill="none" stroke="${strokeCol}" stroke-width="${sparkline ? 1.5 : 2.25}" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  </svg>`;

  // Hover/click wiring for the full chart (nearest point by x).
  const bind = (container) => {
    if (sparkline) return;
    const $tooltip = document.getElementById("tooltip");
    const svgEl = container.querySelector("svg");
    animateDraw(svgEl, pts);
    const circles = [...svgEl.querySelectorAll("circle[data-i]")];
    const nearest = (evt) => {
      const rect = svgEl.getBoundingClientRect();
      const mx = ((evt.clientX - rect.left) / rect.width) * width;
      let best = 0, bestD = Infinity;
      pts.forEach((p, i) => {
        const d = Math.abs(p.px - mx);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    };
    svgEl.addEventListener("mousemove", (evt) => {
      const i = nearest(evt);
      const p = pts[i];
      circles.forEach((el, j) => el.setAttribute("r", j === i ? "6" : "4.5"));
      $tooltip.innerHTML = `<div class="t-val">${fmtMs(p.y)}</div><div class="t-sub">${esc(p.tip ?? "")}</div>`;
      $tooltip.hidden = false;
      const tw = $tooltip.offsetWidth;
      let left = evt.clientX + 14;
      if (left + tw > window.innerWidth - 8) left = evt.clientX - tw - 14;
      $tooltip.style.left = `${left}px`;
      $tooltip.style.top = `${evt.clientY - 12}px`;
    });
    svgEl.addEventListener("mouseleave", () => {
      $tooltip.hidden = true;
      circles.forEach((el) => el.setAttribute("r", "4.5"));
    });
    svgEl.addEventListener("click", (evt) => {
      const p = pts[nearest(evt)];
      if (p.href) location.hash = p.href;
    });
  };
  return { svg, bind };
}

// Overlay chart for comparing lap-time series (e.g. two events at one track).
// series: [{label, color, points: [{x: lapNum, y: lapMs}]}] — shared axes,
// same lower-is-faster inversion as lineChart.
export function multiLineChart(series, { width = 900, height = 300 } = {}) {
  const drawn = series.filter((s) => s.points.length);
  if (!drawn.length) return { svg: "", bind: () => {} };
  const pad = { l: 64, r: 20, t: 12, b: 28 };
  const all = drawn.flatMap((s) => s.points);
  let x0 = Math.min(...all.map((p) => p.x)), x1 = Math.max(...all.map((p) => p.x));
  let y0 = Math.min(...all.map((p) => p.y)), y1 = Math.max(...all.map((p) => p.y));
  if (x0 === x1) { x0 -= 1; x1 += 1; }
  const ypad = Math.max((y1 - y0) * 0.12, 500);
  y0 -= ypad; y1 += ypad;
  const X = (v) => pad.l + ((v - x0) / (x1 - x0)) * (width - pad.l - pad.r);
  const Y = (v) => pad.t + ((y1 - v) / (y1 - y0)) * (height - pad.t - pad.b);

  let grid = "", labels = "";
  for (const tv of niceTimeTicks(y0, y1)) {
    const y = Y(tv).toFixed(1);
    grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y}" y2="${y}" stroke="var(--chart-grid)" stroke-width="1"/>`;
    labels += `<text x="${pad.l - 8}" y="${y}" dy="0.35em" text-anchor="end" fill="var(--text-faint)" font-size="11" style="font-variant-numeric:tabular-nums">${fmtMs(tv)}</text>`;
  }
  grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${height - pad.b}" y2="${height - pad.b}" stroke="var(--border-strong)" stroke-width="1"/>`;
  // x axis: whole lap numbers, at most ~8 labels
  const step = Math.max(1, Math.ceil((x1 - x0) / 8));
  for (let v = Math.ceil(x0); v <= x1; v += step) {
    labels += `<text x="${X(v).toFixed(1)}" y="${height - 8}" text-anchor="middle" fill="var(--text-faint)" font-size="11">${v}</text>`;
  }

  const layers = drawn
    .map((s) => {
      const pts = s.points.map((p) => ({ ...p, px: X(p.x), py: Y(p.y) }));
      const path = pts.map((p, i) => `${i ? "L" : "M"}${p.px.toFixed(1)},${p.py.toFixed(1)}`).join(" ");
      const dots = pts
        .map((p) => `<circle cx="${p.px.toFixed(1)}" cy="${p.py.toFixed(1)}" r="3.5" fill="${s.color}" stroke="var(--surface-card)" stroke-width="1.5"/>`)
        .join("");
      return `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
    })
    .join("");

  const svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Lap time comparison">
    ${grid}${labels}${layers}
  </svg>`;

  // Tooltip: nearest lap number by x; lists each series' time at that lap.
  const bind = (container) => {
    const $tooltip = document.getElementById("tooltip");
    const svgEl = container.querySelector("svg");
    svgEl.addEventListener("mousemove", (evt) => {
      const rect = svgEl.getBoundingClientRect();
      const mx = ((evt.clientX - rect.left) / rect.width) * width;
      const lap = Math.round(x0 + ((mx - pad.l) / (width - pad.l - pad.r)) * (x1 - x0));
      const rows = drawn
        .map((s) => {
          const p = s.points.find((pt) => pt.x === lap);
          return p ? `<div class="t-sub"><span style="color:${s.color}">●</span> ${esc(s.label)} — ${fmtMs(p.y)}</div>` : "";
        })
        .join("");
      if (!rows) { $tooltip.hidden = true; return; }
      $tooltip.innerHTML = `<div class="t-val">Lap ${lap}</div>${rows}`;
      $tooltip.hidden = false;
      const tw = $tooltip.offsetWidth;
      let left = evt.clientX + 14;
      if (left + tw > window.innerWidth - 8) left = evt.clientX - tw - 14;
      $tooltip.style.left = `${left}px`;
      $tooltip.style.top = `${evt.clientY - 12}px`;
    });
    svgEl.addEventListener("mouseleave", () => {
      $tooltip.hidden = true;
    });
  };
  return { svg, bind };
}
