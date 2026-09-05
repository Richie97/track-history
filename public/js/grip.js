// The friction circle (issue #186): the pure half plus the web rendering.
//
// A PDR import stores `latG` and `longG` per lap on the driven-distance grid
// (js/import/channels.js). Neither says much alone — a longitudinal-G trace is
// the brake trace with extra steps — but plotted *against each other* they
// draw the one picture in amateur telemetry that says what to do differently
// rather than only where the time went.
//
// The tyre has one grip budget, spent in any direction. Brake in a straight
// line, release, turn, then accelerate and the samples draw a cross: full
// braking at the top, full cornering at the sides, nothing in between.
// Trail the brake into the corner and feed the throttle out of it and the
// samples fill the circle. The empty space between the cross and the circle
// is the lost time.
//
// Two properties of the stored data shape everything here.
//
// **`latG` is a magnitude, not a signed value.** pdr.js stores
// `abs(lateral acceleration)` (and sanitizeChannels clamps the channel at 0),
// so left and right are indistinguishable in the blob. The side is recovered
// from the sign of the `steering` trace at the same grid point — steering
// angle *is* turn direction — and a lap that stored no steering plots on the
// right-hand side alone. That is a derivation, so it is named
// (`latSign`), one-sided output is a legitimate outcome, and the read-out
// below never depends on it: the quadrant shares use |latG|.
//
// **The 20 m grid smooths peaks.** A grid point every 20 m is about 0.3 s at
// 250 km/h, so a spike is averaged away and these figures are the *shape* of
// grip usage rather than peak G. The peaks are `metrics.maxLatG` /
// `maxBrakeG`, taken from the full-rate series at import.
//
// Web-first (see docs/specs/native/README.md): the pure half below is written
// to port, but nothing is pinned in contracts/logic/ until a port exists.

import { esc } from "./format.js";

// Combined G below this is the car coasting, not the tyre working. It is the
// denominator of the read-out: "of the time you were actually using the
// tyre, how much of it was combined" is the question that trends across a
// day, and one long straight would otherwise decide the answer.
export const MIN_LOAD_G = 0.3;

// One axis below this is not meaningfully doing that thing, so the sample is
// not combined cornering. Display semantics, not physics — tune against real
// footage, like WHEELSPIN_PCT in limits.js.
export const COMBINED_MIN_G = 0.2;

// The reference arc is the session's own peak combined G at this percentile,
// not its maximum: one kerb strike should not set the envelope for the day.
export const PEAK_PERCENTILE = 0.99;

// True when the lap stored both halves of the picture.
export function hasGripData(entry) {
  return Array.isArray(entry?.latG) && Array.isArray(entry?.longG);
}

// The laps of a session that can be plotted, as [{chIdx, entry}].
export function gripLaps(channels) {
  const out = [];
  (channels?.laps ?? []).forEach((entry, chIdx) => {
    if (hasGripData(entry)) out.push({ chIdx, entry });
  });
  return out;
}

// Which way the car was turning at grid point k: the sign of the steering
// angle, or +1 for a lap that stored no steering (so its samples land on one
// side rather than being dropped). See the header — the stored latG carries
// no side of its own.
export function latSign(entry, k) {
  const s = entry?.steering;
  if (!Array.isArray(s) || k >= s.length) return 1;
  return s[k] < 0 ? -1 : 1;
}

// One lap as scatter points: [{k, lat, long, g}] with `lat` signed by
// latSign, `long` signed as stored (negative under braking) and `g` the
// combined magnitude. One point per grid sample carrying both channels.
export function gripPoints(entry) {
  if (!hasGripData(entry)) return [];
  const n = Math.min(entry.latG.length, entry.longG.length);
  const out = new Array(n);
  for (let k = 0; k < n; k++) {
    const lat = Math.abs(entry.latG[k]);
    const long = entry.longG[k];
    out[k] = { k, lat: lat * latSign(entry, k), long, g: Math.hypot(lat, long) };
  }
  return out;
}

// How one lap spent its grip budget: the share of *loaded* samples (combined
// G at or above MIN_LOAD_G) that were cornering while braking and cornering
// while on the power. Those two numbers are the coaching point — a cross
// scores near zero on both, a filled circle scores high — and they trend
// across a day. null when the lap has no loaded sample.
export function gripShares(entry) {
  return sharesOf(gripPoints(entry));
}

// The shares of an already-built point list, so a caller holding the points
// doesn't walk the lap twice.
function sharesOf(pts) {
  let loaded = 0, trailBrake = 0, powerDown = 0;
  for (const p of pts) {
    if (p.g < MIN_LOAD_G) continue;
    loaded++;
    if (Math.abs(p.lat) < COMBINED_MIN_G) continue;
    if (p.long <= -COMBINED_MIN_G) trailBrake++;
    else if (p.long >= COMBINED_MIN_G) powerDown++;
  }
  if (!loaded) return null;
  return {
    samples: pts.length,
    loaded,
    trailBrake,
    powerDown,
    trailPct: (trailBrake / loaded) * 100,
    powerPct: (powerDown / loaded) * 100,
  };
}

// The session's peak combined G at `pct` (PEAK_PERCENTILE by default), over
// every sample of every lap that stored both channels — the radius of the
// reference arc, i.e. what this car actually did today. null when the
// session stored no plottable lap.
export function peakCombinedG(channels, pct = PEAK_PERCENTILE) {
  const all = [];
  for (const { entry } of gripLaps(channels)) for (const p of gripPoints(entry)) all.push(p.g);
  if (!all.length) return null;
  all.sort((a, b) => a - b);
  return all[Math.min(all.length - 1, Math.max(0, Math.floor(pct * (all.length - 1))))];
}

// A session reduced for the read-out: { peakG, maxG, laps: [{chIdx, ...shares}] }
// in lap order, plus the shares of every plottable sample pooled (`all`), so
// the session has a figure of its own beside the per-lap rows. null when no
// lap stored both channels.
export function sessionGrip(channels, pct = PEAK_PERCENTILE) {
  const laps = gripLaps(channels);
  if (!laps.length) return null;
  const rows = [];
  let maxG = 0;
  let loaded = 0, trailBrake = 0, powerDown = 0, samples = 0;
  for (const { chIdx, entry } of laps) {
    const pts = gripPoints(entry);
    for (const p of pts) if (p.g > maxG) maxG = p.g;
    const sh = sharesOf(pts);
    if (!sh) continue;
    rows.push({ chIdx, ...sh });
    samples += sh.samples;
    loaded += sh.loaded;
    trailBrake += sh.trailBrake;
    powerDown += sh.powerDown;
  }
  if (!rows.length) return null;
  return {
    peakG: peakCombinedG(channels, pct),
    maxG,
    laps: rows,
    all: {
      samples,
      loaded,
      trailBrake,
      powerDown,
      trailPct: (trailBrake / loaded) * 100,
      powerPct: (powerDown / loaded) * 100,
    },
  };
}

// --- web rendering (not ported) --------------------------------------------

const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km` : `${m} m`);
const fmtG = (g) => g.toFixed(2);
const pct = (v) => `${Math.round(v)}%`;

// Ring spacing for the grid, in G. 0.5 G rings are readable on every car this
// app sees; a slow car simply draws fewer of them.
const RING_STEP_G = 0.5;

// The axis domain: the furthest sample, or the reference arc if it somehow
// reaches further, with a little air — rounded up to a ring boundary so the
// outermost ring is a labelled one.
function axisMaxG(maxG, peakG) {
  const need = Math.max(maxG, peakG ?? 0) * 1.04;
  return Math.max(RING_STEP_G, Math.ceil(need / RING_STEP_G) * RING_STEP_G);
}

// The scatter itself. `lit` is Map(chIdx -> slot color) as everywhere in the
// panel; highlighted laps draw as points in their slot colour over a dim
// envelope of every other lap. Square plot area — a circle has to look like a
// circle or the whole reading is wrong — so the plot rect is forced square
// inside the viewBox rather than trusting the padding to balance.
// Returns "" when no lap carries both channels. Exported for unit tests.
export function frictionCircleSvg(channels, lit, labelFor, { size = 460 } = {}) {
  const laps = gripLaps(channels);
  if (!laps.length) return "";
  const dStep = channels.dStepM;
  const sg = sessionGrip(channels);
  const axis = axisMaxG(sg?.maxG ?? 1, sg?.peakG);

  const pad = { l: 44, r: 16, t: 22, b: 30 };
  const side = Math.min(size - pad.l - pad.r, size - pad.t - pad.b);
  const left = pad.l + (size - pad.l - pad.r - side) / 2;
  const top = pad.t + (size - pad.t - pad.b - side) / 2;
  const cx = left + side / 2, cy = top + side / 2;
  const scale = side / 2 / axis;
  const X = (g) => cx + g * scale;
  // Braking is up. `longG` is negative under braking, so the y mapping is
  // *not* the usual "subtract to go up": deceleration is the force a driver
  // reads as the top of the picture, and the trace under a brake pedal is the
  // one thing on this chart that has a fixed place in a driver's head.
  const Y = (g) => cy + g * scale;

  // Rings at every RING_STEP_G, labelled along the +x axis, plus the axes.
  let grid = "", labels = "";
  for (let r = RING_STEP_G; r <= axis + 1e-9; r += RING_STEP_G) {
    grid += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r * scale).toFixed(1)}" fill="none" stroke="var(--chart-grid)" stroke-width="1"/>`;
    labels += `<text x="${X(r).toFixed(1)}" y="${(cy + 12).toFixed(1)}" text-anchor="middle" fill="var(--text-faint)" font-size="10" style="font-variant-numeric:tabular-nums">${fmtG(r)}</text>`;
  }
  grid += `<line x1="${left.toFixed(1)}" x2="${(left + side).toFixed(1)}" y1="${cy.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="var(--border-strong)" stroke-width="1"/>`;
  grid += `<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${top.toFixed(1)}" y2="${(top + side).toFixed(1)}" stroke="var(--border-strong)" stroke-width="1"/>`;

  // The reference arc: what this car did today, at the 99th percentile.
  let arc = "";
  if (sg?.peakG > 0) {
    arc = `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(sg.peakG * scale).toFixed(1)}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="5 4"/>
      <text x="${cx.toFixed(1)}" y="${(cy - sg.peakG * scale - 6).toFixed(1)}" text-anchor="middle" fill="var(--accent-ink)" font-size="11" font-weight="600">${fmtG(sg.peakG)} G</text>`;
  }

  // Axis wording: braking up, power down, cornering to the sides. The side
  // labels say "cornering", not "left"/"right", because the side is derived
  // from the steering sign (see latSign) rather than stored.
  labels += `<text x="${cx.toFixed(1)}" y="${(top - 6).toFixed(1)}" text-anchor="middle" fill="var(--text-faint)" font-size="11">braking</text>`;
  labels += `<text x="${cx.toFixed(1)}" y="${(top + side + 20).toFixed(1)}" text-anchor="middle" fill="var(--text-faint)" font-size="11">power</text>`;
  // The x-axis label goes in a corner of the square: the plot is a disc, so
  // the corners are the one area no sample can ever land in.
  labels += `<text x="${left.toFixed(1)}" y="${(top + 10).toFixed(1)}" text-anchor="start" fill="var(--text-faint)" font-size="11">cornering (G)</text>`;

  // Every unhighlighted lap as one dim path of dots — thousands of samples
  // would be thousands of nodes as circles, and none of them is hoverable.
  let dim = "";
  const dimPts = [];
  for (const { chIdx, entry } of laps) {
    if (lit.get(chIdx)) continue;
    for (const p of gripPoints(entry)) dimPts.push(`M${X(p.lat).toFixed(1)},${Y(p.long).toFixed(1)}h0.01`);
  }
  if (dimPts.length) {
    dim = `<path d="${dimPts.join("")}" fill="none" stroke="var(--chart-dim)" stroke-width="2.4" stroke-linecap="round"/>`;
  }

  // Highlighted laps as real points, so each one can be hovered back to a
  // place on track. data-gk is the grid index; the lap's identity and label
  // sit on the group.
  let pts = "";
  for (const { chIdx, entry } of laps) {
    const color = lit.get(chIdx);
    if (!color) continue;
    const dots = gripPoints(entry)
      .map((p) => `<circle cx="${X(p.lat).toFixed(1)}" cy="${Y(p.long).toFixed(1)}" r="2.6" data-gk="${p.k}"/>`)
      .join("");
    pts += `<g data-grip-lap="${chIdx}" data-grip-label="${esc(labelFor(chIdx))}" fill="${color}" fill-opacity="0.75">${dots}</g>`;
  }

  const litLabels = [...lit.keys()].filter((i) => laps.some((l) => l.chIdx === i)).map(labelFor);
  return `<svg class="grip-svg" viewBox="0 0 ${size} ${size}" role="img" data-grip="1" data-dstep="${dStep}"
    aria-label="Friction circle: lateral against longitudinal G, one point per 20 metre sample${
      litLabels.length ? ` for ${esc(litLabels.join(", "))}` : ""
    }. Braking plots up, power down, cornering to the sides; the dashed arc is the session's peak combined ${sg?.peakG ? fmtG(sg.peakG) : "grip"} G.">
    ${grid}${dim}${arc}${pts}${labels}
  </svg>`;
}

// The quadrant read-out under the scatter: one row per highlighted lap, the
// session pooled underneath when there is more than one lap to pool. The two
// percentages are of *loaded* samples — see MIN_LOAD_G.
export function gripReadoutHtml(channels, lit, labelFor) {
  const sg = sessionGrip(channels);
  if (!sg) return "";
  const rows = [...lit.entries()]
    .map(([chIdx, color]) => ({ color, lap: sg.laps.find((l) => l.chIdx === chIdx) }))
    .filter((r) => r.lap);
  if (!rows.length) return "";
  const body = rows
    .map(
      ({ color, lap }) =>
        `<tr><td><span class="dot" style="background:${color}"></span> ${esc(labelFor(lap.chIdx))}</td>
          <td class="num">${pct(lap.trailPct)}</td><td class="num">${pct(lap.powerPct)}</td></tr>`
    )
    .join("");
  const all =
    sg.laps.length >= 2
      ? `<tr class="sec-theo"><td>Session</td><td class="num">${pct(sg.all.trailPct)}</td><td class="num">${pct(sg.all.powerPct)}</td></tr>`
      : "";
  return `<div class="table-wrap"><table class="grip-quads">
      <thead><tr><th></th><th class="num">Braking + cornering</th><th class="num">Cornering + power</th></tr></thead>
      <tbody>${body}${all}</tbody>
    </table></div>
    <div class="hint">Share of the samples where the tyre was working (${fmtG(MIN_LOAD_G)} G combined or more) spent doing two things at once. A driver who brakes straight, turns, then accelerates scores low on both — the gap between that cross and the arc is time.</div>`;
}

// The whole Grip-tab card: the scatter plus its read-out. Returns "" when the
// session stored no lap with both channels (so the tab is only offered when
// there is something in it).
export function gripCircleHtml(channels, lit, labelFor) {
  const svg = frictionCircleSvg(channels, lit, labelFor);
  if (!svg) return "";
  return `<div class="ch-grip">
    <div class="sec-head">Friction circle <span class="hint">— how much of the tyre is actually being used. 20 m samples, so this is the shape of grip usage, not peak G.</span></div>
    <div class="grip-plot">${svg}</div>
    ${gripReadoutHtml(channels, lit, labelFor)}
  </div>`;
}

// Hover: a point on the scatter is a place on track, which is the whole
// reason it is worth plotting. Delegated from a container that survives the
// panel's re-renders (the chips re-render the charts), so it is bound once.
// `onHover({ chIdx, k, d, frac, label })` fires with the hovered point and
// with null when the pointer leaves — app.js uses it to mark the distance on
// the channel charts and the place on the best-lap trace.
export function bindGripCircle(container, channels, { onHover } = {}) {
  const $tooltip = document.getElementById("tooltip");
  const hide = () => {
    if ($tooltip) $tooltip.hidden = true;
    onHover?.(null);
  };

  container.addEventListener("mouseover", (evt) => {
    const dot = evt.target.closest?.("svg[data-grip] circle[data-gk]");
    if (!dot) return;
    const g = dot.closest("[data-grip-lap]");
    const chIdx = Number(g.dataset.gripLap);
    const k = Number(dot.dataset.gk);
    const entry = channels.laps[chIdx];
    const dStep = channels.dStepM;
    const d = Math.round(k * dStep);
    const n = Math.min(entry.latG.length, entry.longG.length);
    const lat = Math.abs(entry.latG[k]);
    const long = entry.longG[k];
    if ($tooltip) {
      const dir = long < 0 ? "braking" : "power";
      $tooltip.innerHTML = `<div class="t-val">${esc(fmtDist(d))}</div>
        <div class="t-sub">${esc(g.dataset.gripLabel)} — ${fmtG(lat)} G cornering · ${fmtG(Math.abs(long))} G ${dir}</div>
        <div class="t-sub">${fmtG(Math.hypot(lat, long))} G combined</div>`;
      $tooltip.hidden = false;
      const tw = $tooltip.offsetWidth;
      let x = evt.clientX + 14;
      if (x + tw > window.innerWidth - 8) x = evt.clientX - tw - 14;
      $tooltip.style.left = `${x}px`;
      $tooltip.style.top = `${evt.clientY - 12}px`;
    }
    onHover?.({ chIdx, k, d, frac: n > 1 ? k / (n - 1) : 0, label: g.dataset.gripLabel });
  });

  container.addEventListener("mouseout", (evt) => {
    if (evt.target.closest?.("svg[data-grip] circle[data-gk]")) hide();
  });
  container.addEventListener("mouseleave", hide);
}
