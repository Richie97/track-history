// Cross-event lap comparison (issue #165): the pure half of the "compare two
// laps" view. Given any two laps that stored channel data (sessions.channels,
// see js/import/channels.js), these helpers pick sensible defaults, put the
// pair on one distance grid, and reduce each lap's channels to head-to-head
// numbers. The chart rendering stays in channel-graphs.js — alignLapPair
// returns the same {v, dStepM, laps} shape a session stores, so the existing
// renderers draw the pair unchanged.
//
// Ported to iOS (TrackEvolutionKit CompareLaps.swift) and Android (:core
// CompareLaps.kt) with the same function names, pinned by
// contracts/logic/compare-laps.json — the ports assert against this file's
// output, so behavior changes here regenerate the fixture and flow to both.

import { matchLapsToChannels } from "./channel-graphs.js";

// Every channel a stored lap entry can carry — mirrors CHANNEL_NAMES in
// js/import/channels.js (keep in sync; order is irrelevant here).
const CHANNEL_KEYS = ["speed", "rpm", "latG", "throttle", "brake", "steering"];

// "Flat out" / "on the brakes" thresholds for lapMetrics' percentages.
// Throttle rarely reads a perfect 100 on real hardware; brake noise floors
// vary — both cutoffs are display semantics, not physics.
export const FULL_THROTTLE_PCT = 95;
export const BRAKING_PCT = 10;

// Two laps whose driven lengths differ by more than this are probably not the
// same layout / start line — the view shows a soft warning past it.
export const LENGTH_MISMATCH_WARN = 0.05;

// Flatten event details (GET /api/events/:id shape) into one pickable list of
// laps that have channel data. Keeps the given event order; within an event,
// session order then lap order. Each row carries what a picker needs to label
// it and what the pair-building needs to find the channel entry again.
export function comparableLaps(events) {
  const rows = [];
  for (const e of events) {
    for (const s of e.sessions ?? []) {
      if (!s.channels?.laps?.length || !s.laps?.length) continue;
      for (const { lap, chIdx } of matchLapsToChannels(s.laps, s.channels.laps)) {
        if (chIdx < 0) continue;
        rows.push({
          eventId: e.id,
          date: e.start_date,
          club: e.club ?? null,
          sessionId: s.id,
          sessionLabel: s.label ?? null,
          lapNum: lap.lap_num,
          timeMs: lap.time_ms,
          chIdx,
        });
      }
    }
  }
  return rows;
}

// Default selection: side A is "current me" — the best lap of the most recent
// event with comparable laps — and side B is "best me", the overall best lap.
// When they are the same lap, B falls back to the best of the rest. Returns
// {a, b} as indexes into rows, or null when there is nothing to compare.
export function defaultComparePicks(rows) {
  if (rows.length < 2) return null;
  let latest = rows[0].date;
  for (const r of rows) if (r.date > latest) latest = r.date;
  const bestIn = (idxs) => idxs.reduce((m, i) => (rows[i].timeMs < rows[m].timeMs ? i : m));
  const all = rows.map((_, i) => i);
  const a = bestIn(all.filter((i) => rows[i].date === latest));
  let b = bestIn(all);
  if (b === a) b = bestIn(all.filter((i) => i !== a));
  return { a, b };
}

// Linear-resample one stored channel-lap entry from its grid spacing onto
// another. Identity when the spacings already match (every writer uses 20 m
// today, but dStepM is stored per session and this must not assume).
export function resampleChannelLap(entry, fromStepM, toStepM) {
  if (fromStepM === toStepM) return entry;
  const out = { n: entry.n, timeMs: entry.timeMs };
  for (const key of CHANNEL_KEYS) {
    const arr = entry[key];
    if (!Array.isArray(arr) || arr.length < 2) continue;
    const n = Math.floor(((arr.length - 1) * fromStepM) / toStepM) + 1;
    const res = new Array(n);
    for (let k = 0; k < n; k++) {
      const p = (k * toStepM) / fromStepM;
      const i0 = Math.min(arr.length - 2, Math.floor(p));
      res[k] = arr[i0] + (arr[i0 + 1] - arr[i0]) * (p - i0);
    }
    out[key] = res;
  }
  return out;
}

// Put a pair of channel-lap entries on one grid: side B is resampled onto
// side A's spacing when the two sessions stored different grids. The result
// is the sessions.channels shape with exactly two laps, so channel-graphs.js'
// renderers draw a cross-event pair the same way they draw one session.
export function alignLapPair(entryA, stepA, entryB, stepB) {
  return {
    v: 1,
    dStepM: stepA,
    laps: [entryA, resampleChannelLap(entryB, stepB, stepA)],
  };
}

// Driven length a stored entry covers (its grid extent, meters).
export function drivenLengthM(entry, stepM) {
  const n = entry.speed?.length ?? 0;
  return n > 1 ? (n - 1) * stepM : 0;
}

// Relative driven-length difference between two entries (0 = identical).
// Distance is measured from each lap's own start line, so a large ratio means
// a different layout, a different picked line, or an off-track excursion —
// the comparison still renders, with a warning past LENGTH_MISMATCH_WARN.
export function lengthMismatchRatio(entryA, stepA, entryB, stepB) {
  const la = drivenLengthM(entryA, stepA);
  const lb = drivenLengthM(entryB, stepB);
  const longest = Math.max(la, lb);
  return longest > 0 ? Math.abs(la - lb) / longest : 0;
}

// One lap's channels reduced to head-to-head numbers. Speed is km/h as stored
// (the caller converts for display); percentages are shares of grid samples,
// which on a uniform distance grid means shares of the lap's driven distance.
// Channels the lap didn't store are null.
export function lapMetrics(entry) {
  const speed = Array.isArray(entry.speed) && entry.speed.length ? entry.speed : null;
  const share = (arr, min) =>
    Array.isArray(arr) && arr.length
      ? (100 * arr.filter((v) => v >= min).length) / arr.length
      : null;
  return {
    timeMs: entry.timeMs,
    topSpeedKph: speed ? Math.max(...speed) : null,
    minSpeedKph: speed ? Math.min(...speed) : null,
    avgSpeedKph: speed ? speed.reduce((s, v) => s + v, 0) / speed.length : null,
    maxRpm: Array.isArray(entry.rpm) && entry.rpm.length ? Math.max(...entry.rpm) : null,
    maxLatG: Array.isArray(entry.latG) && entry.latG.length ? Math.max(...entry.latG) : null,
    fullThrottlePct: share(entry.throttle, FULL_THROTTLE_PCT),
    brakingPct: share(entry.brake, BRAKING_PCT),
  };
}
