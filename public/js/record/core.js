// Live lap-recording core: the pure logic behind the in-app GPS recorder.
// The recorder collects fixes from the native background-geolocation watcher
// (public/js/record/ui.js owns that lifecycle); everything here is plain data
// in → data out so it unit-tests in Node. The output of toParsed() is shaped
// exactly like a telemetry file parser's result (js/import/parse.js), so a
// finished recording drops into the existing import review + line-picker
// pipeline unchanged.
//
// Recording shape (also the checkpoint format persisted via platform.prefSet):
//   { v: 1, eventId, startedAtMs, fixes: [[tRelS, lat, lon, v|null, acc|null]] }
// tRelS is seconds since startedAtMs; v is m/s; acc is reported accuracy in
// meters. Tuples keep the checkpoint JSON small (~50 bytes/fix).

export const RECORDING_V = 1;

// Fixes with worse reported accuracy than this are noise (parking garages,
// cold starts) — dropping them beats feeding them to the gate math.
export const MAX_ACC_M = 100;
// Above this speed the car has clearly been on track (m/s, ~54 km/h) —
// auto-stop is armed only after this, so a long grid wait before the first
// lap never kills the recording.
export const DRIVEN_MPS = 15;
// "Stationary" for trimming and auto-stop (m/s, brisk walking pace).
export const IDLE_MPS = 2;
// Auto-stop after this long stationary once the car has been driven.
export const AUTO_STOP_IDLE_S = 15 * 60;
// Absolute cap — a forgotten recorder must not run all day.
export const MAX_DURATION_S = 4 * 3600;
export const MAX_FIXES = 20000;

export function createRecording(eventId, startedAtMs) {
  return { v: RECORDING_V, eventId, startedAtMs, fixes: [] };
}

const round = (v, f) => Math.round(v * f) / f;

// Append a watcher fix ({timeMs, lat, lon, speed?, accuracy?}). Returns true
// when the fix was kept. Invalid, out-of-order, or hopeless-accuracy fixes
// are dropped; time is stored relative to startedAtMs.
export function addFix(rec, fix) {
  const { timeMs, lat, lon, speed, accuracy } = fix;
  if (!Number.isFinite(timeMs) || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  if (accuracy != null && Number.isFinite(accuracy) && accuracy > MAX_ACC_M) return false;
  const t = (timeMs - rec.startedAtMs) / 1000;
  if (t < 0) return false;
  const last = rec.fixes[rec.fixes.length - 1];
  if (last && t <= last[0]) return false;
  if (rec.fixes.length >= MAX_FIXES) return false;
  rec.fixes.push([
    round(t, 100),
    round(lat, 1e6),
    round(lon, 1e6),
    speed != null && Number.isFinite(speed) && speed >= 0 ? round(speed, 100) : null,
    accuracy != null && Number.isFinite(accuracy) ? round(accuracy, 10) : null,
  ]);
  return true;
}

export function elapsedS(rec, nowMs) {
  return Math.max(0, (nowMs - rec.startedAtMs) / 1000);
}

// Per-fix speed in m/s: the source's own speed when reported, else the
// displacement rate to the neighbouring fix (equirectangular meters — fine at
// track scale, same approximation as js/import/geo.js).
export function fixSpeeds(fixes) {
  if (!fixes.length) return [];
  const kx = 111320 * Math.cos((fixes[0][1] * Math.PI) / 180);
  const ky = 110540;
  return fixes.map((f, i) => {
    if (f[3] != null) return f[3];
    const a = fixes[Math.max(0, i - 1)];
    const b = fixes[Math.min(fixes.length - 1, i + 1)];
    const dt = b[0] - a[0];
    if (dt <= 0) return 0;
    const dx = (b[2] - a[2]) * kx;
    const dy = (b[1] - a[1]) * ky;
    return Math.hypot(dx, dy) / dt;
  });
}

// Should the recorder stop itself? Two triggers:
//  - the car was driven at track pace at some point and has now been
//    stationary for AUTO_STOP_IDLE_S (driver forgot to stop after the
//    session) — a pre-session grid wait never trips this because nothing
//    fast has been seen yet;
//  - the hard duration cap, driven or not.
export function shouldAutoStop(rec, nowMs, opts = {}) {
  const { idleS = AUTO_STOP_IDLE_S, drivenMps = DRIVEN_MPS, idleMps = IDLE_MPS, maxS = MAX_DURATION_S } = opts;
  if (elapsedS(rec, nowMs) > maxS) return true;
  const speeds = fixSpeeds(rec.fixes);
  let driven = false;
  let lastMovingT = 0;
  for (let i = 0; i < speeds.length; i++) {
    if (speeds[i] >= drivenMps) driven = true;
    if (speeds[i] >= idleMps) lastMovingT = rec.fixes[i][0];
  }
  if (!driven) return false;
  return elapsedS(rec, nowMs) - lastMovingT > idleS;
}

// Cut the stationary paddock/grid tails off the fix list, keeping marginS of
// context on each side so the out-lap start and cool-down are preserved.
export function trimIdle(fixes, { idleMps = IDLE_MPS, marginS = 30 } = {}) {
  if (fixes.length < 2) return fixes;
  const speeds = fixSpeeds(fixes);
  let first = -1;
  let last = -1;
  for (let i = 0; i < speeds.length; i++) {
    if (speeds[i] >= idleMps) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return [];
  const t0 = fixes[first][0] - marginS;
  const t1 = fixes[last][0] + marginS;
  return fixes.filter((f) => f[0] >= t0 && f[0] <= t1);
}

// A recording as a parsed-import object (the js/import/parse.js contract):
// {kind, date, time, durationS, laps: [], gps, needsLine: true}. The review
// panel's line picker then derives laps from start/finish crossings exactly
// as for a GoPro or plain-VBO file. Returns null when there's too little
// data to time anything.
export function toParsed(rec) {
  const fixes = trimIdle(rec.fixes);
  if (fixes.length < 30) return null;
  const gps = fixes.map((f) => ({ t: f[0], lat: f[1], lon: f[2], v: f[3] ?? undefined }));
  const durationS = gps[gps.length - 1].t - gps[0].t;
  if (durationS < 60) return null;
  const d = new Date(rec.startedAtMs);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    kind: "live",
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    durationS,
    laps: [],
    gps,
    needsLine: true,
  };
}

// Checkpoint (de)serialization. deserialize returns null for anything that
// isn't a plausible recording — a corrupt checkpoint must not crash boot.
export function serializeRecording(rec) {
  return JSON.stringify(rec);
}

export function deserializeRecording(json) {
  if (!json) return null;
  try {
    const rec = JSON.parse(json);
    if (rec?.v !== RECORDING_V || !Number.isFinite(rec.startedAtMs) || !Array.isArray(rec.fixes)) return null;
    if (!rec.fixes.every((f) => Array.isArray(f) && f.length >= 3 && f.every((x) => x == null || Number.isFinite(x)))) {
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}
