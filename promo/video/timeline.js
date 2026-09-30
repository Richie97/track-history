// A seekable timeline: every animated property is a pure function of time,
// so any frame can be laid out exactly, in any order — which is what lets
// render.mjs step through the video frame by frame and screenshot each one.
// Nothing here runs on the wall clock, and the page disables CSS
// transitions and animations outright.

export const ease = {
  linear: (p) => p,
  inQuad: (p) => p * p,
  outQuad: (p) => 1 - (1 - p) * (1 - p),
  inOutQuad: (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2),
  inCubic: (p) => p * p * p,
  outCubic: (p) => 1 - (1 - p) ** 3,
  inOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2),
  outQuart: (p) => 1 - (1 - p) ** 4,
  inOutQuart: (p) => (p < 0.5 ? 8 * p ** 4 : 1 - (-2 * p + 2) ** 4 / 2),
  outExpo: (p) => (p === 1 ? 1 : 1 - 2 ** (-10 * p)),
  inOutExpo: (p) => (p === 0 ? 0 : p === 1 ? 1 : p < 0.5 ? 2 ** (20 * p - 10) / 2 : (2 - 2 ** (-20 * p + 10)) / 2),
  inExpo: (p) => (p === 0 ? 0 : 2 ** (10 * p - 10)),
  outBack: (p) => 1 + 2.7 * (p - 1) ** 3 + 1.7 * (p - 1) ** 2,
  outBackSoft: (p) => 1 + 2.2 * (p - 1) ** 3 + 1.2 * (p - 1) ** 2,
};

export const clamp01 = (p) => Math.max(0, Math.min(1, p));
export const lerp = (a, b, p) => a + (b - a) * p;

// Transform-ish properties are composed into one transform string, in this
// order; everything else maps to a style property.
const BASE = { x: 0, y: 0, z: 0, scale: 1, sx: 1, sy: 1, rotate: 0, rx: 0, ry: 0, skew: 0, opacity: 1, blur: 0 };

export class Timeline {
  constructor() {
    this.tweens = new Map(); // el -> [{prop, from, to, t0, dur, ease}]
    this.calls = [];
    this.scenes = [];
  }

  // Animate `props` ({ name: [from, to] }) on an element (or a selector /
  // list) from t0 over dur seconds. Before its first tween starts an element
  // holds that tween's `from`; after the last ends it holds the `to`.
  to(target, props, t0, dur = 0.6, easing = "outCubic") {
    const els = typeof target === "string" ? [...document.querySelectorAll(target)] : Array.isArray(target) ? target : [target];
    if (!els.length) console.warn("no element for", target);
    const fn = typeof easing === "function" ? easing : ease[easing];
    for (const el of els) {
      if (!this.tweens.has(el)) this.tweens.set(el, []);
      for (const [prop, v] of Object.entries(props)) {
        const [from, to] = Array.isArray(v) ? v : [v, v];
        this.tweens.get(el).push({ prop, from, to, t0, dur: Math.max(dur, 1e-6), ease: fn });
      }
    }
    return this;
  }

  // Stagger the same tween across a list of elements.
  stagger(target, props, t0, each, dur, easing) {
    const els = typeof target === "string" ? [...document.querySelectorAll(target)] : target;
    els.forEach((el, i) => this.to(el, props, t0 + i * each, dur, easing));
    return this;
  }

  // A procedural animation: fn(p, t) with p the eased progress through
  // [t0, t0 + dur], called every frame (clamped outside the window).
  call(fn, t0, dur = 1, easing = "linear") {
    this.calls.push({ fn, t0, dur: Math.max(dur, 1e-6), ease: ease[easing] ?? easing });
    return this;
  }

  scene(el, t0, t1) {
    this.scenes.push({ el, t0, t1 });
    return this;
  }

  seek(t) {
    for (const s of this.scenes) s.el.style.display = t >= s.t0 && t < s.t1 ? "" : "none";
    for (const [el, list] of this.tweens) {
      const state = {};
      const seen = new Set();
      // tweens apply in start order; a later one that has started wins
      const sorted = list.slice().sort((a, b) => a.t0 - b.t0);
      for (const tw of sorted) {
        if (tw.t0 <= t) {
          const p = tw.ease(clamp01((t - tw.t0) / tw.dur));
          state[tw.prop] = typeof tw.from === "number" ? lerp(tw.from, tw.to, p) : p < 1 ? tw.from : tw.to;
          seen.add(tw.prop);
        } else if (!seen.has(tw.prop)) {
          state[tw.prop] = tw.from;
          seen.add(tw.prop);
        }
      }
      apply(el, state);
    }
    for (const c of this.calls) c.fn(c.ease(clamp01((t - c.t0) / c.dur)), t);
  }
}

function apply(el, s) {
  const v = { ...BASE, ...s };
  const hasTransform = ["x", "y", "z", "scale", "sx", "sy", "rotate", "rx", "ry", "skew"].some((k) => k in s);
  if (hasTransform) {
    el.style.transform =
      `translate3d(${v.x}px, ${v.y}px, ${v.z}px)` +
      (v.rx ? ` rotateX(${v.rx}deg)` : "") +
      (v.ry ? ` rotateY(${v.ry}deg)` : "") +
      (v.rotate ? ` rotate(${v.rotate}deg)` : "") +
      (v.skew ? ` skewX(${v.skew}deg)` : "") +
      ` scale(${v.scale * v.sx}, ${v.scale * v.sy})`;
  }
  if ("opacity" in s) el.style.opacity = String(Math.max(0, Math.min(1, v.opacity)));
  if ("blur" in s) el.style.filter = v.blur > 0.01 ? `blur(${v.blur}px)` : "none";
  if ("clip" in s) {
    // [top, right, bottom, left] in percent
    const c = s.clip;
    el.style.clipPath = `inset(${c[0]}% ${c[1]}% ${c[2]}% ${c[3]}%)`;
  }
  for (const k of ["clipT", "clipR", "clipB", "clipL"]) if (k in s) el.style.setProperty(`--${k}`, `${s[k]}%`);
  for (const [k, val] of Object.entries(s)) {
    if (k.startsWith("--")) el.style.setProperty(k, String(val));
    else if (k === "width" || k === "height" || k === "left" || k === "top") el.style[k] = `${val}px`;
  }
}
