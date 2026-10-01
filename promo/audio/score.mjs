// The promo's score, synthesised: 120 BPM in A minor, on the same two-second
// bars the video cuts on, so every scene change lands on a downbeat. No
// samples, no dependencies — oscillators, filters, a Freeverb and a delay —
// written to out/score.wav (48 kHz stereo). render.mjs loudness-normalises it
// when it muxes.
//
// The arrangement follows the film: a stopwatch tick under the cold open, a
// ping when the lap locks in, an impact on the logo, the groove from the
// logbook scene, a peak for the analysis montage, a breakdown under the AI
// chat, and the loop resolving G → Am on the closing card.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "out");
const SR = 48000;
const LENGTH = 84;
const N = Math.ceil((LENGTH + 0.5) * SR);
const BAR = 2, BEAT = 0.5;
const TAU = Math.PI * 2;

// Scene boundaries (see video/promo.js) — where the wipes and hits are.
const WIPES = [18, 32, 38, 52, 64, 74, 78];
const CUTS = [10, 24, 58, 70];

// ------------------------------------------------------------ primitives ---

let seed = 0x2f6b1a3d;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const noise = () => rand() * 2 - 1;
const midi = (m) => 440 * 2 ** ((m - 69) / 12);

// Band-limited sawtooth (polyBLEP), phase in [0, 1).
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
const saw = (ph, dt) => 2 * ph - 1 - blep(ph, dt);

// RBJ biquad, coefficients recomputed on demand (cheap enough per block).
class Biquad {
  constructor(type, f, q = 0.707) { this.type = type; this.z1 = this.z2 = 0; this.set(f, q); }
  set(f, q = this.q) {
    this.q = q;
    const w = (TAU * Math.min(f, SR * 0.45)) / SR, c = Math.cos(w), a = Math.sin(w) / (2 * q);
    let b0, b1, b2;
    if (this.type === "lp") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
    else if (this.type === "hp") { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    else { b0 = a; b1 = 0; b2 = -a; } // band-pass, 0 dB peak
    const a0 = 1 + a;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = (-2 * c) / a0; this.a2 = (1 - a) / a0;
  }
  run(x) {
    // transposed direct form II
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

// Buses: dry, and sends to the reverb and the delay.
const bus = () => ({ L: new Float32Array(N), R: new Float32Array(N) });
const DRY = bus(), VERB = bus(), ECHO = bus();
const DUCK = { L: new Float32Array(N), R: new Float32Array(N) }; // ducked by the kick
const kickTimes = [];

// Write a mono signal (fn(i, t) → sample) at t0 for dur seconds.
function voice(t0, dur, fn, { gain = 1, pan = 0, to = DRY, verb = 0, echo = 0, duck = false } = {}) {
  const i0 = Math.max(0, Math.round(t0 * SR)), n = Math.min(N - i0, Math.round(dur * SR));
  const gl = Math.cos(((pan + 1) * Math.PI) / 4) * gain, gr = Math.sin(((pan + 1) * Math.PI) / 4) * gain;
  const dest = duck ? DUCK : to;
  for (let i = 0; i < n; i++) {
    const s = fn(i, i / SR);
    dest.L[i0 + i] += s * gl; dest.R[i0 + i] += s * gr;
    if (verb) { VERB.L[i0 + i] += s * gl * verb; VERB.R[i0 + i] += s * gr * verb; }
    if (echo) { ECHO.L[i0 + i] += s * gl * echo; ECHO.R[i0 + i] += s * gr * echo; }
  }
}

// ------------------------------------------------------------ instruments ---

function kick(t0, g = 1) {
  kickTimes.push(t0);
  let ph = 0;
  const hp = new Biquad("hp", 1500);
  voice(t0, 0.5, (i, t) => {
    const f = 46 + 120 * Math.exp(-t / 0.028);
    ph += f / SR;
    const body = Math.sin(TAU * ph) * Math.exp(-t / 0.2) * Math.min(1, t / 0.0015);
    const click = hp.run(noise()) * Math.exp(-t / 0.004) * 0.35;
    return Math.tanh((body + click) * 1.4);
  }, { gain: 0.7 * g });
}

function clap(t0, g = 1, pan = 0) {
  const bp = new Biquad("bp", 1250, 0.9), hp = new Biquad("hp", 650);
  voice(t0, 0.45, (i, t) => {
    let e = 0;
    for (const d of [0, 0.011, 0.023]) if (t >= d) e += Math.exp(-(t - d) / 0.0055);
    e = 0.45 * e + Math.exp(-t / 0.13) * 0.9;
    const body = Math.sin(TAU * 190 * t) * Math.exp(-t / 0.06) * 0.25;
    return hp.run(bp.run(noise())) * e * 1.6 + body;
  }, { gain: 0.3 * g, pan, verb: 0.35 });
}

function hat(t0, open = false, g = 1, pan = 0) {
  const hp = new Biquad("hp", 7200, 0.8), bp = new Biquad("bp", 10500, 0.7);
  const d = open ? 0.24 : 0.034;
  voice(t0, open ? 0.6 : 0.12, (i, t) => {
    const x = noise();
    return (hp.run(x) * 0.6 + bp.run(x) * 0.8) * Math.exp(-t / d);
  }, { gain: (open ? 0.085 : 0.1) * g, pan, verb: open ? 0.12 : 0.03 });
}

function crash(t0, g = 1) {
  const hp = new Biquad("hp", 3200, 0.6), hp2 = new Biquad("hp", 5200, 0.6);
  voice(t0, 3.2, (i, t) => (hp.run(noise()) * 0.5 + hp2.run(noise()) * 0.5) * Math.exp(-t / 1.05) * Math.min(1, t / 0.003),
    { gain: 0.1 * g, pan: 0.25, verb: 0.3 });
}

// The line sits an octave above the root so a laptop or a phone can play it;
// the sine underneath keeps some weight on speakers that reach that low.
function bass(f, t0, dur, g = 1) {
  let ph = 0, ph2 = 0;
  const lp = new Biquad("lp", 400, 1.1);
  const f2 = f * 2;
  voice(t0, dur + 0.06, (i, t) => {
    if (i % 32 === 0) lp.set(320 + 1600 * Math.exp(-t / 0.1), 1.2);
    ph = (ph + f2 / SR) % 1; ph2 = (ph2 + f / SR) % 1;
    const x = saw(ph, f2 / SR) * 0.8 + Math.sin(TAU * ph2) * 0.28;
    const env = Math.min(1, t / 0.004) * (t < dur ? 1 : Math.exp(-(t - dur) / 0.015));
    return lp.run(x) * env;
  }, { gain: 0.3 * g, duck: true });
}

// A pad chord: three detuned band-limited saws per note, filtered, with a
// slow swell in and out.
function pad(freqs, t0, dur, { g = 1, cutoff = 1500, cutoffEnd = null, pan = 0 } = {}) {
  const att = 0.5, rel = 0.9;
  freqs.forEach((f, ni) => {
    [-9, 0, 8].forEach((cents, vi) => {
      const fr = f * 2 ** (cents / 1200);
      let ph = rand();
      const lp = new Biquad("lp", cutoff, 0.6), hp = new Biquad("hp", 170, 0.7);
      const p = [-0.55, 0, 0.55][vi] * 0.9 + pan;
      voice(t0, dur + rel, (i, t) => {
        if (i % 64 === 0) {
          const c = cutoffEnd == null ? cutoff : cutoff + (cutoffEnd - cutoff) * Math.min(1, t / dur);
          lp.set(c * (1 + 0.12 * Math.sin(TAU * 0.13 * (t0 + t) + ni)), 0.6);
        }
        ph = (ph + fr / SR) % 1;
        const env = Math.min(1, t / att) * (t < dur ? 1 : Math.exp(-(t - dur) / (rel / 3)));
        return hp.run(lp.run(saw(ph, fr / SR))) * env;
      }, { gain: 0.045 * g, pan: p, verb: 0.35, duck: true });
    });
  });
}

function pluck(f, t0, g = 1, pan = 0, bright = 1) {
  let ph = 0, ph2 = 0.25;
  const lp = new Biquad("lp", 2000, 0.9);
  voice(t0, 0.5, (i, t) => {
    if (i % 32 === 0) lp.set((500 + 2800 * Math.exp(-t / 0.07)) * bright, 0.9);
    ph = (ph + f / SR) % 1; ph2 = (ph2 + (f * 1.004) / SR) % 1;
    const x = saw(ph, f / SR) * 0.6 + (ph2 < 0.5 ? 1 : -1) * 0.25;
    return lp.run(x) * Math.exp(-t / 0.17) * Math.min(1, t / 0.002);
  }, { gain: 0.11 * g, pan, verb: 0.22, echo: 0.32 });
}

// FM bell.
function bell(f, t0, g = 1, pan = 0, dur = 2.4) {
  voice(t0, dur, (i, t) => {
    const I = 2.1 * Math.exp(-t / 0.22) + 0.3;
    return Math.sin(TAU * f * t + I * Math.sin(TAU * f * 3.5 * t)) * Math.exp(-t / 0.85) * Math.min(1, t / 0.002);
  }, { gain: 0.11 * g, pan, verb: 0.5, echo: 0.15 });
}

function impact(t0, g = 1) {
  let ph = 0;
  const lp = new Biquad("lp", 900, 0.7);
  voice(t0, 2.5, (i, t) => {
    const f = 32 + 34 * Math.exp(-t / 0.35);
    ph += f / SR;
    const sub = Math.sin(TAU * ph) * Math.exp(-t / 0.75);
    const thump = lp.run(noise()) * Math.exp(-t / 0.18) * 0.9;
    return Math.tanh((sub + thump) * 1.2) * Math.min(1, t / 0.002);
  }, { gain: 0.75 * g, verb: 0.25 });
  crash(t0, 0.9 * g);
}

// Band-passed noise rising into a hit.
function riser(t0, t1, g = 1) {
  const dur = t1 - t0;
  const bp = new Biquad("bp", 400, 1.4), bp2 = new Biquad("bp", 400, 1.4);
  voice(t0, dur, (i, t) => {
    const p = t / dur;
    if (i % 32 === 0) { const c = 350 * (7200 / 350) ** p; bp.set(c, 1.4); bp2.set(c * 1.5, 1.8); }
    return (bp.run(noise()) + bp2.run(noise()) * 0.6) * p * p;
  }, { gain: 0.35 * g, verb: 0.3 });
}

// A wipe: noise swept through a band and across the stereo field.
function whoosh(tc, g = 1) {
  const dur = 0.8, t0 = tc - 0.42;
  const bp = new Biquad("bp", 800, 1.1);
  const i0 = Math.round(t0 * SR), n = Math.round(dur * SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR, p = t / dur;
    if (i % 32 === 0) bp.set(600 * (5000 / 600) ** Math.sin(Math.PI * p), 1.1);
    const s = bp.run(noise()) * Math.sin(Math.PI * p) ** 2 * 0.2 * g;
    const pan = -0.8 + 1.6 * p;
    const gl = Math.cos(((pan + 1) * Math.PI) / 4), gr = Math.sin(((pan + 1) * Math.PI) / 4);
    if (i0 + i >= 0 && i0 + i < N) { DRY.L[i0 + i] += s * gl; DRY.R[i0 + i] += s * gr; VERB.L[i0 + i] += s * 0.2; VERB.R[i0 + i] += s * 0.2; }
  }
}

// A stopwatch tick.
function tick(t0, g = 1, pan = 0) {
  voice(t0, 0.03, (i, t) => Math.sin(TAU * 3800 * t) * Math.exp(-t / 0.004), { gain: 0.11 * g, pan });
}

// --------------------------------------------------------------- harmony ---

// A minor: i – VI – III – VII, phased so the logo (bar 3), the analysis hit
// (bar 19) and Wrapped (bar 35) land on Am, and the last card resolves to it.
const CHORDS = {
  Am: { bass: midi(33), pad: [57, 60, 64, 69].map(midi), arp: [69, 72, 76, 81].map(midi) },
  F: { bass: midi(29), pad: [53, 57, 60, 65].map(midi), arp: [65, 69, 72, 77].map(midi) },
  C: { bass: midi(36), pad: [55, 60, 64, 67].map(midi), arp: [67, 72, 76, 79].map(midi) },
  G: { bass: midi(31), pad: [55, 59, 62, 67].map(midi), arp: [67, 71, 74, 79].map(midi) },
};
const LOOP = ["Am", "F", "C", "G"];
const chordAt = (b) => (b >= 39 ? ["Am", "F", "Am"][Math.min(2, b - 39)] : LOOP[(b + 1) % 4]);

// ----------------------------------------------------------- arrangement ---

const BARS = Math.ceil(LENGTH / BAR);
for (let b = 0; b < BARS; b++) {
  const t = b * BAR;
  const c = CHORDS[chordAt(b)];
  const section =
    t < 6 ? "intro" : t < 10 ? "brand" : t < 18 ? "grooveA" : t < 38 ? "grooveB" : t < 52 ? "peak"
      : t < 64 ? "grooveC" : t < 70 ? "breakdown" : t < 78 ? "finale" : "outro";

  // pads everywhere; the intro opens its filter as the lap is drawn
  if (section === "intro") pad(c.pad, t, BAR, { g: 1.5, cutoff: 600 + t * 220, cutoffEnd: 600 + (t + 2) * 220 });
  else if (section === "outro") pad(c.pad, t, BAR, { g: 1.05, cutoff: 1700 });
  else pad(c.pad, t, BAR, { g: section === "breakdown" ? 1.15 : 0.85, cutoff: section === "peak" || section === "finale" ? 2100 : 1600 });

  const drums = ["grooveA", "grooveB", "peak", "grooveC", "finale"].includes(section);
  if (drums) {
    for (let q = 0; q < 4; q++) kick(t + q * BEAT, q === 0 ? 1 : 0.92);
    for (let e = 0; e < 8; e++) hat(t + e * 0.25, false, e % 2 ? 1 : 0.7, e % 2 ? 0.2 : -0.1);
    if (section !== "grooveA") { clap(t + BEAT, 1, -0.05); clap(t + 3 * BEAT, 1, 0.05); }
    if (section === "peak" || section === "finale") for (let q = 0; q < 4; q++) hat(t + q * BEAT + 0.25, true, 0.9, 0.3);
    const pat = [0, 0, 12, 0, 0, 0, 12, 0], vel = [1, 0.7, 0.85, 0.7, 1, 0.7, 0.85, 0.75];
    for (let e = 0; e < 8; e++) bass(c.bass * 2 ** (pat[e] / 12), t + e * 0.25, 0.21, vel[e]);
  }
  if (section === "breakdown") {
    bass(c.bass, t, BAR - 0.05, 0.8);
    for (let s = 0; s < 16; s++) hat(t + s * 0.125, false, 0.35 + 0.15 * (s % 4 === 0), s % 2 ? 0.35 : -0.35);
  }
  if (section === "brand") bass(c.bass, t, BAR - 0.1, 0.55);

  // arpeggios from the progress scene on; filtered down under the AI chat
  if (["grooveB", "peak", "grooveC", "breakdown", "finale"].includes(section)) {
    const order = [0, 1, 2, 3, 2, 1, 0, 1, 0, 1, 2, 3, 2, 3, 2, 1];
    const bright = section === "breakdown" ? 0.45 : section === "peak" || section === "finale" ? 1.15 : 0.9;
    const g = section === "grooveC" ? 0.8 : 1;
    for (let s = 0; s < 16; s++) pluck(c.arp[order[s]], t + s * 0.125, (s % 4 === 0 ? 1 : 0.72) * g, s % 2 ? 0.3 : -0.3, bright);
  }
}

// A low A under the cold open, swelling into the logo.
{
  let ph = 0, ph2 = 0;
  voice(0, 6.1, (i, t) => {
    ph = (ph + 110 / SR) % 1; ph2 = (ph2 + 110.4 / SR) % 1;
    const env = Math.min(1, t / 1.5) * (0.55 + 0.45 * (t / 6)) * (t > 5.95 ? Math.max(0, 1 - (t - 5.95) / 0.15) : 1);
    return (Math.sin(TAU * ph) + 0.5 * Math.sin(TAU * 2 * ph2) + 0.2 * saw(ph2, 110 / SR)) * env;
  }, { gain: 0.07, verb: 0.2 });
}

// The cold open's stopwatch, and the lap locking in.
for (let s = 0; s * 0.125 < 4.65; s++) tick(0.45 + s * 0.125, s % 4 === 0 ? 1.2 : 0.7, s % 2 ? 0.4 : -0.4);
bell(midi(81), 5.1, 1.1, -0.15);
bell(midi(88), 5.1, 0.6, 0.2);
// a reversed swell into the logo, and the hit
riser(4.2, 6.0, 0.8);
impact(6.0, 1);
bell(midi(76), 6.05, 0.5, -0.2);
bell(midi(81), 6.05, 0.45, 0.2);
riser(8.5, 10.0, 0.7);

// fills into the section changes, and hits on them
function fill(t0, t1) {
  for (let t = t0; t < t1 - 1e-6; t += 0.125) clap(t, 0.25 + 0.6 * ((t - t0) / (t1 - t0)), (t * 8) % 2 ? 0.2 : -0.2);
}
fill(17, 18);
fill(37, 38);
riser(36.0, 38.0, 0.9);
impact(38.0, 0.9);
riser(68.0, 70.0, 0.9);
crash(70.0, 1);
fill(77, 78);
riser(76.5, 78.0, 0.8);
impact(78.0, 1.05);
// the closing motif
[[76, 78.15], [81, 78.3], [84, 78.45], [88, 78.6]].forEach(([m, t], i) => bell(midi(m), t, 0.75 - i * 0.08, -0.3 + i * 0.2));
bell(midi(81), 80.0, 0.5, 0);
bell(midi(76), 82.0, 0.4, 0);
WIPES.forEach((t) => whoosh(t, 1));
CUTS.forEach((t) => whoosh(t, 0.55));

// ----------------------------------------------------------------- effects ---

// Sidechain: the kick ducks the pads and bass, the pump every club track has.
{
  const env = new Float32Array(N);
  for (const tk of kickTimes) {
    const i0 = Math.round(tk * SR);
    for (let i = 0; i < SR * 0.4 && i0 + i < N; i++) env[i0 + i] = Math.max(env[i0 + i], Math.exp(-i / SR / 0.11));
  }
  for (let i = 0; i < N; i++) {
    const g = 1 - 0.5 * env[i];
    DRY.L[i] += DUCK.L[i] * g; DRY.R[i] += DUCK.R[i] * g;
  }
}

// Ping-pong delay, dotted eighth, darkened on each repeat.
{
  const d = Math.round(0.375 * SR);
  const lpL = new Biquad("lp", 3500), lpR = new Biquad("lp", 3500);
  const bL = new Float32Array(N), bR = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const inL = ECHO.L[i] + (i >= d ? lpR.run(bR[i - d]) * 0.42 : 0);
    const inR = ECHO.R[i] * 0.3 + (i >= d ? lpL.run(bL[i - d]) * 0.42 : 0);
    bL[i] = inL; bR[i] = inR;
    DRY.L[i] += (i >= d ? bL[i - d] : 0) * 0.34;
    DRY.R[i] += (i >= d ? bR[i - d] : 0) * 0.34;
  }
}

// Freeverb: eight damped combs and four all-passes per side.
{
  const combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((x) => Math.round((x * SR) / 44100));
  const apT = [556, 441, 341, 225].map((x) => Math.round((x * SR) / 44100));
  const room = 0.86, damp = 0.35;
  for (const [src, dst, spread] of [[VERB.L, DRY.L, 0], [VERB.R, DRY.R, 23]]) {
    const combs = combT.map((n) => ({ buf: new Float32Array(n + spread), i: 0, lp: 0 }));
    const aps = apT.map((n) => ({ buf: new Float32Array(n + spread), i: 0 }));
    const pre = new Biquad("hp", 250);
    for (let i = 0; i < N; i++) {
      const x = pre.run(src[i]) * 0.015;
      let out = 0;
      for (const c of combs) {
        const y = c.buf[c.i];
        c.lp = y * (1 - damp) + c.lp * damp;
        c.buf[c.i] = x + c.lp * room;
        c.i = (c.i + 1) % c.buf.length;
        out += y;
      }
      for (const a of aps) {
        const b = a.buf[a.i];
        a.buf[a.i] = out + b * 0.5;
        out = b - out;
        a.i = (a.i + 1) % a.buf.length;
      }
      dst[i] += out * 2.2;
    }
  }
}

// ------------------------------------------------------------------ master ---

// Gentle bus compression, a soft clip, a fade at the end, then peak -1 dBFS.
{
  let env = 0;
  const atk = Math.exp(-1 / (0.01 * SR)), rel = Math.exp(-1 / (0.2 * SR));
  const thr = 0.3, ratio = 2.2;
  const fadeFrom = Math.round((LENGTH - 1.6) * SR), fadeTo = Math.round(LENGTH * SR);
  let peak = 0;
  for (let i = 0; i < N; i++) {
    const lvl = Math.max(Math.abs(DRY.L[i]), Math.abs(DRY.R[i]));
    env = lvl > env ? atk * env + (1 - atk) * lvl : rel * env + (1 - rel) * lvl;
    const g = env > thr ? (thr / env) ** (1 - 1 / ratio) : 1;
    const fade = i < fadeFrom ? 1 : i >= fadeTo ? 0 : 1 - (i - fadeFrom) / (fadeTo - fadeFrom);
    DRY.L[i] = Math.tanh(DRY.L[i] * g * 1.3) * fade;
    DRY.R[i] = Math.tanh(DRY.R[i] * g * 1.3) * fade;
    peak = Math.max(peak, Math.abs(DRY.L[i]), Math.abs(DRY.R[i]));
  }
  const norm = 0.891 / peak;
  const n = Math.round(LENGTH * SR);
  const pcm = Buffer.alloc(44 + n * 4);
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + n * 4, 4); pcm.write("WAVE", 8);
  pcm.write("fmt ", 12); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(2, 22);
  pcm.writeUInt32LE(SR, 24); pcm.writeUInt32LE(SR * 4, 28); pcm.writeUInt16LE(4, 32); pcm.writeUInt16LE(16, 34);
  pcm.write("data", 36); pcm.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, DRY.L[i] * norm)) * 32767), 44 + i * 4);
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, DRY.R[i] * norm)) * 32767), 46 + i * 4);
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "score.wav"), pcm);
  console.log(`wrote out/score.wav (${LENGTH}s, peak normalised from ${peak.toFixed(2)})`);
}
