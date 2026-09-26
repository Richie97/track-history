// A synthetic but physically shaped lap for the AI tool tests: three corners
// with braking zones, gear changes, an ABS pulse, a wheelspin moment and the
// per-lap scalars — enough for every analysis the tools run (sectors, shifts,
// limits, grip, corners, balance, health) to find something, on a 20 m grid
// that passes sanitizeChannels.

const N = 150; // 3 km at 20 m
const CORNERS = [
  { k0: 30, k1: 44, dir: 1, minKph: 95, yawScale: 1 },
  { k0: 80, k1: 96, dir: -1, minKph: 80, yawScale: 0.7 }, // rotates less than asked: understeer
  { k0: 118, k1: 128, dir: 1, minKph: 120, yawScale: 1.3 }, // rotates more: oversteer
];
const STRAIGHT_KPH = 190;
const BRAKE_POINTS = 8;
const EXIT_POINTS = 12;

const gearFor = (kph: number) => (kph < 100 ? 3 : kph < 140 ? 4 : kph < 175 ? 5 : 6);
const RPM_PER_KPH = [0, 0, 0, 62, 48, 40, 34];

export function syntheticLap(n: number, timeMs: number, { slowKph = 0 } = {}) {
  const speed: number[] = [], throttle: number[] = [], brake: number[] = [], latG: number[] = [];
  const longG: number[] = [], steering: number[] = [], yaw: number[] = [], gear: number[] = [];
  const rpm: number[] = [], wheelSlip: number[] = [], flags: number[] = [];
  for (let k = 0; k < N; k++) {
    let v = STRAIGHT_KPH, thr = 100, brk = 0, lat = 0, lon = 0, steer = 0, yw = 0, slip = 0, flag = 0;
    for (const [ci, c] of CORNERS.entries()) {
      const min = c.minKph - slowKph;
      if (k >= c.k0 - BRAKE_POINTS && k < c.k0) {
        const f = (k - (c.k0 - BRAKE_POINTS)) / BRAKE_POINTS;
        v = STRAIGHT_KPH - (STRAIGHT_KPH - min) * f;
        thr = 0;
        brk = 80 - 40 * f;
        lon = -1.1;
        if (ci === 0 && k >= c.k0 - 3) flag = 1; // ABS at the end of the first braking zone
      } else if (k >= c.k0 && k <= c.k1) {
        const s = Math.sin((Math.PI * (k - c.k0)) / (c.k1 - c.k0));
        v = min;
        thr = 40;
        brk = k < c.k0 + 2 ? 20 : 0;
        lon = k < c.k0 + 2 ? -0.4 : 0.1;
        lat = 1.2 * s;
        steer = c.dir * 90 * s;
        const mps = v / 3.6;
        yw = c.yawScale * c.dir * ((mps * ((90 * s) / 15) * (Math.PI / 180)) / 2.7) * (180 / Math.PI);
      } else if (k > c.k1 && k <= c.k1 + EXIT_POINTS) {
        const f = (k - c.k1) / EXIT_POINTS;
        v = min + (STRAIGHT_KPH - min) * f;
        thr = 60 + 40 * f;
        lon = 0.35;
        if (ci === 1 && k === c.k1 + 1) slip = 9; // wheelspin out of the second corner
      }
    }
    const g = gearFor(v);
    speed.push(Math.round(v * 10) / 10);
    throttle.push(thr);
    brake.push(brk);
    latG.push(Math.round(lat * 1000) / 1000);
    longG.push(lon);
    steering.push(Math.round(steer * 10) / 10);
    yaw.push(Math.round(yw * 10) / 10);
    gear.push(g);
    rpm.push(Math.min(7400, Math.round(v * RPM_PER_KPH[g])));
    wheelSlip.push(slip);
    flags.push(flag);
  }
  return {
    n,
    timeMs,
    speed,
    rpm,
    latG,
    throttle,
    brake,
    steering,
    longG,
    yaw,
    gear,
    wheelSlip,
    flags,
    oilC: 110 + n,
    coolantC: 96,
    fuelPct: Math.max(5, 80 - 2 * n),
    tyreKpaLF: 230 + n,
    tyreKpaRF: 228 + n,
    tyreKpaLR: 225 + n,
    tyreKpaRR: 224 + n,
  };
}

// A session body for POST /events/:id/sessions: `times` become the laps, and
// every one of them carries telemetry.
export function telemetrySession(times: number[], label = "Session 1") {
  return {
    label,
    laps: times,
    channels: {
      v: 1,
      dStepM: 20,
      meta: { ambientC: 24, elevationM: 40 },
      laps: times.map((t, i) => syntheticLap(i + 1, t, { slowKph: i === 0 ? 8 : 0 })),
    },
  };
}

// A racing line for a session body's `trace` (sanitizeTrace's [x, y, v]):
// `points` fixes round a circle of the given driven length, starting away from
// the projection origin — as a real line does, since its origin is the
// recording's first fix — so the tools' re-origin to the start/finish line
// shows up.
export function circleTrace(lengthM = 2980, points = 300) {
  const r = lengthM / (2 * Math.PI);
  return Array.from({ length: points }, (_, i) => {
    const a = (2 * Math.PI * i) / (points - 1);
    return [Math.round((250 + r * Math.sin(a)) * 10) / 10, Math.round((-80 + r - r * Math.cos(a)) * 10) / 10, 40];
  });
}
