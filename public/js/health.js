// Session health (issue #190): the pure half plus the web rendering.
//
// Every PDR import stores fourteen numbers per lap that are not lap-time data
// — peak oil / coolant / transmission temperature, minimum oil pressure, fuel
// and the four tyre pressures as the lap ended, peak tyre temperature on each
// corner, minimum battery voltage (SCALAR_NAMES in js/import/channels.js) —
// plus a `boost` trace whose per-lap peak is a heat-soak signal rather than a
// driving one. They answer "is the car okay, and is it set up right", which
// is the other half of a track day, and they get the panel's Car tab.
//
// Three rules shape everything here.
//
// **The reduction is the importer's, never re-derived.** A stored `oilC` is
// the lap's peak, `oilKpa` its minimum, a tyre pressure the value as the lap
// finished; HEALTH_DEFS restates each rule only so the view can *say* it
// ("peak", "min", "at lap end"). Boost is the one figure not stored as a
// scalar — it is a gridded trace — so its per-lap peak is derived here, and
// that is the only derivation.
//
// **Thresholds shade, they don't alarm.** Each figure with a line has a
// `watch` level and an `over` level in the stored unit, and the two statuses
// are the garage's own wear vocabulary — `low` (approaching) and `due` (past
// the line) — so the strip reuses the part cards' colours rather than
// inventing a second scale. The levels are display semantics, not physics,
// tuned for the cars this app sees; a figure with no line has no status.
//
// **Cross-corner spread is the figure that matters.** LF−RF and front−rear
// tyre-temperature deltas are camber and balance evidence, and they are what
// a setup change is judged by; `tyreSpread` is that reduction and the
// pressure-loop below is the action it leads to: given the setup sheet's cold
// pressures, the import's hot pressures and a target hot pressure per
// vehicle, "drop 2 psi cold to land on target".
//
// Values are kept in the stored units (°C, kPa, V, %) throughout the pure
// half; display conversion is a separate step (`displayValue`) so a port can
// pin the numbers without pinning a locale. Web-first (see
// docs/specs/native/README.md): written to port, pinned in contracts/logic/
// when the first port lands.

import { esc } from "./format.js";

// The strip's columns, grouped, in display order. `reduce` is the importer's
// rule (see the header) and `low: true` means the hazard is *below* the
// lines rather than above them. Thresholds are in the stored unit.
export const HEALTH_GROUPS = [
  ["temps", "Temperatures"],
  ["pressures", "Pressures"],
  ["electrical", "Fuel & electrical"],
];
export const HEALTH_DEFS = [
  { key: "oilC", label: "Oil temp", group: "temps", unit: "°C", reduce: "max", watch: 120, over: 130 },
  { key: "coolantC", label: "Coolant", group: "temps", unit: "°C", reduce: "max", watch: 110, over: 120 },
  { key: "transC", label: "Transmission", group: "temps", unit: "°C", reduce: "max", watch: 110, over: 125 },
  { key: "tyreCLF", label: "Tyre LF", group: "temps", unit: "°C", reduce: "max" },
  { key: "tyreCRF", label: "Tyre RF", group: "temps", unit: "°C", reduce: "max" },
  { key: "tyreCLR", label: "Tyre LR", group: "temps", unit: "°C", reduce: "max" },
  { key: "tyreCRR", label: "Tyre RR", group: "temps", unit: "°C", reduce: "max" },
  { key: "oilKpa", label: "Oil pressure", group: "pressures", unit: "kPa", reduce: "min", low: true, watch: 200, over: 120 },
  { key: "boost", label: "Boost", group: "pressures", unit: "kPa", reduce: "max", derived: true },
  { key: "tyreKpaLF", label: "Tyre LF", group: "pressures", unit: "kPa", reduce: "end" },
  { key: "tyreKpaRF", label: "Tyre RF", group: "pressures", unit: "kPa", reduce: "end" },
  { key: "tyreKpaLR", label: "Tyre LR", group: "pressures", unit: "kPa", reduce: "end" },
  { key: "tyreKpaRR", label: "Tyre RR", group: "pressures", unit: "kPa", reduce: "end" },
  { key: "fuelPct", label: "Fuel", group: "electrical", unit: "%", reduce: "end", low: true, watch: 20, over: 10 },
  { key: "battV", label: "Battery", group: "electrical", unit: "V", reduce: "min", low: true, watch: 13, over: 12.5 },
];

// The four corners in the order the strip and the setup sheet both use, with
// the sheet's key for each (SETUP_FIELDS' "corners" shape in js/garage.js).
export const TYRE_CORNERS = [
  ["LF", "fl"],
  ["RF", "fr"],
  ["LR", "rl"],
  ["RR", "rr"],
];

export const KPA_PER_PSI = 6.894757;
export const kpaToPsi = (kpa) => kpa / KPA_PER_PSI;
export const psiToKpa = (psi) => psi * KPA_PER_PSI;
export const cToF = (c) => c * 1.8 + 32;

// Fewer than this many fuel drops and a burn rate is one lap's noise.
export const MIN_FUEL_DROPS = 2;

// Cold-pressure suggestions land on the setup sheet's own step.
export const PSI_STEP = 0.5;

// A cross-corner spread worth shading, in stored units: 10 °C across an axle
// or between axles is a camber or balance question; 2 psi of pressure is a
// corner that has done more work than its neighbour.
export const SPREAD_WATCH_C = 10;
export const SPREAD_WATCH_KPA = 2 * KPA_PER_PSI;

export const defFor = (key) => HEALTH_DEFS.find((d) => d.key === key) ?? null;

// A lap's figure for one column: the stored scalar, or for the derived
// `boost` column the peak of the stored trace. null when the lap has neither.
export function lapValue(entry, key) {
  if (!entry) return null;
  const def = defFor(key);
  if (def?.derived) {
    const arr = entry[key];
    if (!Array.isArray(arr) || !arr.length) return null;
    let m = -Infinity;
    for (const v of arr) if (typeof v === "number" && v > m) m = v;
    return m === -Infinity ? null : m;
  }
  const v = entry[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// True when the lap carries at least one health figure. A session of
// hand-entered laps carries none, and the strip is then absent, not empty.
export function hasHealthData(entry) {
  return HEALTH_DEFS.some((d) => lapValue(entry, d.key) != null);
}

// The laps of a session with anything to show, as [{chIdx, entry}].
export function healthLaps(channels) {
  const out = [];
  (channels?.laps ?? []).forEach((entry, chIdx) => {
    if (hasHealthData(entry)) out.push({ chIdx, entry });
  });
  return out;
}

// One column across the session: [{chIdx, v}] for the laps that carry it,
// in lap order.
export function scalarSeries(channels, key) {
  const out = [];
  (channels?.laps ?? []).forEach((entry, chIdx) => {
    const v = lapValue(entry, key);
    if (v != null) out.push({ chIdx, v });
  });
  return out;
}

// Shading for one value: "due" past the `over` line, "low" past `watch`, "ok"
// inside, null when the column has no line. Both bounds are inclusive.
export function healthStatus(def, v) {
  if (!def || def.watch == null || v == null) return null;
  if (def.low) return v <= def.over ? "due" : v <= def.watch ? "low" : "ok";
  return v >= def.over ? "due" : v >= def.watch ? "low" : "ok";
}

// The session's figure for a column, by its own rule: the worst case across
// laps — the maximum for a peak or an end-of-lap reading, the minimum for a
// minimum. This is what the card shows and what the shading judges.
export function sessionExtreme(def, series) {
  if (!series.length) return null;
  let best = series[0];
  for (const s of series) {
    if (def.reduce === "min" ? s.v < best.v : s.v > best.v) best = s;
  }
  return best;
}

// The whole strip, reduced: one row per lap with its values, one series per
// column present, and per column the session's extreme with its status.
// null when no lap carries anything.
export function sessionHealth(channels) {
  const laps = healthLaps(channels);
  if (!laps.length) return null;
  const columns = [];
  for (const def of HEALTH_DEFS) {
    const series = scalarSeries(channels, def.key);
    if (!series.length) continue;
    const extreme = sessionExtreme(def, series);
    columns.push({
      key: def.key,
      series,
      extreme,
      status: healthStatus(def, extreme.v),
    });
  }
  const rows = laps.map(({ chIdx, entry }) => {
    const values = {};
    for (const c of columns) {
      const v = lapValue(entry, c.key);
      if (v != null) values[c.key] = v;
    }
    return { chIdx, values };
  });
  return { laps: rows, columns };
}

// Cross-corner spread for one lap and one kind of reading ("tyreC" or
// "tyreKpa"): left minus right on each axle, and front minus rear as the
// axle means. null unless all four corners are present — three corners and
// a guess is not a spread.
export function tyreSpread(entry, kind = "tyreC") {
  const c = {};
  for (const [corner] of TYRE_CORNERS) {
    const v = lapValue(entry, `${kind}${corner}`);
    if (v == null) return null;
    c[corner] = v;
  }
  return {
    front: c.LF - c.RF,
    rear: c.LR - c.RR,
    axle: (c.LF + c.RF) / 2 - (c.LR + c.RR) / 2,
  };
}

// The spread per lap across the session: [{chIdx, front, rear, axle}].
export function sessionSpread(channels, kind = "tyreC") {
  const out = [];
  (channels?.laps ?? []).forEach((entry, chIdx) => {
    const s = tyreSpread(entry, kind);
    if (s) out.push({ chIdx, ...s });
  });
  return out;
}

// Fuel burn from the per-lap fuel level: the median of the drops between
// consecutive fuel-carrying laps (an increase is a refuel or sensor slosh and
// is skipped), and the laps left at that rate. null below MIN_FUEL_DROPS
// drops — one drop is one lap's noise.
export function fuelBurn(channels) {
  const s = scalarSeries(channels, "fuelPct");
  const drops = [];
  for (let i = 1; i < s.length; i++) {
    const d = s[i - 1].v - s[i].v;
    if (d > 0) drops.push(d);
  }
  if (drops.length < MIN_FUEL_DROPS) return null;
  drops.sort((a, b) => a - b);
  const mid = drops.length >> 1;
  const perLapPct = drops.length % 2 ? drops[mid] : (drops[mid - 1] + drops[mid]) / 2;
  const lastPct = s[s.length - 1].v;
  return {
    perLapPct,
    lastPct,
    lapsRemaining: Math.floor(lastPct / perLapPct),
    drops: drops.length,
  };
}

// Hot tyre pressures for the session, per corner: the highest end-of-lap
// reading (the pressure the tyre reached) with the lap it came from, and the
// last lap's reading. kPa, as stored. null when no lap stored any corner.
export function hotPressures(channels) {
  const out = {};
  let any = false;
  for (const [corner] of TYRE_CORNERS) {
    const s = scalarSeries(channels, `tyreKpa${corner}`);
    if (!s.length) continue;
    any = true;
    const peak = sessionExtreme({ reduce: "max" }, s);
    out[corner] = { peakKpa: peak.v, peakChIdx: peak.chIdx, lastKpa: s[s.length - 1].v };
  }
  return any ? out : null;
}

// Round to the setup sheet's own step.
export const roundPsi = (psi) => Math.round(psi / PSI_STEP) * PSI_STEP;

// The one arithmetic the loop rests on: a tyre that grew from `cold` to `hot`
// gains the same amount next time, so to land on `target` hot, start from
// cold minus the overshoot. Rounded to the sheet's step. null unless all
// three are known.
export function suggestCold(coldPsi, hotPsi, targetPsi) {
  if (coldPsi == null || hotPsi == null || targetPsi == null) return null;
  const suggested = roundPsi(coldPsi - (hotPsi - targetPsi));
  return { coldPsi, hotPsi, targetPsi, suggestedPsi: suggested, deltaPsi: suggested - coldPsi };
}

// The pressure loop for one session: per corner, the sheet's cold, the
// import's hot (peak end-of-lap, in psi), the target, and the suggestion
// when all three exist. `sheet` is the day's setup sheet (or null),
// `targetPsi` the vehicle's target hot pressure (or null). null when the
// session stored no hot pressure at all — a session with nothing to close
// the loop on shows no loop.
export function pressureLoop(channels, sheet, targetPsi) {
  const hot = hotPressures(channels);
  if (!hot) return null;
  const rows = TYRE_CORNERS.map(([corner, key]) => {
    const h = hot[corner];
    const hotPsi = h ? kpaToPsi(h.peakKpa) : null;
    const coldPsi = sheet?.tp_cold?.[key] ?? null;
    return {
      corner,
      key,
      coldPsi,
      hotPsi,
      hotChIdx: h ? h.peakChIdx : null,
      targetPsi: targetPsi ?? null,
      suggestion: suggestCold(coldPsi, hotPsi, targetPsi ?? null),
    };
  });
  return {
    rows,
    // The sheet's tp_hot as the import measured it, rounded to the sheet's
    // step — what "record hot pressures on the sheet" writes.
    hotSheet: Object.fromEntries(rows.filter((r) => r.hotPsi != null).map((r) => [r.key, roundPsi(r.hotPsi)])),
    // The suggested cold pressures as a sheet group, when every corner has one.
    coldSheet: rows.every((r) => r.suggestion)
      ? Object.fromEntries(rows.map((r) => [r.key, r.suggestion.suggestedPsi]))
      : null,
  };
}

// --- units -----------------------------------------------------------------
// Two unit systems: "metric" is the stored one; "us" is what the web app
// shows, since the rest of the logbook is in °F, mph and psi.

const UNIT_SYSTEMS = {
  metric: {
    "°C": { unit: "°C", conv: (v) => v, dp: 0 },
    kPa: { unit: "kPa", conv: (v) => v, dp: 0 },
    "%": { unit: "%", conv: (v) => v, dp: 0 },
    V: { unit: "V", conv: (v) => v, dp: 1 },
  },
  us: {
    "°C": { unit: "°F", conv: cToF, dp: 0 },
    kPa: { unit: "psi", conv: kpaToPsi, dp: 1 },
    "%": { unit: "%", conv: (v) => v, dp: 0 },
    V: { unit: "V", conv: (v) => v, dp: 1 },
  },
};

const unitSpec = (def, units) => UNIT_SYSTEMS[units]?.[def.unit] ?? UNIT_SYSTEMS.metric[def.unit];

// A stored value in the given unit system: { value, unit, dp, text }.
export function displayValue(def, v, units = "metric") {
  const u = unitSpec(def, units);
  const value = u.conv(v);
  return { value, unit: u.unit, dp: u.dp, text: `${value.toFixed(u.dp)} ${u.unit}` };
}

// A delta (spread) in the given unit system, signed. Temperature deltas
// scale but don't offset.
export function displayDelta(def, d, units = "metric") {
  const u = unitSpec(def, units);
  const value = def.unit === "°C" ? d * (units === "us" ? 1.8 : 1) : u.conv(d);
  const dp = def.unit === "°C" ? 0 : u.dp;
  return { value, unit: u.unit, text: `${value > 0 ? "+" : ""}${value.toFixed(dp)} ${u.unit}` };
}

// The stats-line sentence: every column past its watch line, worst first,
// plus the fuel outlook when there is one. Factual, no scolding. null when
// nothing is past a line and there is no fuel figure.
export function healthSummary(channels, units = "metric") {
  const sh = sessionHealth(channels);
  if (!sh) return null;
  const parts = [];
  const flagged = sh.columns.filter((c) => c.status === "due" || c.status === "low");
  flagged.sort((a, b) => (a.status === b.status ? 0 : a.status === "due" ? -1 : 1));
  for (const c of flagged) {
    const def = defFor(c.key);
    parts.push(`${def.label.toLowerCase()} ${displayValue(def, c.extreme.v, units).text}`);
  }
  const fuel = fuelBurn(channels);
  if (fuel) parts.push(`≈${fuel.lapsRemaining} lap${fuel.lapsRemaining === 1 ? "" : "s"} of fuel at this rate`);
  if (!parts.length) return null;
  return `car: ${parts.join(", ")}`;
}

// --- web rendering (not ported) --------------------------------------------

const STATUS_WORD = { ok: "", low: "watch", due: "over the line" };
const ruleWord = (def) => (def.reduce === "max" ? "peak" : def.reduce === "min" ? "min" : "at lap end");

// One column as a sparkline across the session's health laps: x is the lap's
// position among them (so every card lines up), the threshold bands shaded
// behind the line, and the highlighted laps marked in their slot colours.
// Exported for unit tests.
export function sparklineSvg(def, series, lapOrder, lit, units, { width = 160, height = 44 } = {}) {
  if (!series.length) return "";
  const pad = { l: 4, r: 4, t: 6, b: 6 };
  const n = Math.max(2, lapOrder.length);
  const xOf = new Map(lapOrder.map((chIdx, i) => [chIdx, i]));
  let y0 = Infinity, y1 = -Infinity;
  for (const s of series) {
    if (s.v < y0) y0 = s.v;
    if (s.v > y1) y1 = s.v;
  }
  // Bring the lines into view when the data sits near them, so the shading
  // says how close the session came rather than only whether it crossed.
  if (def.watch != null) {
    const near = def.low ? def.watch * 1.05 : def.watch * 0.95;
    if (def.low ? y0 < near : y1 > near) {
      y0 = Math.min(y0, def.over);
      y1 = Math.max(y1, def.over);
    }
  }
  const ypad = Math.max((y1 - y0) * 0.15, 1e-6);
  y0 -= ypad;
  y1 += ypad;
  const X = (i) => pad.l + (i / (n - 1)) * (width - pad.l - pad.r);
  const Y = (v) => pad.t + ((y1 - v) / (y1 - y0)) * (height - pad.t - pad.b);
  const clampY = (v) => Math.max(pad.t, Math.min(height - pad.b, Y(v)));

  let bands = "";
  if (def.watch != null) {
    // Past `over`: the danger tint. Between `watch` and `over`: a lighter one.
    const overFrom = def.low ? y0 : def.over, overTo = def.low ? def.over : y1;
    const watchFrom = def.low ? def.over : def.watch, watchTo = def.low ? def.watch : def.over;
    const band = (from, to, op) => {
      const ya = clampY(to), yb = clampY(from);
      return yb - ya > 0.5
        ? `<rect x="${pad.l}" y="${ya.toFixed(1)}" width="${width - pad.l - pad.r}" height="${(yb - ya).toFixed(1)}" fill="var(--danger)" fill-opacity="${op}"/>`
        : "";
    };
    bands += band(overFrom, overTo, 0.22) + band(watchFrom, watchTo, 0.1);
  }

  const path = series
    .map((s, i) => `${i ? "L" : "M"}${X(xOf.get(s.chIdx) ?? 0).toFixed(1)},${Y(s.v).toFixed(1)}`)
    .join(" ");
  let dots = "";
  for (const s of series) {
    const color = lit.get(s.chIdx);
    if (!color) continue;
    dots += `<circle cx="${X(xOf.get(s.chIdx) ?? 0).toFixed(1)}" cy="${Y(s.v).toFixed(1)}" r="3" fill="${color}"/>`;
  }
  const first = displayValue(def, series[0].v, units).text;
  const last = displayValue(def, series[series.length - 1].v, units).text;
  return `<svg class="health-spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(def.label)} by lap, ${esc(first)} on the first lap to ${esc(last)} on the last">
    ${bands}<path d="${path}" fill="none" stroke="var(--text-muted)" stroke-width="1.5" stroke-linejoin="round"/>${dots}
  </svg>`;
}

// The small multiples: a card per column present, grouped, each with the
// session's figure by its rule, its sparkline and its status shading.
export function healthCardsHtml(channels, lit, units = "us") {
  const sh = sessionHealth(channels);
  if (!sh) return "";
  const lapOrder = sh.laps.map((l) => l.chIdx);
  const groups = HEALTH_GROUPS.map(([g, label]) => {
    const cols = sh.columns.filter((c) => defFor(c.key).group === g);
    if (!cols.length) return "";
    const cards = cols
      .map((c) => {
        const def = defFor(c.key);
        const dv = displayValue(def, c.extreme.v, units);
        const status = c.status ?? "";
        return `<div class="health-card${status ? ` hs-${status}` : ""}" data-health-key="${def.key}">
          <div class="hc-label">${esc(def.label)} <span class="hc-rule">${ruleWord(def)}</span></div>
          <div class="hc-value">${esc(dv.text)}${
            status && STATUS_WORD[status] ? ` <span class="hc-status">${STATUS_WORD[status]}</span>` : ""
          }</div>
          ${sparklineSvg(def, c.series, lapOrder, lit, units)}
        </div>`;
      })
      .join("");
    return `<div class="health-group"><div class="sec-head">${esc(label)}</div><div class="health-cards">${cards}</div></div>`;
  });
  return groups.join("");
}

// The per-lap table: one row per lap with a figure, one column per figure
// present, headers grouped, cells shaded by status. The highlighted laps
// carry their slot dot so the rows read against the charts on other tabs.
export function healthTableHtml(channels, lit, labelFor, units = "us") {
  const sh = sessionHealth(channels);
  if (!sh) return "";
  const groupHeads = HEALTH_GROUPS.map(([g, label]) => {
    const n = sh.columns.filter((c) => defFor(c.key).group === g).length;
    return n ? `<th colspan="${n}" class="hg-head">${esc(label)}</th>` : "";
  }).join("");
  const colHeads = sh.columns
    .map((c) => {
      const def = defFor(c.key);
      const unit = displayValue(def, 0, units).unit;
      return `<th class="num">${esc(def.label)}<small class="hc-rule"> ${esc(unit)}</small></th>`;
    })
    .join("");
  const body = sh.laps
    .map((row) => {
      const color = lit.get(row.chIdx);
      const cells = sh.columns
        .map((c) => {
          const v = row.values[c.key];
          if (v == null) return `<td class="num hs-none">—</td>`;
          const def = defFor(c.key);
          const status = healthStatus(def, v);
          const dv = displayValue(def, v, units);
          return `<td class="num${status && status !== "ok" ? ` hs-${status}` : ""}">${dv.value.toFixed(dv.dp)}</td>`;
        })
        .join("");
      return `<tr><td>${color ? `<span class="dot" style="background:${color}"></span> ` : ""}${esc(labelFor(row.chIdx))}</td>${cells}</tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table class="health-table">
    <thead><tr><th></th>${groupHeads}</tr><tr><th>Lap</th>${colHeads}</tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

// Cross-corner spread per lap for temperatures and pressures, when all four
// corners exist; positive is left or front hotter / higher.
export function tyreSpreadHtml(channels, lit, labelFor, units = "us") {
  const kinds = [
    ["tyreC", "Tyre temperature spread", defFor("tyreCLF")],
    ["tyreKpa", "Tyre pressure spread", defFor("tyreKpaLF")],
  ]
    .map(([kind, label, def]) => ({ kind, label, def, rows: sessionSpread(channels, kind) }))
    .filter((k) => k.rows.length);
  if (!kinds.length) return "";
  // A spread worth a second look, in stored units: 10 °C across an axle or
  // between axles, or 2 psi of pressure.
  const cell = (def, d) => {
    const watch = Math.abs(d) >= (def.unit === "°C" ? SPREAD_WATCH_C : SPREAD_WATCH_KPA);
    return `<td class="num${watch ? " hs-low" : ""}">${esc(displayDelta(def, d, units).text)}</td>`;
  };
  return kinds
    .map(
      ({ label, def, rows }) => `<div class="health-spread">
      <div class="sec-head">${esc(label)} <span class="hint">— left minus right on each axle, and front minus rear; positive is left / front ${def.unit === "°C" ? "hotter" : "higher"}. The left-right numbers are camber evidence, front-rear is balance.</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Lap</th><th class="num">LF − RF</th><th class="num">LR − RR</th><th class="num">Front − rear</th></tr></thead>
        <tbody>${rows
          .map((r) => {
            const color = lit.get(r.chIdx);
            return `<tr><td>${color ? `<span class="dot" style="background:${color}"></span> ` : ""}${esc(labelFor(r.chIdx))}</td>${cell(def, r.front)}${cell(def, r.rear)}${cell(def, r.axle)}</tr>`;
          })
          .join("")}</tbody>
      </table></div>
    </div>`
    )
    .join("");
}

// The fuel line: burn per lap and laps left at that rate.
export function fuelHtml(channels) {
  const f = fuelBurn(channels);
  if (!f) return "";
  return `<div class="health-fuel">Fuel: ≈${f.perLapPct.toFixed(1)} % per lap over ${f.drops + 1} laps, ${f.lastPct.toFixed(0)} % left — <b>≈${f.lapsRemaining} lap${
    f.lapsRemaining === 1 ? "" : "s"
  }</b> at this rate.</div>`;
}

// The pressure-loop card. `ctx`:
//   loop      — pressureLoop(...) for the chosen sheet, or null
//   day       — the sheet's day; days — the days the event has sheets/slots for
//   sheet     — the day's sheet (or null), so "record" can say it is already there
//   vehicle   — { id, name, target_hot_psi } or null when the event isn't linked
//   nextDay   — the day the suggestion can start a sheet for, or null
//   nextHasSheet — whether that day already has a sheet
//   noteLine  — the "next time" line that would be recorded on the sheet
// The buttons carry data attributes; app.js wires them by delegation.
export function pressureLoopHtml(ctx, labelFor) {
  const { loop, day, days, sheet, vehicle, nextDay, nextHasSheet, noteLine } = ctx;
  if (!loop) return "";
  const rows = loop.rows
    .map((r) => {
      const s = r.suggestion;
      return `<tr>
        <td>${esc(r.corner)}</td>
        <td class="num">${r.coldPsi != null ? r.coldPsi.toFixed(1) : `<span class="hs-none">—</span>`}</td>
        <td class="num">${r.hotPsi != null ? `${r.hotPsi.toFixed(1)}${r.hotChIdx != null ? ` <small class="hc-rule">${esc(labelFor(r.hotChIdx))}</small>` : ""}` : "—"}</td>
        <td class="num">${r.targetPsi != null ? r.targetPsi.toFixed(1) : `<span class="hs-none">—</span>`}</td>
        <td class="num${s ? (s.deltaPsi === 0 ? " hs-ok" : " hs-suggest") : ""}">${
          s ? `<b>${s.suggestedPsi.toFixed(1)}</b> <small class="hc-rule">${s.deltaPsi === 0 ? "on target" : `${s.deltaPsi > 0 ? "+" : ""}${s.deltaPsi.toFixed(1)}`}</small>` : "—"
        }</td>
      </tr>`;
    })
    .join("");
  const daySel =
    days.length > 1
      ? `<label class="health-day">Sheet <select data-health-day>${days
          .map((d) => `<option value="${d}"${d === day ? " selected" : ""}>day ${d}</option>`)
          .join("")}</select></label>`
      : "";
  const missing = [];
  if (!loop.rows.some((r) => r.coldPsi != null))
    missing.push(
      sheet
        ? `The day ${day} sheet has no cold pressures — add them and the suggestion appears here.`
        : `No day ${day} setup sheet yet — log one with the cold pressures you set and the suggestion appears here.`
    );
  if (!vehicle)
    missing.push("Set this event's Car to one of your garage vehicles to give it a target hot pressure.");
  else if (vehicle.target_hot_psi == null)
    missing.push("Set a target hot pressure for this car (below) and the suggestion appears here.");
  const targetForm = vehicle
    ? `<form class="health-target" data-health-target="${vehicle.id}">
        <label>Target hot pressure for ${esc(vehicle.name)}
          <input name="target" type="number" step="0.5" min="10" max="60" inputmode="decimal" value="${
            vehicle.target_hot_psi ?? ""
          }" placeholder="32"> psi</label>
        <button class="btn small" type="submit">Save target</button>
      </form>`
    : "";
  const sameHot =
    sheet?.tp_hot && Object.entries(loop.hotSheet).every(([k, v]) => sheet.tp_hot[k] === v);
  const noteRecorded = noteLine && sheet?.notes?.includes(noteLine);
  const actions = [];
  if (Object.keys(loop.hotSheet).length && !(sameHot && (!noteLine || noteRecorded)))
    actions.push(
      `<button class="btn small" type="button" data-health-record="${day}">${
        sheet ? `Record on the day ${day} sheet` : `Start the day ${day} sheet with these`
      }</button>`
    );
  if (loop.coldSheet && nextDay != null)
    actions.push(
      `<button class="btn small primary" type="button" data-health-next="${nextDay}">${
        nextHasSheet ? `Apply to the day ${nextDay} sheet` : `Start the day ${nextDay} sheet from these`
      }</button>`
    );
  const actionHint = Object.keys(loop.hotSheet).length
    ? sameHot && (!noteLine || noteRecorded)
      ? `<span class="hint">Recorded on the day ${day} sheet.</span>`
      : `<span class="hint">Recording writes the hot pressures to the sheet${
          noteLine ? " and a note with the suggested colds, which copies forward to your next sheet" : ""
        }.</span>`
    : "";
  return `<div class="health-loop">
    <div class="sec-head">Tyre pressures vs your setup sheet ${daySel}<span class="hint">— cold from the sheet, hot from the import (the highest end-of-lap reading), and the cold pressure to start from next time to land on target.</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th></th><th class="num">Cold (sheet)</th><th class="num">Hot (import)</th><th class="num">Target hot</th><th class="num">Next cold</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${missing.length ? `<div class="hint">${missing.map(esc).join(" ")}</div>` : ""}
    ${targetForm}
    ${actions.length || actionHint ? `<div class="btn-row health-actions">${actions.join("")}${actionHint}</div>` : ""}
  </div>`;
}

// The "next time" note the record action appends to the sheet, so the
// suggestion rides the copy-forward prefill into the next event's form.
export function nextTimeNote(loop) {
  if (!loop?.coldSheet) return null;
  const cold = TYRE_CORNERS.map(([c, k]) => `${c} ${loop.coldSheet[k].toFixed(1)}`).join(" / ");
  const target = loop.rows.find((r) => r.targetPsi != null)?.targetPsi;
  return `Next time cold: ${cold} psi (hots ran ${TYRE_CORNERS.map(([c, k]) =>
    loop.hotSheet[k] != null ? loop.hotSheet[k].toFixed(1) : "—"
  ).join(" / ")} vs ${target != null ? target.toFixed(1) : "—"} target)`;
}

// The whole Car tab: the cards, the fuel line, the spread tables, the loop
// card (when the caller has one — it is web-only and needs the event's
// sheets) and the per-lap table. Returns "" when the session stored no
// health figure at all, so the tab is only offered with something on it.
export function healthHtml(channels, lit, labelFor, { units = "us", loopHtml = "" } = {}) {
  const cards = healthCardsHtml(channels, lit, units);
  if (!cards) return "";
  return `<div class="ch-health">
    <div class="sec-head">Car health <span class="hint">— the slow readings, one figure per lap by each one's own rule: a peak, a minimum, or the value as the lap ended. Shaded where a figure approaches or passes a line worth watching.</span></div>
    ${cards}
    ${fuelHtml(channels)}
    ${tyreSpreadHtml(channels, lit, labelFor, units)}
    ${loopHtml}
    ${healthTableHtml(channels, lit, labelFor, units)}
  </div>`;
}
