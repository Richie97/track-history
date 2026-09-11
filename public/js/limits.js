// Where the car is at its limit (issue #188): the pure half.
//
// Two of a PDR import's stored channels (js/import/channels.js) answer a
// question that is spatial rather than temporal. `wheelSlip` is
// (driven − non-driven) wheelspeed as a percent — positive under wheelspin,
// negative under lockup — and `flags` packs ABS (bit 0), traction control
// (bit 1) and stability control (bit 2), OR-ed across each 20 m grid window
// so a half-second ABS event isn't missed between samples. Nobody wants a
// line chart of either; what a driver wants is *where* the car let go, which
// is a handful of specific places on the track — so this module reduces both
// channels to runs of grid points per kind, and places those runs on the
// stored best-lap trace by matching driven distance.
//
// Colour is by kind, not severity: a corner where traction control cuts is a
// throttle problem, one where ABS cuts is a braking problem, and the driver
// needs to know which. And the read-out reports rather than scolds — "ABS
// active" is a fact; "you're braking too hard" is a guess. A session whose
// systems never fired says "no interventions": TC/VSC read zero all day with
// the systems switched off, which is normal on track, and "off" and "never
// needed" are indistinguishable.
//
// Pinned for the native ports by contracts/logic/limits.json, generated from
// this file — a port asserts against this output, never against another port.

// Thresholds are display semantics, not physics, beside FULL_THROTTLE_PCT /
// BRAKING_PCT in compare-laps.js in spirit: slip above this is wheelspin,
// below the negative one is lockup. Tune against real footage.
export const WHEELSPIN_PCT = 2;
export const LOCKUP_PCT = -2;

export const FLAG_ABS = 1;
export const FLAG_TC = 2;
export const FLAG_VSC = 4;

// Runs of one kind separated by at most this many clear grid points are one
// place — an ABS pulse train across a braking zone is one braking zone, not
// four. 2 points = 40 m at the 20 m grid.
export const MERGE_GAP_POINTS = 2;

// The kinds, in render and report order. `side` is the colour: braking-side
// events (ABS, lockup) share one hue, power-side (traction control, wheelspin)
// another, stability its own — and shape + fill carry identity beside the
// colour so the two events of one side are never colour-alone. `channel` is
// the chart whose trace the kind's bands shade.
export const LIMIT_KINDS = [
  { key: "abs", label: "ABS", side: "brake", shape: "circle", filled: true, channel: "brake" },
  { key: "lockup", label: "Lockup", side: "brake", shape: "circle", filled: false, channel: "brake" },
  { key: "tc", label: "Traction control", side: "power", shape: "triangle", filled: true, channel: "throttle" },
  { key: "wheelspin", label: "Wheelspin", side: "power", shape: "triangle", filled: false, channel: "throttle" },
  { key: "vsc", label: "Stability control", side: "stability", shape: "diamond", filled: true, channel: "steering" },
];

export const kindDef = (key) => LIMIT_KINDS.find((k) => k.key === key);

// True when the lap stored something this module can read.
export function hasLimitData(entry) {
  return Array.isArray(entry?.flags) || Array.isArray(entry?.wheelSlip);
}

// Whether `kind` is active at grid point k of a lap; null when the lap
// doesn't carry the channel the kind reads.
export function limitAt(entry, kind, k) {
  switch (kind) {
    case "abs":
    case "tc":
    case "vsc": {
      const f = entry?.flags;
      if (!Array.isArray(f) || k >= f.length) return null;
      const bit = kind === "abs" ? FLAG_ABS : kind === "tc" ? FLAG_TC : FLAG_VSC;
      return (f[k] & bit) !== 0;
    }
    case "wheelspin":
    case "lockup": {
      const s = entry?.wheelSlip;
      if (!Array.isArray(s) || k >= s.length) return null;
      return kind === "wheelspin" ? s[k] > WHEELSPIN_PCT : s[k] < LOCKUP_PCT;
    }
    default:
      return null;
  }
}

// Runs of true in a boolean series, merged across gaps of at most `mergeGap`
// false points: [{k0, k1}] inclusive.
export function booleanRuns(series, mergeGap = MERGE_GAP_POINTS) {
  const out = [];
  let k0 = -1;
  for (let k = 0; k <= series.length; k++) {
    const on = k < series.length && series[k] === true;
    if (on) {
      if (k0 < 0) k0 = k;
    } else if (k0 >= 0) {
      // Merge with the previous run when the gap between them is short.
      const prev = out[out.length - 1];
      if (prev && k0 - prev.k1 - 1 <= mergeGap) prev.k1 = k - 1;
      else out.push({ k0, k1: k - 1 });
      k0 = -1;
    }
  }
  return out;
}

// Every limit event in one stored lap: [{kind, k0, k1}] in LIMIT_KINDS
// order, then by distance. Kinds whose channel the lap lacks contribute
// nothing.
export function limitRuns(entry, mergeGap = MERGE_GAP_POINTS) {
  const out = [];
  for (const { key } of LIMIT_KINDS) {
    const n = key === "wheelspin" || key === "lockup" ? entry?.wheelSlip?.length : entry?.flags?.length;
    if (!n) continue;
    const series = Array.from({ length: n }, (_, k) => limitAt(entry, key, k) === true);
    for (const run of booleanRuns(series, mergeGap)) out.push({ kind: key, ...run });
  }
  return out;
}

// The kinds active at grid point k of a lap, as labels — the tooltip suffix.
export function activeLimitLabels(entry, k) {
  return LIMIT_KINDS.filter((d) => limitAt(entry, d.key, k) === true).map((d) => d.label);
}

// A session's limit events reduced per kind: { kinds: [{kind, places, laps}]
// in LIMIT_KINDS order for every kind the session could read, hasFlags,
// hasSlip }. `places` is the number of distinct stretches of track where
// *any* lap hit that kind (the union across laps, merged like a single lap's
// runs), `laps` how many laps did. null when no lap stored flags or slip.
export function sessionLimits(channels, mergeGap = MERGE_GAP_POINTS) {
  const laps = (channels?.laps ?? []).filter(hasLimitData);
  if (!laps.length) return null;
  const hasFlags = laps.some((l) => Array.isArray(l.flags));
  const hasSlip = laps.some((l) => Array.isArray(l.wheelSlip));
  const kinds = [];
  for (const { key } of LIMIT_KINDS) {
    const readable = key === "wheelspin" || key === "lockup" ? hasSlip : hasFlags;
    if (!readable) continue;
    const n = Math.max(...laps.map((l) => (key === "wheelspin" || key === "lockup" ? l.wheelSlip?.length : l.flags?.length) ?? 0));
    const union = new Array(n).fill(false);
    let lapCount = 0;
    for (const l of laps) {
      let hit = false;
      for (let k = 0; k < n; k++) {
        if (limitAt(l, key, k) === true) {
          union[k] = true;
          hit = true;
        }
      }
      if (hit) lapCount++;
    }
    kinds.push({ kind: key, places: booleanRuns(union, mergeGap).length, laps: lapCount });
  }
  return { kinds, hasFlags, hasSlip };
}

// One line for the session stats: "ABS in 3 places, wheelspin in 2" — or
// "no interventions" when the systems never fired and the wheels never
// slipped. null when the session stored neither channel.
export function limitSummary(channels) {
  const sl = sessionLimits(channels);
  if (!sl) return null;
  const parts = sl.kinds
    .filter((k) => k.places > 0)
    .map((k) => `${sentenceLabel(k.kind)} in ${k.places} place${k.places === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "no interventions";
}

// A kind's label as it reads mid-sentence: acronyms keep their case.
const sentenceLabel = (kind) => {
  const l = kindDef(kind).label;
  return l === l.toUpperCase() ? l : l.toLowerCase();
};

// Place one lap's limit runs on a stored trace ([[x, y, v], …] — the best
// lap's racing line, time-sampled) by driven distance: each run's mid-point
// is taken as a fraction of the lap's grid length and looked up along the
// trace's cumulative length. Returns [{kind, k0, k1, idx}] with idx the trace
// point index, or [] without a usable trace. The trace is the best lap only,
// so callers pass the best lap's channel entry — matching another lap's runs
// onto it would put marks where that lap never was.
export function limitMarkers(entry, dStepM, trace) {
  if (!Array.isArray(trace) || trace.length < 2) return [];
  const runs = limitRuns(entry);
  if (!runs.length) return [];
  const n = Math.max(entry.speed?.length ?? 0, entry.flags?.length ?? 0, entry.wheelSlip?.length ?? 0);
  const lapLen = (n - 1) * dStepM;
  if (!(lapLen > 0)) return [];
  const cum = new Array(trace.length);
  cum[0] = 0;
  for (let i = 1; i < trace.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(trace[i][0] - trace[i - 1][0], trace[i][1] - trace[i - 1][1]);
  }
  const total = cum[trace.length - 1];
  if (!(total > 0)) return [];
  return runs.map((r) => {
    const target = Math.min(1, (((r.k0 + r.k1) / 2) * dStepM) / lapLen) * total;
    let idx = 0;
    while (idx < trace.length - 1 && cum[idx] < target) idx++;
    return { kind: r.kind, k0: r.k0, k1: r.k1, idx };
  });
}

// --- web rendering (not ported) --------------------------------------------

// The colour a side draws in — CSS tokens, so the map (canvas) and the
// charts (SVG) read the same value and theme flips repaint both.
export const sideColorVar = (side) => (side === "stability" ? "--text-strong" : `--limit-${side}`);

// A kind's marker as an inline SVG glyph for legends: the same shape and
// fill rule the track map draws, on a 12 px box.
export function limitGlyphSvg(kind) {
  const d = typeof kind === "string" ? kindDef(kind) : kind;
  if (!d) return "";
  const color = `var(${sideColorVar(d.side)})`;
  const fill = d.filled ? color : "var(--surface-card)";
  const shape =
    d.shape === "circle"
      ? `<circle cx="6" cy="6" r="4.5"/>`
      : d.shape === "triangle"
        ? `<path d="M6 1.5 L10.8 10.5 L1.2 10.5 Z"/>`
        : `<path d="M6 1 L11 6 L6 11 L1 6 Z"/>`;
  return `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" fill="${fill}" stroke="${color}" stroke-width="1.8">${shape}</svg>`;
}
