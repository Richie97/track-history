// The analysis half of the AI tools (#315): a session, a lap pair or a lap
// reduced to the few hundred numbers a model can reason over, never the raw
// channel blob (a session is up to ~800 KB of per-lap arrays).
//
// Every figure comes from the web app's own analysis modules, imported
// directly from public/js rather than ported into src/lib. That is the one
// stated exception to "the frontend and backend share no code" (AGENTS.md):
// these modules are already the reference implementation that
// contracts/logic/ pins both native ports to, so a server copy would be a
// sixth mirror to keep in step, while an import cannot drift. Only the pure
// halves are called — the …Html / …Svg exports beside them touch the DOM
// inside their bodies, never at module load, which
// test/api/ai-tools.test.ts asserts by importing every one inside workerd.
//
// Output is in *stored* units (km/h, °C, kPa, metres, milliseconds) with the
// unit in each key's suffix; the tools tell the model the user's preferred
// system and leave the conversion to it.

import { fmtMs } from "../../public/js/format.js";
import { bestNAvg, cleanLaps, paceSlope, warmupLapCount } from "../../public/js/lap-stats.js";
import { deltaSeries, lapTimeSeries, matchLapsToChannels } from "../../public/js/channel-graphs.js";
import { sectorTimes, sessionSectors } from "../../public/js/sectors.js";
import { shiftNotes, shiftPoints } from "../../public/js/gears.js";
import { LIMIT_KINDS, limitSummary, sessionLimits } from "../../public/js/limits.js";
import { sessionGrip } from "../../public/js/grip.js";
import { cornerLabel, sessionCorners } from "../../public/js/corners.js";
import { balanceLabel, balanceSummary, sessionBalance } from "../../public/js/balance.js";
import { HEALTH_DEFS, fuelBurn, healthSummary, hotPressures, sessionHealth } from "../../public/js/health.js";
import { alignLapPair, lapMetrics, lengthMismatchRatio } from "../../public/js/compare-laps.js";

// Gridded channel names, in the stored order (CHANNEL_NAMES in
// public/js/import/channels.js, GRIDDED_CHANNEL_NAMES in lib/validate.ts).
import { GRIDDED_CHANNEL_NAMES, type LapChannelEntry, type LapChannels } from "../lib/validate";

export type Lap = { id: number; lap_num: number; time_ms: number };
export type DetailSession = {
  id: number;
  label: string | null;
  notes: string | null;
  ambient_c: number | null;
  elevation_m: number | null;
  channels: LapChannels | null;
  laps: Lap[];
};

const round = (v: number | null | undefined, dp = 0) => {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};
const time = (ms: number | null | undefined) => (ms == null ? null : fmtMs(Math.round(ms)));

// chIdx → the session's lap row it belongs to, by the same in-order exact-time
// match the channel graphs use.
export function lapsByChannelIndex(laps: Lap[], channels: LapChannels | null): Map<number, Lap> {
  const out = new Map<number, Lap>();
  if (!channels) return out;
  for (const { lap, chIdx } of matchLapsToChannels(laps, channels.laps) as { lap: Lap; chIdx: number }[]) {
    if (chIdx >= 0) out.set(chIdx, lap);
  }
  return out;
}

export function channelsPresent(channels: LapChannels | null): string[] {
  if (!channels) return [];
  return GRIDDED_CHANNEL_NAMES.filter((name) => channels.laps.some((l) => Array.isArray(l[name])));
}

// Lap-time statistics for one session — the same figures the session card's
// stats line shows.
export function lapStats(laps: Lap[]) {
  const times = laps.map((l) => l.time_ms);
  if (!times.length) return null;
  const best = Math.min(...times);
  const clean = cleanLaps(times) as number[];
  const bestLap = laps.find((l) => l.time_ms === best)!;
  return {
    lap_count: times.length,
    best_ms: best,
    best: time(best),
    best_lap_num: bestLap.lap_num,
    best3_avg_ms: round(bestNAvg(times, 3)),
    clean_lap_count: clean.length,
    clean_avg_ms: clean.length ? round(clean.reduce((s, v) => s + v, 0) / clean.length) : null,
    pace_slope_ms_per_lap: round(paceSlope(times), 1),
    warmup_laps: warmupLapCount(times),
  };
}

// One session, reduced. Telemetry sections are present only when the session
// stored the channels behind them, and each is null when it can't be read —
// the model is told which is which rather than being handed zeros.
export function sessionInsights(session: DetailSession) {
  const ch = session.channels;
  const byIdx = lapsByChannelIndex(session.laps, ch);
  const lapNum = (chIdx: number) => byIdx.get(chIdx)?.lap_num ?? null;
  const base = {
    session_id: session.id,
    label: session.label,
    notes: session.notes,
    conditions: { ambient_c: session.ambient_c, elevation_m: session.elevation_m },
    laps: session.laps.map((l) => ({
      lap_id: l.id,
      lap_num: l.lap_num,
      time_ms: l.time_ms,
      time: time(l.time_ms),
      has_telemetry: [...byIdx.values()].some((m) => m.id === l.id),
    })),
    lap_stats: lapStats(session.laps),
  };
  if (!ch || !ch.laps.length) return { ...base, telemetry: null };

  const sectors = sessionSectors(ch);
  const sp = shiftPoints(ch);
  const limits = sessionLimits(ch);
  const grip = sessionGrip(ch);
  const corners = sessionCorners(ch) as { n: number; k0: number; k1: number; peakG: number; laps: number }[];
  const balance = sessionBalance(ch);
  const health = sessionHealth(ch);
  const step = ch.dStepM;

  return {
    ...base,
    telemetry: {
      grid_step_m: step,
      channels: channelsPresent(ch),
      laps_with_telemetry: ch.laps.length,
      sectors: sectors && {
        sector_count: sectors.n,
        note: "Each lap is cut into equal thirds of its own driven distance; the theoretical best is the sum of the best third of each.",
        laps: sectors.laps.map((l: any) => ({ lap_num: lapNum(l.chIdx), sectors_ms: l.sectors })),
        best_sectors_ms: sectors.bestSectors,
        best_sector_lap_nums: sectors.bestSectorLap.map(lapNum),
        theoretical_best_ms: sectors.theoreticalBestMs,
        theoretical_best: time(sectors.theoreticalBestMs),
        best_lap_ms: sectors.bestLapMs,
        gap_to_theoretical_ms: sectors.gapMs,
      },
      shifts: sp && {
        upshift_rpm_by_gear: sp.gears.map((g: any) => ({
          from_gear: g.gear,
          count: g.count,
          min_rpm: g.minRpm,
          median_rpm: g.medianRpm,
          max_rpm: g.maxRpm,
        })),
        median_upshift_rpm: sp.medianRpm,
        max_rpm_seen: sp.maxRpm,
        notes: shiftNotes(sp),
      },
      limits: limits && {
        summary: limitSummary(ch),
        kinds: limits.kinds.map((k: any) => ({
          kind: LIMIT_KINDS.find((d: any) => d.key === k.kind)?.label ?? k.kind,
          places_on_track: k.places,
          laps: k.laps,
        })),
      },
      grip: grip && {
        note: "Shares of loaded samples (combined G ≥ 0.3) spent cornering while braking (trail braking) or while on the power.",
        peak_combined_g: round(grip.peakG, 2),
        max_combined_g: round(grip.maxG, 2),
        trail_brake_pct: round(grip.all.trailPct, 1),
        power_down_pct: round(grip.all.powerPct, 1),
        laps: grip.laps.map((l: any) => ({
          lap_num: lapNum(l.chIdx),
          trail_brake_pct: round(l.trailPct, 1),
          power_down_pct: round(l.powerPct, 1),
        })),
      },
      corners: corners.length
        ? corners.map((c) => ({
            corner: cornerLabel(c),
            start_m: c.k0 * step,
            end_m: c.k1 * step,
            peak_lat_g: round(c.peakG, 2),
          }))
        : null,
      corner_note: corners.length
        ? "Corners are the app's own numbering (T1 is the first stretch of sustained lateral load after the start/finish line), not the circuit's official turn numbers."
        : undefined,
      balance: balance && {
        summary: balanceSummary(ch),
        note: "Relative to this session's own typical steering response: a car that understeers everywhere reads neutral everywhere. Negative pct is understeer, positive oversteer.",
        corners: balance.corners.map((c: any) => ({
          corner: cornerLabel(c),
          pct: round(c.all.pct, 1),
          reading: balanceLabel(c.all.pct),
        })),
      },
      health: health && {
        summary: healthSummary(ch, "metric"),
        columns: health.columns.map((c: any) => {
          const def = HEALTH_DEFS.find((d: any) => d.key === c.key)!;
          return {
            key: c.key,
            label: def.label,
            unit: def.unit,
            rule: def.reduce === "max" ? "peak" : def.reduce === "min" ? "minimum" : "at lap end",
            session_value: round(c.extreme.v, 1),
            status: c.status,
          };
        }),
        fuel: fuelBurn(ch),
        hot_pressures_kpa: hotPressures(ch),
      },
    },
  };
}

// The lap's own channel entry within its session, or null when it has none.
export function channelEntryForLap(session: DetailSession, lapId: number): LapChannelEntry | null {
  const ch = session.channels;
  if (!ch) return null;
  for (const [chIdx, lap] of lapsByChannelIndex(session.laps, ch)) {
    if (lap.id === lapId) return ch.laps[chIdx];
  }
  return null;
}

export type LapSide = { lap: Lap; entry: LapChannelEntry; dStepM: number; label: string };

// Two laps head to head: the compare view's numbers, then where the time went —
// by corner (the time gained or lost between entering and leaving each one,
// with the minimum speed through it on each side) and by tenths of the lap.
// Delta convention: B minus A, so positive means B lost time to A.
export function compareLapPair(a: LapSide, b: LapSide) {
  const pair = alignLapPair(a.entry, a.dStepM, b.entry, b.dStepM) as LapChannels;
  const [ea, eb] = pair.laps;
  const step = pair.dStepM;
  const metrics = (e: LapChannelEntry) => {
    const m = lapMetrics(e);
    return {
      top_speed_kph: round(m.topSpeedKph, 1),
      min_speed_kph: round(m.minSpeedKph, 1),
      avg_speed_kph: round(m.avgSpeedKph, 1),
      max_rpm: m.maxRpm,
      max_lat_g: round(m.maxLatG, 2),
      full_throttle_pct: round(m.fullThrottlePct, 1),
      braking_pct: round(m.brakingPct, 1),
    };
  };
  const side = (s: LapSide, e: LapChannelEntry) => ({
    label: s.label,
    lap_id: s.lap.id,
    lap_num: s.lap.lap_num,
    time_ms: s.lap.time_ms,
    time: time(s.lap.time_ms),
    sectors_ms: sectorTimes(e, step),
    ...metrics(e),
  });

  const delta = deltaSeries(eb, ea, step) as number[] | null;
  const at = (k: number) => (delta ? delta[Math.min(k, delta.length - 1)] : 0);
  let byCorner: unknown[] | null = null;
  let bySegment: unknown[] | null = null;
  if (delta) {
    const corners = sessionCorners(pair) as { n: number; k0: number; k1: number }[];
    const minIn = (arr: number[] | undefined, k0: number, k1: number) => {
      if (!Array.isArray(arr)) return null;
      const slice = arr.slice(k0, Math.min(k1, arr.length - 1) + 1);
      return slice.length ? round(Math.min(...slice), 1) : null;
    };
    byCorner = corners
      .filter((c) => c.k0 < delta.length)
      .map((c) => ({
        corner: cornerLabel(c),
        start_m: c.k0 * step,
        end_m: c.k1 * step,
        a_min_speed_kph: minIn(ea.speed, c.k0, c.k1),
        b_min_speed_kph: minIn(eb.speed, c.k0, c.k1),
        b_minus_a_ms: Math.round((at(c.k1) - at(c.k0)) * 1000),
      }));
    const SEGMENTS = 10;
    const last = delta.length - 1;
    bySegment = Array.from({ length: SEGMENTS }, (_, i) => {
      const k0 = Math.round((i * last) / SEGMENTS);
      const k1 = Math.round(((i + 1) * last) / SEGMENTS);
      return { start_m: k0 * step, end_m: k1 * step, b_minus_a_ms: Math.round((at(k1) - at(k0)) * 1000) };
    });
  }
  const mismatch = lengthMismatchRatio(a.entry, a.dStepM, b.entry, b.dStepM);
  return {
    delta_convention: "b_minus_a: positive means lap B lost time to lap A over that stretch",
    a: side(a, ea),
    b: side(b, eb),
    b_minus_a_ms: b.lap.time_ms - a.lap.time_ms,
    by_corner: byCorner,
    by_tenth_of_lap: bySegment,
    length_mismatch_pct: round(mismatch * 100, 1),
    warning:
      mismatch > 0.05
        ? "The two laps' driven distances differ by more than 5% — a different layout, start/finish line or an off-track moment; distance-based comparisons are approximate."
        : undefined,
  };
}

export const TELEMETRY_MAX_VALUES = 6000;

// One lap's traces, thinned to `stepM` (a multiple of the stored grid), for
// the channels asked for. The elapsed-time trace is derived from speed the
// way the delta chart derives it. Bounded by TELEMETRY_MAX_VALUES: past it the
// step widens and the response says so.
export function lapTelemetry(entry: LapChannelEntry, dStepM: number, wanted: string[], stepM: number) {
  const names = wanted.filter((n) => n === "elapsed_s" || (GRIDDED_CHANNEL_NAMES as readonly string[]).includes(n));
  const series: Record<string, number[]> = {};
  for (const n of names) {
    if (n === "elapsed_s") {
      if (Array.isArray(entry.speed)) series.elapsed_s = lapTimeSeries(entry.speed, dStepM, entry.timeMs) as number[];
    } else if (Array.isArray((entry as any)[n])) {
      series[n] = (entry as any)[n];
    }
  }
  const len = Math.max(0, ...Object.values(series).map((s) => s.length));
  let stride = Math.max(1, Math.round(stepM / dStepM));
  const perPoint = Object.keys(series).length + 1;
  let widened = false;
  while (Math.ceil(len / stride) * perPoint > TELEMETRY_MAX_VALUES) {
    stride++;
    widened = true;
  }
  const idx: number[] = [];
  for (let k = 0; k < len; k += stride) idx.push(k);
  if (len && idx[idx.length - 1] !== len - 1) idx.push(len - 1);
  const dp: Record<string, number> = { latG: 2, longG: 2, elapsed_s: 2 };
  const out: Record<string, (number | null)[]> = {};
  for (const [n, s] of Object.entries(series)) out[n] = idx.map((k) => round(s[k], dp[n] ?? 1));
  return {
    step_m: stride * dStepM,
    step_note: widened ? `Widened to keep the response under ${TELEMETRY_MAX_VALUES} values; ask for fewer channels for a finer step.` : undefined,
    distance_m: idx.map((k) => k * dStepM),
    channels: out,
    missing: names.filter((n) => !(n in series)),
  };
}
