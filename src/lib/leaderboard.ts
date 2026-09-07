// What a leaderboard lap publishes (NS-35).
//
// A driver who turns on `leaderboard_share_laps` makes *one* lap per catalog
// track openable by other ranked drivers: the same lap the leaderboard already
// names a time for. This module is the rule for what that lap carries, kept
// pure so it is unit-tested rather than inspected.
//
// The rule NS-33 set for the leaderboard holds here too — **nothing
// user-entered is ever published**. Session labels, notes, the event, the car,
// the conditions and the setup sheet stay in the owner's logbook. What is
// published is what a device measured: the lap's gridded channel traces, its
// projected racing line, and the recorded ambient temperature and elevation.
//
// Two exclusions are deliberate and are the reason this is an allow-list:
//
//   - **Per-lap scalars** (`SCALAR_SPECS` — oil and coolant temperature, oil
//     pressure, fuel level, battery voltage, tyre pressures and temperatures)
//     describe the *car's* condition, not the lap. Publishing a stranger's
//     fuel level and tyre pressures is a different disclosure from publishing
//     their line, and nobody asked for it.
//   - **`meta.odometerKm`** is the car's lifetime odometer. It is the single
//     most identifying number in the blob and has nothing to do with a lap
//     time.
//
// Building the entry by copying `GRIDDED_CHANNEL_NAMES` — rather than by
// deleting the fields above from the stored entry — is what makes those
// exclusions survive a future channel. A scalar appended to `SCALAR_SPECS`
// stays private with no edit here; a gridded channel appended to
// `CHANNEL_SPECS` is published, which is the intent, since the whole point of
// a shared lap is the traces.

import { GRIDDED_CHANNEL_NAMES, type LapChannelEntry, type LapChannels } from "./validate";

// Parse a stored `sessions.channels` blob. Malformed JSON degrades to null
// rather than throwing, the way every other stored-JSON read here does: one
// bad row must not make a leaderboard unopenable.
export function parseStoredChannels(raw: unknown): LapChannels | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const o = v as Partial<LapChannels>;
    if (typeof o.dStepM !== "number" || !Array.isArray(o.laps)) return null;
    return o as LapChannels;
  } catch {
    return null;
  }
}

// The one lap's channels, in the stored `sessions.channels` shape so every
// client's existing renderers draw it with no new code path — `{ v, dStepM,
// laps: [entry] }` with exactly one entry, which is also what `alignLapPair`
// produces for the two-lap compare.
//
// `timeMs` is matched exactly, the same rule `laps.device_timed` (migration
// 0018) and `matchLapsToChannels` use; both sides round to integer
// milliseconds, so equality is exact. Returns null when the blob carries no
// entry for this lap — which cannot happen for a `device_timed` lap by
// construction, but a rewritten blob must degrade to "no telemetry" rather
// than to someone else's lap.
export function publicLapChannels(stored: LapChannels | null, timeMs: number): LapChannels | null {
  if (!stored) return null;
  const src = stored.laps.find((l) => l.timeMs === timeMs);
  if (!src) return null;
  const entry: LapChannelEntry = { n: src.n, timeMs: src.timeMs };
  let any = false;
  for (const name of GRIDDED_CHANNEL_NAMES) {
    const arr = src[name];
    if (!Array.isArray(arr)) continue;
    entry[name] = arr;
    any = true;
  }
  // An entry with no traces is not telemetry — it is a lap time restated, and
  // the response already carries the time.
  if (!any) return null;
  return { v: 1, dStepM: stored.dStepM, laps: [entry] };
}
