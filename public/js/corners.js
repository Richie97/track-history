// Corner segmentation (issue #189): the pure half, and nothing else.
//
// Sector splits (js/sectors.js) cut a lap by *distance* — three equal slices
// of the driven length — which is the right cut for "where did the time go"
// and the wrong one for "what was the car doing in the corner": a sector
// boundary lands mid-corner as often as not. This module cuts by *lateral
// load* instead: a corner is a stretch of grid points where the stored |latG|
// stays above CORNER_MIN_G, merged across a short dip (a chicane's flick
// between two apexes is one corner, not two) and dropped when too short to be
// anything but a kerb strike. It is the primitive the balance read-out
// (js/balance.js) hangs off, and is its own module because the ticket is
// right that it is reusable — anything per-corner (entry speed, minimum
// speed, brake release point) segments this way.
//
// Corners are numbered from the start/finish line in distance order and
// labelled T1…Tn. Those are the app's numbers at this threshold, not the
// circuit's official turn numbers: a fast kink may or may not clear
// CORNER_MIN_G, and a double-apex may count once or twice. The label says
// as much wherever it is shown.
//
// `sessionCorners` segments the *union* of every lap's cornering mask on the
// shared distance grid rather than any one lap's, so the corner list is one
// list for the session — the same T4 on every lap, whichever laps are
// highlighted — and a lap that took a corner a little wider still lands in
// the same window. The grid is what makes that legitimate: laps are aligned
// by driven distance from the start/finish line (js/import/channels.js), so
// the same k is the same place on track to within the line taken.
//
// Web-first (see docs/specs/native/README.md): written to port, not pinned in
// contracts/logic/ until a port exists.

import { booleanRuns } from "./limits.js";

// Sustained |latG| above this is a corner. Display semantics, not physics —
// like WHEELSPIN_PCT in limits.js and MIN_LOAD_G in grip.js, tune against
// real footage. 0.35 G is well above the noise on a straight and well below
// the lightest real corner on a road-tyred car.
export const CORNER_MIN_G = 0.35;

// Two cornering runs separated by at most this many below-threshold grid
// points are one corner: a chicane or a double apex, not two corners.
// 2 points = 40 m at the 20 m grid.
export const CORNER_MERGE_GAP_POINTS = 2;

// A run shorter than this is a kerb strike or a bump, not a corner.
// 3 points = 60 m at the 20 m grid.
export const MIN_CORNER_POINTS = 3;

// True when the lap stored the channel this module reads.
export function hasCornerData(entry) {
  return Array.isArray(entry?.latG);
}

// The cornering mask of one lap: true at every grid point where |latG| is at
// or above `minG`. A magnitude stored with a sign is still a magnitude —
// pdr.js stores abs(lateral acceleration), and a negative would be a source
// bug, not a left-hander.
export function cornerMask(latG, minG = CORNER_MIN_G) {
  if (!Array.isArray(latG)) return [];
  return latG.map((g) => Math.abs(g) >= minG);
}

// A mask reduced to corners: [{k0, k1}] inclusive, merged across gaps of at
// most `mergeGap` clear points, runs shorter than `minPoints` dropped.
export function cornersFromMask(mask, { mergeGap = CORNER_MERGE_GAP_POINTS, minPoints = MIN_CORNER_POINTS } = {}) {
  return booleanRuns(mask, mergeGap).filter((r) => r.k1 - r.k0 + 1 >= minPoints);
}

// One lap's corners, numbered from the start/finish line: [{n, k0, k1, peakG,
// peakK}] with peakG the lap's highest |latG| in the window and peakK where.
// [] without a latG channel.
export function lapCorners(entry, opts = {}) {
  if (!hasCornerData(entry)) return [];
  const { minG = CORNER_MIN_G } = opts;
  return cornersFromMask(cornerMask(entry.latG, minG), opts).map((r, i) => ({ n: i + 1, ...r, ...peakIn(entry.latG, r) }));
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

// The session's corners on the shared grid: [{n, k0, k1, peakG, peakK, laps}]
// from the union of every lap's cornering mask, with `peakG` the highest
// |latG| any lap saw in the window and `laps` how many laps cleared the
// threshold somewhere inside it. [] when no lap stored latG.
export function sessionCorners(channels, opts = {}) {
  const laps = (channels?.laps ?? []).filter(hasCornerData);
  if (!laps.length) return [];
  const { minG = CORNER_MIN_G } = opts;
  const n = Math.max(...laps.map((l) => l.latG.length));
  const union = new Array(n).fill(false);
  const masks = laps.map((l) => cornerMask(l.latG, minG));
  for (const m of masks) for (let k = 0; k < m.length; k++) if (m[k]) union[k] = true;
  return cornersFromMask(union, opts).map((r, i) => {
    let peakG = 0, peakK = r.k0, count = 0;
    laps.forEach((l, li) => {
      const p = peakIn(l.latG, r);
      if (p.peakG > peakG) {
        peakG = p.peakG;
        peakK = p.peakK;
      }
      const m = masks[li];
      for (let k = r.k0; k <= r.k1; k++) {
        if (m[k]) {
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
