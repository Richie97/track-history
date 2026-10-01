// A car and a driver on the COTA racing line — the demo logbook's telemetry.
//
// Quasi-steady-state lap simulation: a speed cap from each point's curvature
// and the tyres' grip (with downforce), then a forward pass limited by power,
// traction and the friction ellipse, and a backward pass limited by the
// brakes. Every channel the importer stores is derived from that one speed
// trace, so speed, pedals, G, steering, yaw, gears and flags agree with each
// other the way a real recording's do — which is what makes the app's
// analysis (delta, sectors, friction circle, balance, shift points, limits)
// find something real to say.
//
// The driver is the variable: grip used per corner, braking used, how
// round their friction circle is (trail braking), throttle commitment. Skill
// rises across the demo's seasons, so the progress chart trends down for a
// reason the telemetry can show.

import { toLatLon } from "./track.mjs";

const G = 9.81;
const RHO = 1.18;

// A C8 Corvette Z06 with the Z07 package, driver aboard. Wheelbase and
// steering ratio are the car catalog's C8 row, so the vehicle form's
// "measured from N sessions" line recovers the same ratio.
export const Z06 = {
  massKg: 1660,
  powerW: 455_000, // at the wheels
  cdA: 0.78,
  clA: 0.85,
  muLat: 1.36,
  muBrake: 1.34,
  muTraction: 1.3,
  rearWeight: 0.6,
  wheelbaseM: 2.723,
  steeringRatio: 15.7,
  understeerK: 0.00011, // s²/m² — the bicycle model's speed term
  redline: 8600,
  kmhPer1000: [12.2, 17.6, 22.7, 27.8, 33.0, 38.7, 45.3, 52.6],
};

// A seeded PRNG, so the demo logbook is the same every render.
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = Math.max(1e-9, next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return { next, normal };
}

// Skill 0..1 → how much of the car the driver uses.
function driverFor(skill) {
  return {
    grip: 0.8 + 0.18 * skill,
    brake: 0.66 + 0.3 * skill,
    power: 0.9 + 0.1 * skill,
    // friction-ellipse exponent: 1.25 is a novice's diamond (brake, then
    // turn), 2 a trail-braker's circle
    ellipse: 1.25 + 0.75 * skill,
  };
}

// Engine power available at an rpm, as a fraction of peak.
const powerShape = (rpm) => Math.min(1, 0.52 + 0.48 * Math.min(1, Math.max(0, (rpm - 2500) / 5900)));

// Simulate one session: an out lap from pit exit, `laps` timed laps and an in
// lap to pit entry. `skill` is the session's level (0..1), `lapSkill(i)`
// optionally adjusts it per lap, and `rand` varies the driver corner by corner.
export function simulateSession(track, car, { skill, laps, seed, lapTrouble = {}, startTod = 0 }) {
  const R = rng(seed);
  const L = track.pts.length; // 1 m spacing
  const kL = (0.5 * RHO * car.clA) / car.massKg;
  const kD = (0.5 * RHO * car.cdA) / car.massKg;
  const roll = 0.014 * G;

  // Per-lap, per-corner grip use: the session's level, colder on the first
  // flying lap, with each corner a little different every lap.
  const lapsPlan = [];
  for (let l = 0; l < laps; l++) {
    const warm = l === 0 ? -0.05 : l === 1 ? -0.012 : 0;
    const fade = l > 4 ? -0.004 * (l - 4) : 0;
    const d = driverFor(Math.max(0, Math.min(1, skill + warm + fade)));
    const perCorner = track.corners.map(() => 1 + 0.017 * R.normal());
    const brakeVar = 1 + 0.035 * R.normal();
    lapsPlan.push({ d, perCorner, brakeVar, trouble: lapTrouble[l + 1] ?? null });
  }
  const cool = driverFor(0);
  const coolLap = { d: { ...cool, grip: 0.62, brake: 0.45, power: 0.55 }, perCorner: track.corners.map(() => 1), brakeVar: 1 };

  // The session as one long path: [pit exit → S/F] + laps × L + [S/F → pit entry].
  const OUT_FROM = 380; // after T1, where the pit lane rejoins
  const IN_TO = L - 330; // pit entry, before the start/finish line
  const segs = [];
  segs.push({ plan: coolLap, from: OUT_FROM, to: L, lap: 0 });
  for (let l = 0; l < laps; l++) segs.push({ plan: lapsPlan[l], from: 0, to: L, lap: l + 1 });
  segs.push({ plan: coolLap, from: 0, to: IN_TO, lap: laps + 1 });

  const cornerAt = new Int16Array(L).fill(-1);
  track.corners.forEach((c, ci) => {
    // a corner's grip use applies from its braking zone through its exit
    for (let i = c.from - 60; i < c.to + 40; i++) cornerAt[(i + L) % L] = ci;
  });

  const N = segs.reduce((n, s) => n + (s.to - s.from), 0);
  const idx = new Int32Array(N); // track index
  const lapOf = new Int16Array(N);
  const grip = new Float64Array(N), brk = new Float64Array(N), pwr = new Float64Array(N), ell = new Float64Array(N);
  const trouble = new Array(N).fill(null);
  let n = 0;
  for (const sg of segs) {
    for (let i = sg.from; i < sg.to; i++, n++) {
      idx[n] = i;
      lapOf[n] = sg.lap;
      const c = cornerAt[i];
      grip[n] = sg.plan.d.grip * (c >= 0 ? sg.plan.perCorner[c] : 1);
      brk[n] = sg.plan.d.brake * sg.plan.brakeVar;
      pwr[n] = sg.plan.d.power;
      ell[n] = sg.plan.d.ellipse;
      trouble[n] = sg.plan.trouble;
    }
  }
  // Traffic: a lap with trouble lifts for a stretch of track (a point-by).
  for (let k = 0; k < N; k++) {
    const t = trouble[k];
    if (t && idx[k] >= t.from && idx[k] < t.to) pwr[k] *= t.power ?? 0.45;
  }

  const kappa = (k) => Math.abs(track.pts[idx[k]].k);
  const vCap = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    const mu = car.muLat * grip[k];
    const den = kappa(k) - mu * kL;
    vCap[k] = den > 0 ? Math.min(92, Math.sqrt((mu * G) / den)) : 92;
  }
  const latUse = (k, v) => {
    const ay = v * v * kappa(k);
    const ayMax = car.muLat * grip[k] * (G + kL * v * v);
    return Math.min(1, ay / ayMax);
  };
  const ellipseLeft = (k, v) => {
    const r = latUse(k, v);
    return Math.pow(Math.max(0, 1 - Math.pow(r, ell[k])), 1 / ell[k]);
  };

  // Forward: power, traction, drag. Starts rolling out of the pit lane.
  const v = new Float64Array(N);
  v[0] = Math.min(vCap[0], 16);
  // Gear numbers are 1-based; kmhPer1000[g - 1] is gear g.
  const perK = (g) => car.kmhPer1000[g - 1];
  const gearFor = (spd) => {
    const kmh = spd * 3.6;
    for (let g = 1; g <= car.kmhPer1000.length; g++) if ((kmh / perK(g)) * 1000 < 8250) return g;
    return car.kmhPer1000.length;
  };
  for (let k = 0; k < N - 1; k++) {
    const s = v[k];
    const rpm = (s * 3.6 / perK(gearFor(s))) * 1000;
    const aPower = (car.powerW * powerShape(rpm) * pwr[k]) / (car.massKg * Math.max(s, 3));
    const aTrac = car.muTraction * car.rearWeight * (G + kL * s * s) * ellipseLeft(k, s);
    const a = Math.min(aPower, aTrac) - kD * s * s - roll;
    v[k + 1] = Math.min(vCap[k + 1], Math.sqrt(Math.max(0, s * s + 2 * a)));
  }
  // Backward: brakes (plus drag, which helps), ending at pit-lane speed.
  v[N - 1] = Math.min(v[N - 1], 17);
  for (let k = N - 1; k > 0; k--) {
    const s = v[k];
    const aBrake = car.muBrake * brk[k] * (G + kL * s * s) * ellipseLeft(k, s) + kD * s * s + roll;
    const vPrev = Math.sqrt(s * s + 2 * aBrake);
    if (vPrev < v[k - 1]) v[k - 1] = vPrev;
  }

  // Time along the path, and the start/finish crossings.
  const t = new Float64Array(N);
  for (let k = 1; k < N; k++) t[k] = t[k - 1] + 2 / (v[k - 1] + v[k] || 1);
  const crossings = [];
  for (let k = 1; k < N; k++) if (idx[k] === 0) crossings.push(t[k]);
  const lapList = [];
  for (let l = 0; l + 1 < crossings.length; l++) {
    lapList.push({
      lapNumber: l + 1,
      startT: startTod + crossings[l],
      endT: startTod + crossings[l + 1],
      timeMs: Math.round((crossings[l + 1] - crossings[l]) * 1000),
    });
  }

  // Resample at 20 Hz and derive every channel from the speed trace.
  const HZ = 20;
  const T = t[N - 1];
  const samples = Math.floor(T * HZ);
  const out = {
    gps: [], dist: [],
    chans: { speed: [], rpm: [], latG: [], throttle: [], brake: [], steering: [], longG: [], yaw: [], gear: [], wheelSlip: [], flags: [] },
  };
  // Line variation: each lap drives a slightly different line (±0.6 m).
  const lineWob = segs.map(() => [0, 1, 2].map(() => ({ a: 0.25 * R.normal(), f: 2 + 5 * R.next(), p: 6.28 * R.next() })));
  let k = 0;
  let gear = 2;
  let throttle = 0, brake = 0;
  let absZoneOn = false;
  const absPlan = lapsPlan.map(() => track.corners.map(() => R.next() < 0.3));
  const spinPlan = lapsPlan.map(() => track.corners.map(() => R.next() < 0.2));
  let shiftAt = 8250 + 120 * R.normal();
  let segIdx = 0, segStartN = 0;
  let prevDriven = 0;
  for (let j = 0; j < samples; j++) {
    const tj = j / HZ;
    while (k < N - 2 && t[k + 1] < tj) k++;
    const f = Math.min(1, Math.max(0, (tj - t[k]) / (t[k + 1] - t[k] || 1)));
    const spd = v[k] + (v[k + 1] - v[k]) * f;
    const driven = k + f; // metres since pit exit
    while (segIdx < segs.length - 1 && k >= segStartN + (segs[segIdx].to - segs[segIdx].from)) {
      segStartN += segs[segIdx].to - segs[segIdx].from;
      segIdx++;
    }
    const ti = idx[k];
    const p = track.pts[ti];
    const kap = p.k;
    const ax = (v[k + 1] * v[k + 1] - v[k] * v[k]) / 2;
    const ay = spd * spd * kap; // signed, left positive

    // Position: the racing line, the lap's own wobble, and GPS noise.
    const along = ti / L;
    const wob = lineWob[segIdx].reduce((s, w) => s + w.a * Math.sin(2 * Math.PI * w.f * along + w.p), 0);
    const nx = -p.hy, ny = p.hx;
    const ll = toLatLon(p.x + nx * wob + 0.12 * R.normal(), p.y + ny * wob + 0.12 * R.normal());
    out.gps.push({ t: startTod + tj, lat: ll.lat, lon: ll.lon, v: spd });
    out.dist.push({ t: startTod + tj, v: Math.max(prevDriven, driven) });
    prevDriven = Math.max(prevDriven, driven);

    // Pedals. Tractive force → throttle against what the engine can give;
    // negative force beyond drag and engine braking → brake pressure.
    const rpmNow = (spd * 3.6 / perK(gear)) * 1000;
    const drag = kD * spd * spd + roll;
    const engineBrake = 0.09 * G;
    let thrTarget = 0, brkTarget = 0;
    if (ax > -drag) {
      const force = car.massKg * (ax + drag);
      thrTarget = Math.min(100, (100 * force * Math.max(spd, 3)) / (car.powerW * powerShape(rpmNow)));
      if (latUse(k, spd) > 0.55 && thrTarget < 12) thrTarget = 12 + 10 * latUse(k, spd); // maintenance throttle
    } else if (ax < -(drag + engineBrake)) {
      const force = car.massKg * (-ax - drag - engineBrake);
      brkTarget = Math.min(100, (100 * force) / (car.massKg * car.muBrake * (G + kL * spd * spd)));
    }
    // Feet move at finite speed: throttle opens over ~0.3 s, brake bites in ~0.15 s.
    throttle += Math.max(-80, Math.min(18, thrTarget - throttle));
    brake += Math.max(-40, Math.min(34, brkTarget - brake));
    if (brake > 2) throttle = Math.min(throttle, 0);
    throttle = Math.max(0, Math.min(100, throttle));
    brake = Math.max(0, Math.min(100, brake));

    // Gears: upshift at the driver's shift point, rev-matched downshifts
    // while braking, never below 2nd once rolling.
    const rpmIn = (g) => (spd * 3.6 / perK(g)) * 1000;
    if (throttle > 60 && rpmIn(gear) > shiftAt && gear < 7) {
      gear++;
      shiftAt = 8250 + 120 * R.normal();
    }
    while (brake > 5 && gear > 2 && rpmIn(gear - 1) < 7600) gear--;
    while (gear < 7 && rpmIn(gear) > 8550) gear++;
    if (spd < 4) gear = 1;
    let rpm = rpmIn(gear);
    rpm = Math.max(1100, Math.min(car.redline, rpm + 25 * R.normal()));

    // Steering: the bicycle model with an understeer term — exactly the
    // model steeringFit (public/js/balance.js) fits, so the fit recovers
    // this car's catalog ratio. Yaw follows the path.
    const lapNo = lapOf[k];
    const cornerIdx = cornerAt[ti];
    // Corner character: a push in the fast esses, a loose rear on the
    // slow hairpin exits under power — what the balance view reads.
    let bal = 1;
    if (cornerIdx >= 0) bal = cornerIdx % 5 === 1 ? 1.12 : cornerIdx % 7 === 3 ? 0.9 : 1;
    const roadWheel = car.wheelbaseM * kap * (1 + car.understeerK * spd * spd) * bal;
    const steer = (roadWheel * car.steeringRatio * 180) / Math.PI + 0.6 * R.normal();
    const yaw = (spd * kap * 180) / Math.PI + 0.25 * R.normal();

    // Slip and flags: wheelspin on power out of slow corners (traction
    // control past ~9 %), ABS in the heaviest stops on some laps.
    let slip = throttle > 50 ? 0.6 + (throttle / 100) * (gear <= 3 ? 1.9 : 0.7) * (0.4 + Math.min(1, Math.abs(ay) / 12)) : 0.2;
    let flags = 0;
    const timed = lapNo >= 1 && lapNo <= laps;
    const lapPlan = timed ? absPlan[lapNo - 1] : null;
    if (timed && cornerIdx >= 0 && spinPlan[lapNo - 1][cornerIdx] && throttle > 85 && gear <= 3 && Math.abs(ay) > 6) {
      slip += 6 + 1.8 * Math.sin(tj * 9);
    }
    if (slip > 9) flags |= 2;
    if (brake > 62) {
      slip = -(0.6 + (brake - 62) * 0.05);
      if (lapPlan && cornerIdx >= 0 && lapPlan[cornerIdx] && brake > 72 && spd > 25) {
        absZoneOn = true;
        slip = -(9 + 4 * R.next());
      }
    } else absZoneOn = false;
    if (absZoneOn) flags |= 1;

    out.chans.speed.push({ t: startTod + tj, v: spd * 3.6 });
    out.chans.rpm.push({ t: startTod + tj, v: rpm });
    out.chans.latG.push({ t: startTod + tj, v: Math.abs(ay) / G + 0.012 * Math.abs(R.normal()) });
    out.chans.throttle.push({ t: startTod + tj, v: throttle });
    out.chans.brake.push({ t: startTod + tj, v: brake });
    out.chans.steering.push({ t: startTod + tj, v: steer });
    out.chans.longG.push({ t: startTod + tj, v: ax / G + 0.01 * R.normal() });
    out.chans.yaw.push({ t: startTod + tj, v: yaw });
    out.chans.gear.push({ t: startTod + tj, v: gear });
    out.chans.wheelSlip.push({ t: startTod + tj, v: Math.max(-40, Math.min(40, slip)) });
    out.chans.flags.push({ t: startTod + tj, v: flags });
  }
  return { ...out, laps: lapList, durationS: T };
}

// The slow channels (1 Hz): temperatures that soak, tyres that come up to
// pressure, fuel that goes down. Reduced per lap by the importer's rules.
export function slowChannels({ durationS, startTod = 0, ambientC, fuelStartPct = 92, seed, hotDay = 0 }) {
  const R = rng(seed);
  const s = {};
  const names = ["oilC", "oilKpa", "coolantC", "transC", "fuelPct", "battV",
    "tyreKpaLF", "tyreKpaRF", "tyreKpaLR", "tyreKpaRR", "tyreCLF", "tyreCRF", "tyreCLR", "tyreCRR"];
  for (const n of names) s[n] = [];
  const lag = (from, to, tau, tt) => to + (from - to) * Math.exp(-tt / tau);
  for (let tt = 0; tt <= durationS; tt += 1) {
    const at = startTod + tt;
    const oil = lag(86, ambientC + 80 + hotDay, 420, tt);
    s.oilC.push({ t: at, v: oil + 0.4 * R.normal() });
    s.oilKpa.push({ t: at, v: 470 - 1.6 * (oil - 88) + 25 * Math.sin(tt / 9) + 6 * R.normal() });
    s.coolantC.push({ t: at, v: lag(84, ambientC + 70, 240, tt) + 0.3 * R.normal() });
    s.transC.push({ t: at, v: lag(78, ambientC + 70 + hotDay, 520, tt) + 0.3 * R.normal() });
    s.fuelPct.push({ t: at, v: Math.max(4, fuelStartPct - tt * 0.0445) });
    s.battV.push({ t: at, v: 14.15 + 0.05 * R.normal() });
    // Counter-clockwise circuit: the right-hand tyres work hardest.
    const hot = (cold, gain, tau) => lag(cold, cold + gain, tau, tt);
    s.tyreKpaLF.push({ t: at, v: hot(201, 31, 150) + R.normal() });
    s.tyreKpaRF.push({ t: at, v: hot(201, 36, 150) + R.normal() });
    s.tyreKpaLR.push({ t: at, v: hot(194, 30, 170) + R.normal() });
    s.tyreKpaRR.push({ t: at, v: hot(194, 34, 170) + R.normal() });
    s.tyreCLF.push({ t: at, v: hot(ambientC + 8, 62, 160) + 0.8 * R.normal() });
    s.tyreCRF.push({ t: at, v: hot(ambientC + 8, 70, 160) + 0.8 * R.normal() });
    s.tyreCLR.push({ t: at, v: hot(ambientC + 8, 58, 180) + 0.8 * R.normal() });
    s.tyreCRR.push({ t: at, v: hot(ambientC + 8, 64, 180) + 0.8 * R.normal() });
  }
  return s;
}
