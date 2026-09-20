// The measured steering ratio (#223): the server-side mirror of `steeringFit`
// in `public/js/balance.js`, which is the reference — read that file's header
// for the physics. It is a mirror for the same reason `withComputed` mirrors
// `recomputeDetail`: the backend and the frontend share no code, and the fit
// has to run here because `GET /vehicles/:id/steering-fit` reads a car's
// recent session blobs once rather than having three clients each pull every
// one. **Keep the two in step** — `test/unit/steering-fit.test.ts` pins this
// copy to the fixture the web implementation generated
// (`contracts/logic/balance.json`), so a drift fails a test rather than a
// driver's form.
//
// Nothing here is tier logic: the route that calls it is behind
// `requireEntitlement` like the rest of the garage, and that is where the
// gate lives.

import type { LapChannelEntry, LapChannels } from "./validate";

// `public/js/balance.js`'s usability bounds — a sample counts only with
// steering to divide by and the car moving.
export const MIN_STEER_DEG = 10;
export const MIN_SPEED_KPH = 30;

// Fewer usable samples than this and the fit is a guess.
export const MIN_FIT_SAMPLES = 20;

// A session driven at one speed has no slope to fit.
export const MIN_SPEED_SPREAD_KPH = 40;

// How many of a car's most recent channel-carrying sessions the route fits.
// A track day is two to four sessions, so this is a couple of days' evidence;
// beyond it the number stops moving and the read starts costing.
export const MAX_FIT_SESSIONS = 8;

const KPH_TO_MPS = 1 / 3.6;

export type SteeringFit = { gain0: number; K: number; samples: number; r2: number };

type Readable = LapChannelEntry & { yaw: number[]; steering: number[]; speed: number[] };

const readable = (entry: LapChannelEntry): entry is Readable =>
  Array.isArray(entry.yaw) && Array.isArray(entry.steering) && Array.isArray(entry.speed);

const usableLength = (e: Readable) => Math.min(e.yaw.length, e.steering.length, e.speed.length);

const usableAt = (e: Readable, k: number) =>
  Math.abs(e.steering[k]) >= MIN_STEER_DEG && e.speed[k] >= MIN_SPEED_KPH;

// `yawSign`: which way the recorder's yaw runs relative to its steering,
// measured rather than assumed.
function yawSign(laps: Readable[]): number {
  let sum = 0;
  for (const e of laps) {
    const n = usableLength(e);
    for (let k = 0; k < n; k++) if (usableAt(e, k)) sum += e.steering[k] * e.yaw[k];
  }
  return sum < 0 ? -1 : 1;
}

// `steeringFit`: v·δ = A·(yaw·sign) + B·(v²·yaw·sign), least squares over the
// usable samples; gain₀ = 1/A, K = B/A. The operation order is the reference's.
export function steeringFit(channels: LapChannels | null | undefined): SteeringFit | null {
  const laps = (channels?.laps ?? []).filter(readable);
  const sign = yawSign(laps);
  let s11 = 0, s12 = 0, s22 = 0, t1 = 0, t2 = 0, szz = 0, n = 0;
  let vMin = Infinity, vMax = -Infinity;
  for (const entry of laps) {
    const len = usableLength(entry);
    for (let k = 0; k < len; k++) {
      if (!usableAt(entry, k)) continue;
      const kph = entry.speed[k];
      const v = kph * KPH_TO_MPS;
      const u1 = entry.yaw[k] * sign;
      const u2 = v * v * u1;
      const z = v * entry.steering[k];
      s11 += u1 * u1;
      s12 += u1 * u2;
      s22 += u2 * u2;
      t1 += u1 * z;
      t2 += u2 * z;
      szz += z * z;
      n++;
      if (kph < vMin) vMin = kph;
      if (kph > vMax) vMax = kph;
    }
  }
  if (n < MIN_FIT_SAMPLES || vMax - vMin < MIN_SPEED_SPREAD_KPH) return null;
  const det = s11 * s22 - s12 * s12;
  if (!(det > 0)) return null;
  const A = (t1 * s22 - t2 * s12) / det;
  const B = (t2 * s11 - t1 * s12) / det;
  if (!(A > 0)) return null;
  const ssRes = szz - 2 * (A * t1 + B * t2) + (A * A * s11 + 2 * A * B * s12 + B * B * s22);
  const r2 = szz > 0 ? Math.min(1, Math.max(0, 1 - ssRes / szz)) : 0;
  return { gain0: 1 / A, K: B / A, samples: n, r2 };
}
