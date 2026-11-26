// Corner segmentation (issue #189): the pure half, and nothing else.
//
// Sector splits (js/sectors.js) cut a lap by *distance* — three equal slices
// of the driven length — which is the right cut for "where did the time go"
// and the wrong one for "what was the car doing in the corner": a sector
// boundary lands mid-corner as often as not. This module cuts by *lateral
// load* instead: a corner is a stretch of grid points where the stored |latG|
// stays at or above CORNER_MIN_G *in one direction*, merged across a short dip
// (a double apex is one corner, not two) and dropped when too short to be
// anything but a kerb strike. It is the primitive the balance read-out
// (js/balance.js) hangs off, and is its own module because anything
// per-corner (entry speed, minimum speed, brake release point) segments this
// way.
//
// Direction is the point. latG is stored as a magnitude, and through a
// left-right transition a magnitude dips for a grid point or two and comes
// straight back — so read alone it fuses linked corners: at VIR the whole
// Climbing Esses were one "corner", Roller Coaster through Hog Pen another,
// nine in a lap of eighteen. The sign comes from a channel that has one — yaw,
// else steering (lateralSigns) — and a change of direction always ends a
// corner, whatever the gap. A lap with neither channel (a GPS-only import)
// has no direction to read and segments by magnitude alone, as every lap did
// before.
//
// Corners are numbered from the start/finish line in distance order and
// labelled T1…Tn. Those are the app's numbers at this threshold, not the
// circuit's official turn numbers: a fast kink may or may not clear
// CORNER_MIN_G, two apexes in the same direction count once, and a bend the
// start/finish line cuts through is counted on both sides of it. The label
// says as much wherever it is shown.
//
// `sessionCorners` segments every lap together on the shared distance grid
// rather than any one lap's, so the corner list is one list for the session —
// the same T4 on every lap, whichever laps are highlighted — and a lap that
// took a corner a little wider still lands in the same window. A grid point is
// cornering when *any* lap is loaded there, in the direction most of the
// loaded laps agree on. The grid is what makes that legitimate: laps are
// aligned by driven distance from the start/finish line
// (js/import/channels.js), so the same k is the same place on track to within
// the line taken.

// Sustained |latG| above this is a corner. Display semantics, not physics —
// like WHEELSPIN_PCT in limits.js and MIN_LOAD_G in grip.js, tune against
// real footage. 0.35 G is well above the noise on a straight and well below
// the lightest real corner on a road-tyred car.
export const CORNER_MIN_G = 0.35;

// Two cornering runs *in the same direction* separated by at most this many
// below-threshold grid points are one corner: a double apex, not two corners.
// 2 points = 40 m at the 20 m grid.
export const CORNER_MERGE_GAP_POINTS = 2;

// A run shorter than this is a kerb strike or a bump, not a corner.
// 3 points = 60 m at the 20 m grid.
export const MIN_CORNER_POINTS = 3;

// True when the lap stored the channel this module reads.
export function hasCornerData(entry) {
  return Array.isArray(entry?.latG);
}

// Which way the car is turning at each grid point of one lap: [1 | -1], from
// yaw, else steering; null when the lap stored neither. Which of the two is
// "left" is the recorder's business and nothing here depends on it — only on
// the sign changing when the direction does.
export function lateralSigns(entry) {
  if (!hasCornerData(entry)) return null;
  const src = Array.isArray(entry.yaw) ? entry.yaw : Array.isArray(entry.steering) ? entry.steering : null;
  if (!src) return null;
  return entry.latG.map((_, k) => (src[k] < 0 ? -1 : 1));
}

// The cornering direction at each grid point: 0 below `minG`, else the sign
// from `signs` — or 1 throughout without it, which is the magnitude-only
// reading. A magnitude stored with a sign is still a magnitude — pdr.js
// stores abs(lateral acceleration), so latG's own sign is never a direction.
export function cornerDirs(latG, signs = null, minG = CORNER_MIN_G) {
  if (!Array.isArray(latG)) return [];
  return latG.map((g, k) => (Math.abs(g) >= minG ? (signs?.[k] ?? 1) : 0));
}

// Directions reduced to corners: [{k0, k1}] inclusive. A run is a stretch of
// one non-zero direction; two runs merge across a gap of at most `mergeGap`
// clear points only when they turn the same way, and runs shorter than
// `minPoints` are dropped.
export function cornersFromDirs(dirs, { mergeGap = CORNER_MERGE_GAP_POINTS, minPoints = MIN_CORNER_POINTS } = {}) {
  const runs = [];
  for (let k = 0; k < dirs.length; k++) {
    const dir = dirs[k];
    if (!dir) continue;
    // `prev` is the last run of either direction, so an opposite run in
    // between has already taken its place and nothing merges across it.
    const prev = runs[runs.length - 1];
    if (prev && prev.dir === dir && k - prev.k1 - 1 <= mergeGap) prev.k1 = k;
    else runs.push({ dir, k0: k, k1: k });
  }
  return runs.filter((r) => r.k1 - r.k0 + 1 >= minPoints).map(({ k0, k1 }) => ({ k0, k1 }));
}

// One lap's corners, numbered from the start/finish line: [{n, k0, k1, peakG,
// peakK}] with peakG the lap's highest |latG| in the window and peakK where.
// [] without a latG channel.
export function lapCorners(entry, opts = {}) {
  if (!hasCornerData(entry)) return [];
  const { minG = CORNER_MIN_G } = opts;
  return cornersFromDirs(cornerDirs(entry.latG, lateralSigns(entry), minG), opts).map((r, i) => ({ n: i + 1, ...r, ...peakIn(entry.latG, r) }));
}

function peakIn(latG, { k0, k1 }) {
  let peakG = 0, peakK = k0;
  for (let k = k0; k <= k1 && k < latG.length; k++) {
    const g = Math.abs(latG[k]);
    if (g > peakG) {
      peakG = g;
      peakK = k;
    }
  }
  return { peakG, peakK };
}

// Every lap's cornering directions in one convention: [[0 | 1 | -1]] per lap.
// Two laps of one session share a recorder, but a comparison can put laps from
// two recorders on one grid and their yaw need not agree on which way is
// positive — so each lap is checked against the first wherever both are
// loaded, and flipped when it disagrees more than it agrees. Measured, not
// assumed, as balance.js does for steering against yaw. When any lap has no
// direction at all, none is used: half a session cut by direction and half
// not would be two corner lists laid over each other.
export function sessionDirs(laps, minG = CORNER_MIN_G) {
  const signs = laps.map(lateralSigns);
  if (signs.some((s) => !s)) return laps.map((l) => cornerDirs(l.latG, null, minG));
  const dirs = laps.map((l, i) => cornerDirs(l.latG, signs[i], minG));
  const ref = dirs[0];
  return dirs.map((d, i) => {
    if (!i) return d;
    let agree = 0;
    for (let k = 0; k < d.length && k < ref.length; k++) agree += d[k] * ref[k];
    return agree < 0 ? d.map((v) => (v ? -v : 0)) : d;
  });
}

// The session's corners on the shared grid: [{n, k0, k1, peakG, peakK, laps}]
// from every lap's directions together — a point is cornering when any lap is
// loaded there, in the direction more of the loaded laps turn (on a tie, the
// earliest loaded lap's) — with `peakG` the highest |latG| any lap saw in the
// window and `laps` how many laps were loaded in that direction somewhere
// inside it. [] when no lap stored latG.
export function sessionCorners(channels, opts = {}) {
  const laps = (channels?.laps ?? []).filter(hasCornerData);
  if (!laps.length) return [];
  const { minG = CORNER_MIN_G } = opts;
  const n = Math.max(...laps.map((l) => l.latG.length));
  const dirs = sessionDirs(laps, minG);
  const voted = new Array(n).fill(0);
  for (let k = 0; k < n; k++) {
    let sum = 0, first = 0;
    for (const d of dirs) {
      const v = d[k] ?? 0;
      sum += v;
      if (!first) first = v;
    }
    voted[k] = sum > 0 ? 1 : sum < 0 ? -1 : first;
  }
  return cornersFromDirs(voted, opts).map((r, i) => {
    const dir = voted[r.k0];
    let peakG = 0, peakK = r.k0, count = 0;
    laps.forEach((l, li) => {
      const p = peakIn(l.latG, r);
      if (p.peakG > peakG) {
        peakG = p.peakG;
        peakK = p.peakK;
      }
      const d = dirs[li];
      for (let k = r.k0; k <= r.k1; k++) {
        if (d[k] === dir) {
          count++;
          break;
        }
      }
    });
    return { n: i + 1, k0: r.k0, k1: r.k1, peakG, peakK, laps: count };
  });
}

// The corner containing grid point k, or null on a straight.
export function cornerAt(corners, k) {
  return corners.find((c) => k >= c.k0 && k <= c.k1) ?? null;
}

// The label a corner is shown under. The app's numbering, not the circuit's —
// see the header.
export const cornerLabel = (c) => `T${c.n}`;
