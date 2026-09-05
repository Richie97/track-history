// Rotation — understeer or oversteer (issue #189): the pure half plus the web
// rendering.
//
// A PDR import stores `yaw` (yaw rate, °/s, signed) and `steering`
// (steering-wheel angle, °, signed) per lap on the driven-distance grid
// (js/import/channels.js). Alone the yaw trace is another squiggle. Against
// the steering trace it is a balance diagnosis: in a neutral car the rotation
// follows the steering; when the driver adds steering and the car does not
// rotate to match, the front is washing out — understeer; when the car
// rotates more than the steering asked for, the rear is coming round —
// oversteer. Amateurs nearly always believe they are oversteering when they
// are understeering, because understeer feels like nothing happening, and
// this view exists to settle that argument with the car's own numbers.
//
// The rigorous version is the bicycle model: expected yaw rate = v·δ/L, with
// δ the *road-wheel* angle (steering-wheel angle ÷ steering ratio) and L the
// wheelbase. Neither the ratio nor the wheelbase is stored, and the ratio is
// non-linear with lock on some cars, so v1 is deliberately **relative**: the
// session's own median yaw-per-degree-per-metre-per-second over every
// cornering sample is taken as this car's typical response (`referenceGain`,
// which absorbs 1/(L·ratio)), and each corner is read against it. A corner
// whose rotation falls short of that is understeering *relative to how this
// car usually responds*, one that exceeds it is oversteering. The consequence
// is stated wherever the figures are shown: a car that pushes in every corner
// reads neutral in every corner. What the view does find is the corner that
// behaves differently from the rest — which is the one worth taking to the
// setup sheet.
//
// The scatter is the ticket's steering-against-yaw plot with the speed
// dependence divided out: y is yaw rate ÷ speed (°/m — how far the car
// rotated per metre driven, i.e. the curvature it actually took), so a
// neutral car is *one* dashed line through the origin rather than a fan of
// lines, one per speed, that needs a colour ramp to read. That frees colour
// for lap identity, which is what colour means everywhere else in the panel.
// Speed goes in the tooltip.
//
// Two data facts shape everything here and a port would inherit both. The
// sign conventions of `yaw` and `steering` are the recorder's, not ours, and
// nothing guarantees they agree — so the alignment is *measured* per session
// (`yawSign`: the sign of Σ steering·yaw over the cornering samples) rather
// than assumed. And the 20 m grid smooths transients: yaw builds a beat after
// the steering goes on at entry and decays a beat after it comes off at
// exit, so single samples scatter around the line and only the sum over a
// whole corner is a reading. The read-out therefore works per corner, never
// per sample, and the scatter is there to show the shape, not to be read
// point by point.
//
// Web-first (see docs/specs/native/README.md): written to port, not pinned in
// contracts/logic/ until a port exists.

import { CORNER_MIN_G, cornerAt, cornerLabel, sessionCorners } from "./corners.js";
import { esc } from "./format.js";
import { niceNumTicks } from "./chart.js";

// Below this steering-wheel angle the yaw-per-degree ratio is noise divided
// by noise; such samples plot but never count. Display semantics, tune
// against real footage.
export const MIN_STEER_DEG = 10;

// Below this speed the car is in the pits or the paddock, not cornering.
export const MIN_SPEED_KPH = 30;

// A corner whose rotation sits within this much of the reference reads
// neutral; beyond SLIGHT_PCT the word drops its "slight".
export const NEUTRAL_PCT = 8;
export const SLIGHT_PCT = 20;

const KPH_TO_MPS = 1 / 3.6;
const KPH_TO_MPH = 0.621371;

// True when the lap stored the three channels the diagnosis reads.
export function hasBalanceData(entry) {
  return Array.isArray(entry?.yaw) && Array.isArray(entry?.steering) && Array.isArray(entry?.speed);
}

// The laps of a session that can be read, as [{chIdx, entry}].
export function balanceLaps(channels) {
  const out = [];
  (channels?.laps ?? []).forEach((entry, chIdx) => {
    if (hasBalanceData(entry)) out.push({ chIdx, entry });
  });
  return out;
}

// The grid points a lap covers with all three channels.
const usableLength = (entry) => Math.min(entry.yaw.length, entry.steering.length, entry.speed.length);

// Whether grid point k of a lap counts toward a reading: enough steering to
// divide by, and moving.
export function usableAt(entry, k) {
  if (!hasBalanceData(entry) || k >= usableLength(entry)) return false;
  return Math.abs(entry.steering[k]) >= MIN_STEER_DEG && entry.speed[k] >= MIN_SPEED_KPH;
}

// Which way the recorder's yaw runs relative to its steering: +1 when a
// positive steering angle produces a positive yaw rate, -1 when the two
// conventions oppose. Measured over every usable sample of every readable
// lap; +1 when there is nothing to measure. See the header.
export function yawSign(channels) {
  let sum = 0;
  for (const { entry } of balanceLaps(channels)) {
    const n = usableLength(entry);
    for (let k = 0; k < n; k++) if (usableAt(entry, k)) sum += entry.steering[k] * entry.yaw[k];
  }
  return sum < 0 ? -1 : 1;
}

// One sample's yaw gain: aligned yaw rate per degree of steering per metre
// per second — the bicycle model's 1/(L·ratio), in 1/m. null when the sample
// is not usable.
export function yawGain(entry, k, sign = 1) {
  if (!usableAt(entry, k)) return null;
  return (entry.yaw[k] * sign) / (entry.speed[k] * KPH_TO_MPS * entry.steering[k]);
}

// The median of a list, or null for an empty one.
export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// This car's typical response today: the median yaw gain over every usable
// sample of every readable lap. null when there is none.
export function referenceGain(channels, sign = yawSign(channels)) {
  const gains = [];
  for (const { entry } of balanceLaps(channels)) {
    const n = usableLength(entry);
    for (let k = 0; k < n; k++) {
      const g = yawGain(entry, k, sign);
      if (g != null) gains.push(g);
    }
  }
  return median(gains);
}

// One lap as scatter points: [{k, steer, rot, speed, usable}] with `steer` the
// steering angle as stored, `rot` the aligned yaw rate ÷ speed (°/m) and
// `speed` in km/h. One point per grid sample carrying all three channels; a
// stationary sample has no rotation per metre and is skipped.
export function balancePoints(entry, sign = 1) {
  if (!hasBalanceData(entry)) return [];
  const n = usableLength(entry);
  const out = [];
  for (let k = 0; k < n; k++) {
    const v = entry.speed[k] * KPH_TO_MPS;
    if (!(v > 0)) continue;
    out.push({ k, steer: entry.steering[k], rot: (entry.yaw[k] * sign) / v, speed: entry.speed[k], usable: usableAt(entry, k) });
  }
  return out;
}

// pct from the summed actual and expected rotation: how far the corner's
// rotation sits from the reference, in percent — negative is understeer.
const withPct = (sums) => ({ ...sums, ratio: sums.actual / sums.expected, pct: (sums.actual / sums.expected - 1) * 100 });

// How one lap took one corner ({k0, k1}) against the reference gain: the
// sum over its usable samples of the rotation the steering asked for
// (`expected`, |refGain·v·δ|) and the rotation the car delivered projected
// onto it (`actual`), their `ratio`, and `pct` = (ratio − 1)·100. Sums rather
// than a mean of per-sample ratios, so a barely-steering sample can't blow
// the reading up. null when the corner holds no usable sample of this lap.
export function cornerBalance(entry, corner, refGain, sign = 1) {
  if (!hasBalanceData(entry) || !(refGain > 0)) return null;
  let expected = 0, actual = 0, samples = 0;
  const n = usableLength(entry);
  for (let k = corner.k0; k <= corner.k1 && k < n; k++) {
    if (!usableAt(entry, k)) continue;
    const e = refGain * entry.speed[k] * KPH_TO_MPS * entry.steering[k];
    expected += Math.abs(e);
    actual += entry.yaw[k] * sign * Math.sign(e);
    samples++;
  }
  if (!samples || !(expected > 0)) return null;
  return withPct({ expected, actual, samples });
}

// The word for a reading. Negative pct is the front washing out.
export function balanceLabel(pct) {
  const a = Math.abs(pct);
  if (a < NEUTRAL_PCT) return "neutral";
  const word = pct < 0 ? "understeer" : "oversteer";
  return a < SLIGHT_PCT ? `slight ${word}` : word;
}

// The word with its magnitude: "understeer 14%", "slight oversteer 9%",
// "neutral".
export function fmtBalance(pct) {
  const label = balanceLabel(pct);
  return label === "neutral" ? label : `${label} ${Math.round(Math.abs(pct))}%`;
}

// A session reduced for the read-out: { sign, refGain, corners: [{…corner,
// laps: [{chIdx, expected, actual, samples, ratio, pct}], all}] } with one
// entry per corner some readable lap took, `laps` in channel order and `all`
// the same sums pooled across every readable lap. null when no lap stored the
// three channels, no lap stored latG to find corners in, or the reference
// can't be established.
export function sessionBalance(channels) {
  const laps = balanceLaps(channels);
  if (!laps.length) return null;
  const corners = sessionCorners(channels);
  if (!corners.length) return null;
  const sign = yawSign(channels);
  const refGain = referenceGain(channels, sign);
  if (!(refGain > 0)) return null;
  const rows = [];
  for (const c of corners) {
    const perLap = [];
    let expected = 0, actual = 0, samples = 0;
    for (const { chIdx, entry } of laps) {
      const cb = cornerBalance(entry, c, refGain, sign);
      if (!cb) continue;
      perLap.push({ chIdx, ...cb });
      expected += cb.expected;
      actual += cb.actual;
      samples += cb.samples;
    }
    if (!perLap.length) continue;
    rows.push({ ...c, laps: perLap, all: withPct({ expected, actual, samples }) });
  }
  return rows.length ? { sign, refGain, corners: rows } : null;
}

// Corners named when there are a few, counted when there are many —
// "T1, T4" reads; "T1, T3, T5, T7, T9, T11" doesn't.
const MAX_NAMED_CORNERS = 3;
function namedOrCounted(corners) {
  if (corners.length <= MAX_NAMED_CORNERS) return corners.map(cornerLabel).join(", ");
  return `${corners.length} corners`;
}

// One line for the session stats: "understeer in T1, T4 and oversteer in
// T10", one half when only one side shows, "balance neutral" when every
// corner reads neutral against the reference. null when the session can't be
// read. Pooled across laps, like the rest of the stats line.
export function balanceSummary(channels) {
  const sb = sessionBalance(channels);
  if (!sb) return null;
  const us = sb.corners.filter((c) => c.all.pct <= -NEUTRAL_PCT);
  const os = sb.corners.filter((c) => c.all.pct >= NEUTRAL_PCT);
  const parts = [];
  if (us.length) parts.push(`understeer in ${namedOrCounted(us)}`);
  if (os.length) parts.push(`oversteer in ${namedOrCounted(os)}`);
  return parts.length ? parts.join(" and ") : "balance neutral";
}

// --- web rendering (not ported) --------------------------------------------

const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km` : `${m} m`);
const fmtG = (g) => g.toFixed(2);

// The scatter: steering angle across, rotation per metre up, one point per
// grid sample of the highlighted laps (`lit`: Map(chIdx -> slot colour), as
// everywhere in the panel) over a dim envelope of the session's other laps,
// with the reference response as a dashed line through the origin. Both axes
// are symmetric about zero so left- and right-handers read the same. Returns
// "" when no lap carries the three channels. Exported for unit tests.
export function balanceScatterSvg(channels, lit, labelFor, { width = 900, height = 380 } = {}) {
  const laps = balanceLaps(channels);
  if (!laps.length) return "";
  const sign = yawSign(channels);
  const refGain = referenceGain(channels, sign);
  const dStep = channels.dStepM;
  const corners = sessionCorners(channels);

  const pts = laps.map(({ chIdx, entry }) => ({ chIdx, pts: balancePoints(entry, sign) }));
  let xMax = 0, yMax = 0;
  for (const { pts: ps } of pts) {
    for (const p of ps) {
      if (Math.abs(p.steer) > xMax) xMax = Math.abs(p.steer);
      if (Math.abs(p.rot) > yMax) yMax = Math.abs(p.rot);
    }
  }
  xMax = Math.max(xMax * 1.06, MIN_STEER_DEG);
  yMax = Math.max(yMax * 1.06, 1e-3);

  const pad = { l: 56, r: 14, t: 20, b: 26 };
  const cx = pad.l + (width - pad.l - pad.r) / 2, cy = pad.t + (height - pad.t - pad.b) / 2;
  const sx = (width - pad.l - pad.r) / 2 / xMax, sy = (height - pad.t - pad.b) / 2 / yMax;
  const X = (deg) => cx + deg * sx;
  const Y = (rot) => cy - rot * sy;

  let grid = "", labels = "";
  for (const tv of niceNumTicks(-yMax, yMax, 4)) {
    const y = Y(tv).toFixed(1);
    grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y}" y2="${y}" stroke="var(--chart-grid)" stroke-width="1"/>`;
    labels += `<text x="${pad.l - 8}" y="${y}" dy="0.35em" text-anchor="end" fill="var(--text-faint)" font-size="11" style="font-variant-numeric:tabular-nums">${tv.toFixed(1)}</text>`;
  }
  for (const tv of niceNumTicks(-xMax, xMax, 6)) {
    labels += `<text x="${X(tv).toFixed(1)}" y="${height - 8}" text-anchor="middle" fill="var(--text-faint)" font-size="11" style="font-variant-numeric:tabular-nums">${tv.toFixed(0)}°</text>`;
  }
  // The axes through the origin: a neutral car is a line through it.
  grid += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${cy.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="var(--border-strong)" stroke-width="1"/>`;
  grid += `<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${pad.t}" y2="${height - pad.b}" stroke="var(--border-strong)" stroke-width="1"/>`;
  labels += `<text x="${pad.l}" y="12" fill="var(--text-muted)" font-size="11" font-weight="600">Rotation (°/m) against steering (°)</text>`;

  // The reference: this car's typical response, clipped to the plot.
  let ref = "";
  if (refGain > 0) {
    const xEnd = Math.min(xMax, yMax / refGain);
    ref = `<line x1="${X(-xEnd).toFixed(1)}" y1="${Y(-xEnd * refGain).toFixed(1)}" x2="${X(xEnd).toFixed(1)}" y2="${Y(xEnd * refGain).toFixed(1)}" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="5 4"/>`;
    // Region words, in the right-hand half where positive steering lives:
    // above the line the car rotated more than asked, below it less.
    labels += `<text x="${(cx + 10).toFixed(1)}" y="${(pad.t + 12).toFixed(1)}" text-anchor="start" fill="var(--text-faint)" font-size="11">oversteer — rotating more than asked</text>`;
    labels += `<text x="${(width - pad.r - 4).toFixed(1)}" y="${(cy + 16).toFixed(1)}" text-anchor="end" fill="var(--text-faint)" font-size="11">understeer — the front washing out</text>`;
  }

  // Every unhighlighted lap as one dim path of dots.
  let dim = "";
  const dimPts = [];
  for (const { chIdx, pts: ps } of pts) {
    if (lit.get(chIdx)) continue;
    for (const p of ps) dimPts.push(`M${X(p.steer).toFixed(1)},${Y(p.rot).toFixed(1)}h0.01`);
  }
  if (dimPts.length) {
    dim = `<path d="${dimPts.join("")}" fill="none" stroke="var(--chart-dim)" stroke-width="2.4" stroke-linecap="round"/>`;
  }

  // Highlighted laps as real points, hoverable back to a place on track.
  // Samples that don't count toward a reading (straight-line, slow) draw
  // fainter so the blob at the origin doesn't read as data.
  let dots = "";
  for (const { chIdx, pts: ps } of pts) {
    const color = lit.get(chIdx);
    if (!color) continue;
    const d = ps
      .map((p) => `<circle cx="${X(p.steer).toFixed(1)}" cy="${Y(p.rot).toFixed(1)}" r="2.6" data-bk="${p.k}"${p.usable ? "" : ' fill-opacity="0.3"'}/>`)
      .join("");
    dots += `<g data-balance-lap="${chIdx}" data-balance-label="${esc(labelFor(chIdx))}" fill="${color}" fill-opacity="0.75">${d}</g>`;
  }

  const litLabels = [...lit.keys()].filter((i) => laps.some((l) => l.chIdx === i)).map(labelFor);
  return `<svg class="balance-svg" viewBox="0 0 ${width} ${height}" role="img" data-balance="1" data-dstep="${dStep}" data-corners="${corners.length}"
    aria-label="Balance: yaw rate per metre against steering angle, one point per 20 metre sample${
      litLabels.length ? ` for ${esc(litLabels.join(", "))}` : ""
    }. The dashed line is this car's typical response; points above it are oversteer, below it understeer.">
    ${grid}${dim}${ref}${dots}${labels}
  </svg>`;
}

// The per-corner table: one row per corner, a column per highlighted lap and
// — with two or more readable laps — the session pooled. Rows carry the
// corner's grid mid-point so a hover can point at the track. Returns "" when
// no highlighted lap can be read.
export function balanceTableHtml(channels, lit, labelFor) {
  const sb = sessionBalance(channels);
  if (!sb) return "";
  const readable = balanceLaps(channels);
  const cols = [...lit.entries()].filter(([chIdx]) => readable.some((l) => l.chIdx === chIdx));
  if (!cols.length) return "";
  const pooled = readable.length >= 2;
  const dStep = channels.dStepM;
  const cell = (cb) => {
    if (!cb) return `<td class="num bal-none">—</td>`;
    const cls = Math.abs(cb.pct) < NEUTRAL_PCT ? "bal-n" : cb.pct < 0 ? "bal-us" : "bal-os";
    return `<td class="num ${cls}">${esc(fmtBalance(cb.pct))}</td>`;
  };
  const heads = cols
    .map(([chIdx, color]) => `<th class="num"><span class="dot" style="background:${color}"></span> ${esc(labelFor(chIdx))}</th>`)
    .join("");
  const body = sb.corners
    .map((c) => {
      const mid = Math.round((c.k0 + c.k1) / 2);
      return `<tr data-corner="${c.n}" data-corner-k="${mid}"><td>${esc(cornerLabel(c))}</td>
        <td class="num">${esc(fmtDist(Math.round(c.k0 * dStep)))}</td>
        <td class="num">${fmtG(c.peakG)}</td>
        ${cols.map(([chIdx]) => cell(c.laps.find((l) => l.chIdx === chIdx))).join("")}
        ${pooled ? cell(c.all) : ""}</tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table class="balance">
      <thead><tr><th>Corner</th><th class="num">At</th><th class="num">Peak G</th>${heads}${pooled ? `<th class="num">Session</th>` : ""}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

// The whole Grip-tab card: the scatter plus the per-corner table. Returns ""
// when the session stored no lap with the three channels.
export function balanceHtml(channels, lit, labelFor) {
  const svg = balanceScatterSvg(channels, lit, labelFor);
  if (!svg) return "";
  const table = balanceTableHtml(channels, lit, labelFor);
  return `<div class="ch-balance">
    <div class="sec-head">Balance <span class="hint">— how much the car rotated for the steering it was given. In a neutral car the two rise together; steering the car doesn't answer is understeer, rotation it wasn't asked for is oversteer.</span></div>
    <div class="balance-plot">${svg}</div>
    ${table}
    <div class="hint">Corners are stretches of sustained cornering force (${fmtG(CORNER_MIN_G)} G or more) counted from the start/finish line, so the T-numbers are this app's, not the circuit's. Each reading is how far the corner's rotation sits from this car's typical response over the whole session — the dashed line — because the exact version needs the wheelbase and steering ratio, which aren't recorded. That makes it relative: a car that pushes in every corner reads neutral in every corner, and what shows up is the corner that behaves differently from the rest.</div>
  </div>`;
}

// Hover: a point on the scatter or a row of the table is a place on track.
// Delegated from a container that survives the panel's re-renders (the chips
// re-render the charts), so it is bound once. `onHover({ chIdx, k, d, frac,
// label })` fires with the hovered point — `chIdx` null for a corner row,
// which is a place every lap shares — and with null when the pointer leaves.
export function bindBalance(container, channels, { onHover } = {}) {
  const $tooltip = document.getElementById("tooltip");
  const corners = sessionCorners(channels);
  const gridN = Math.max(0, ...(channels?.laps ?? []).map((l) => l.speed?.length ?? 0));
  const hide = () => {
    if ($tooltip) $tooltip.hidden = true;
    onHover?.(null);
  };
  const place = ($tooltip, evt) => {
    $tooltip.hidden = false;
    const tw = $tooltip.offsetWidth;
    let x = evt.clientX + 14;
    if (x + tw > window.innerWidth - 8) x = evt.clientX - tw - 14;
    $tooltip.style.left = `${x}px`;
    $tooltip.style.top = `${evt.clientY - 12}px`;
  };

  container.addEventListener("mouseover", (evt) => {
    const dot = evt.target.closest?.("svg[data-balance] circle[data-bk]");
    if (dot) {
      const g = dot.closest("[data-balance-lap]");
      const chIdx = Number(g.dataset.balanceLap);
      const k = Number(dot.dataset.bk);
      const entry = channels.laps[chIdx];
      const dStep = channels.dStepM;
      const d = Math.round(k * dStep);
      const n = usableLength(entry);
      const corner = cornerAt(corners, k);
      if ($tooltip) {
        $tooltip.innerHTML = `<div class="t-val">${esc(fmtDist(d))}${corner ? ` · ${esc(cornerLabel(corner))}` : ""}</div>
          <div class="t-sub">${esc(g.dataset.balanceLabel)} — ${Math.round(entry.steering[k])}° steering · ${Math.round(entry.yaw[k])}°/s yaw</div>
          <div class="t-sub">${Math.round(entry.speed[k] * KPH_TO_MPH)} mph</div>`;
        place($tooltip, evt);
      }
      onHover?.({ chIdx, k, d, frac: n > 1 ? k / (n - 1) : 0, label: g.dataset.balanceLabel });
      return;
    }
    const row = evt.target.closest?.("table.balance tr[data-corner]");
    if (row) {
      const k = Number(row.dataset.cornerK);
      const d = Math.round(k * channels.dStepM);
      onHover?.({ chIdx: null, k, d, frac: gridN > 1 ? k / (gridN - 1) : 0, label: `T${row.dataset.corner}` });
    }
  });

  container.addEventListener("mouseout", (evt) => {
    if (evt.target.closest?.("svg[data-balance] circle[data-bk]")) hide();
    else if (evt.target.closest?.("table.balance tr[data-corner]")) onHover?.(null);
  });
  container.addEventListener("mouseleave", hide);
}
