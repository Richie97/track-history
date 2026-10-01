// The Track Evolution promo: 84 seconds on a 120 BPM grid (one bar = 2 s),
// every scene built from screens filmed in the real app (capture.mjs) and
// the facts it exported (out/data.json). render.mjs seeks this page frame
// by frame; open it in a browser with ?t=<seconds> to look at one moment.

import { Timeline, clamp01, lerp } from "./timeline.js";
import { fmtMs } from "../../public/js/format.js";

const data = await (await fetch("../out/data.json")).json();
// Headlines are measured to fit their column, so Geist has to be in first.
await Promise.all(["700 90px Geist", "600 40px Geist", "500 40px Geist", "400 30px Geist", "500 40px \"Geist Mono\""].map((f) => document.fonts.load(f)));
const SHOT = (n) => `../out/screens/${n}.png`;
const W = 1920, H = 1080;
export const DURATION = 84;
const tl = new Timeline();
const $scenes = document.getElementById("scenes");

// ---------------------------------------------------------------- helpers ---

function el(tag, attrs = {}, parent) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") Object.assign(e.style, v);
    else if (k === "html") e.innerHTML = v;
    else if (k === "text") e.textContent = v;
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  if (parent) parent.appendChild(e);
  return e;
}
const px = (v) => `${v}px`;
const at = (x, y, extra = {}) => ({ left: px(x), top: px(y), ...extra });

function scene(id, t0, t1) {
  const s = el("section", { class: "scene", id }, $scenes);
  tl.scene(s, t0, t1);
  return s;
}

const fmtLap = (ms) => {
  const m = Math.floor(ms / 60000);
  const s = (ms % 60000) / 1000;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
};
const mph = (kph) => kph / 1.609344;

// "Every track day./Every *lap.*" — lines split on "/", *…* in lime.
function headline(parent, text, { x, y, size = 88, width, cls = "headline", fit = width ? null : 600 }) {
  const h = el("div", { class: `abs ${cls}`, style: at(x, y, { fontSize: px(size), width: width ? px(width) : "auto" }) }, parent);
  const words = [];
  let accent = false;
  for (const line of text.split("/")) {
    const lineEl = el("div", {}, h);
    const tokens = line.split(" ");
    tokens.forEach((tok, i) => {
      let t = tok;
      if (t.startsWith("*")) { accent = true; t = t.slice(1); }
      let closes = false;
      if (t.endsWith("*")) { closes = true; t = t.slice(0, -1); }
      words.push(el("span", { class: `w${accent ? " accent" : ""}`, text: t + (i < tokens.length - 1 ? " " : "") }, lineEl));
      if (closes) accent = false;
    });
  }
  // shrink to the column: the left text column is 600 px wide
  if (fit && h.offsetWidth > fit) h.style.fontSize = px(Math.floor(size * (fit / h.offsetWidth)));
  return { el: h, words };
}

// Words rise into place, a beat apart.
function rise(words, t0, { each = 0.055, dur = 0.75, dy = 48, blur = 12 } = {}) {
  words.forEach((w, i) => tl.to(w, { opacity: [0, 1], y: [dy, 0], blur: [blur, 0] }, t0 + i * each, dur, "outQuart"));
}
// …and leave together.
function leave(targets, t0, dur = 0.4) {
  for (const t of [].concat(targets)) tl.to(t, { opacity: [1, 0], y: [0, -24], blur: [0, 10] }, t0, dur, "inCubic");
}
function appear(target, t0, { dur = 0.7, dy = 30, dx = 0, scale = 1, blur = 8, easing = "outQuart" } = {}) {
  tl.to(target, { opacity: [0, 1], y: [dy, 0], x: [dx, 0], scale: [scale, 1], blur: [blur, 0] }, t0, dur, easing);
}

function eyebrow(parent, text, x, y) {
  return el("div", { class: "abs eyebrow", text, style: at(x, y) }, parent);
}
function sub(parent, html, x, y, width) {
  return el("div", { class: "abs sub", html, style: at(x, y, { width: px(width) }) }, parent);
}
function tag(kind) {
  return `<span class="tag${kind === "PRO" ? " pro" : ""}">${kind}</span>`;
}
function caption(parent, html, x, y, width, tags = []) {
  const c = el("div", { class: "abs caption", style: at(x, y, { width: px(width) }) }, parent);
  el("div", { class: "sub", html, style: { fontSize: "27px", flex: "1" } }, c);
  if (tags.length) el("div", { html: tags.map(tag).join(" "), style: { display: "flex", gap: "10px", flex: "none" } }, c);
  return c;
}

// Screens, preloaded with their CSS size (desktop captures are 2×, phone 3×).
const IMG = {};
async function preload(names) {
  await Promise.all(
    names.map(async (n) => {
      const im = new Image();
      // onload rather than decode(): decode() asks for every capture decoded
      // up front, and Chromium refuses some once they add up; painting
      // decodes what a frame shows.
      await new Promise((resolve, reject) => { im.onload = resolve; im.onerror = () => reject(new Error(`missing ${n}`)); im.src = SHOT(n); });
      const dsf = n.startsWith("m-") ? 3 : 2;
      IMG[n] = { w: im.naturalWidth / dsf, h: im.naturalHeight / dsf };
    })
  );
}

// Where to put an image (CSS size cw×ch) so `region` (in its CSS px) sits
// centred in a vw×vh window at `zoom` × the fit-to-width scale — clamped so
// the image always covers the window.
function focus(name, vw, vh, region, zoom = 1, base = null) {
  const { w: cw, h: ch } = IMG[name];
  const k = base ?? vw / cw;
  const s = k * zoom;
  const cx = region.x + region.w / 2, cy = region.y + region.h / 2;
  let x = vw / 2 - cx * s, y = vh / 2 - cy * s;
  x = Math.min(0, Math.max(vw - cw * s, x));
  y = Math.min(0, Math.max(vh - ch * s, y));
  return { x, y, scale: s };
}

function browserFrame(parent, { x, y, w, h, url, img }) {
  const root = el("div", { class: "browser", style: at(x, y, { width: px(w) }) }, parent);
  el("div", { class: "chrome", html: `<span class="dots"><i></i><i></i><i></i></span><span class="url">${url}</span><span style="width:52px"></span>` }, root);
  const vp = el("div", { class: "vp", style: { height: px(h) } }, root);
  const im = img ? el("img", { src: SHOT(img), style: { width: px(IMG[img].w) } }, vp) : null;
  return { root, vp, img: im, w, h };
}
function addImg(vp, name, extra = {}) {
  return el("img", { src: SHOT(name), style: { width: px(IMG[name].w), ...extra } }, vp);
}
function cardFrame(parent, { x, y, w, h, img }) {
  const root = el("div", { class: "card-frame", style: at(x, y, { width: px(w), height: px(h) }) }, parent);
  const crop = el("div", { class: "crop" }, root);
  const im = img ? addImg(crop, img) : null;
  return { root, crop, img: im, w, h };
}
function phoneFrame(parent, { x, y, w, h, img }) {
  const root = el("div", { class: "phone", style: at(x, y, { width: px(w), height: px(h) }) }, parent);
  const screen = el("div", { class: "screen" }, root);
  el("div", { class: "island" }, root);
  const im = img ? el("img", { src: SHOT(img), style: { top: "54px" } }, screen) : null;
  if (img) el("div", { class: "statusbar", html: `<span>9:41</span><span class="sb-icons"><i></i><i></i><b></b></span>` }, screen);
  return { root, screen, img: im, sw: w - 24, sh: h - 24 - 54 };
}
function pillLabel(parent, text, x, y) {
  return el("div", { class: "pill-label", html: `<span class="dot"></span>${text}`, style: at(x, y) }, parent);
}

// The PB lap's racing line (data.pb.trace: [x, y, speed] in metres), drawn
// as the app draws it — brighter is faster — with a head that moves at the
// lap's own pace: fast on the straights, slow into the hairpins.
function raceLine(parent, { x, y, w, h, width = 7, tarmac = true }) {
  const tr = data.pb.trace;
  const xs = tr.map((p) => p[0]), ys = tr.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const s = Math.min(w / (x1 - x0), h / (y1 - y0));
  const ox = x + (w - (x1 - x0) * s) / 2, oy = y + (h - (y1 - y0) * s) / 2;
  const pts = tr.map((p) => [ox + (p[0] - x0) * s, oy + (y1 - p[1]) * s, p[2]]);
  const vs = pts.map((p) => p[2]);
  const [vmin, vmax] = [Math.min(...vs), Math.max(...vs)];
  // cumulative lap time along the trace, normalised to 0..1
  const ts = [0];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(tr[i][0] - tr[i - 1][0], tr[i][1] - tr[i - 1][1]);
    ts.push(ts[i - 1] + d / Math.max(3, (tr[i][2] + tr[i - 1][2]) / 2));
  }
  const T = ts[ts.length - 1];
  const fr = ts.map((t) => t / T);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  parent.appendChild(svg);
  svg.setAttribute("class", "abs");
  Object.assign(svg.style, { left: "0", top: "0", width: px(W), height: px(H), overflow: "visible" });
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const mk = (tag, attrs, into = svg) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    into.appendChild(e);
    return e;
  };
  const poly = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const tarmacEl = tarmac ? mk("polyline", { points: poly, fill: "none", stroke: "rgba(255,255,255,0.075)", "stroke-width": width * 2.8, "stroke-linejoin": "round", "stroke-linecap": "round" }) : null;
  const defs = mk("defs", {});
  const f = mk("filter", { id: `glow${parent.id}`, x: "-20%", y: "-20%", width: "140%", height: "140%" }, defs);
  mk("feGaussianBlur", { stdDeviation: "6", result: "b" }, f);
  const merge = mk("feMerge", {}, f);
  mk("feMergeNode", { in: "b" }, merge);
  mk("feMergeNode", { in: "SourceGraphic" }, merge);
  const g = mk("g", { filter: `url(#glow${parent.id})` });
  const mix = (a, b, p) => Math.round(a + (b - a) * p);
  const segs = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = (pts[i][2] - vmin) / (vmax - vmin || 1);
    const col = `rgb(${mix(0x3a, 0xc8, p)},${mix(0x42, 0xf2, p)},${mix(0x1f, 0x4e, p)})`;
    segs.push(mk("line", { x1: pts[i][0], y1: pts[i][1], x2: pts[i + 1][0], y2: pts[i + 1][1], stroke: col, "stroke-width": width, "stroke-linecap": "round" }, g));
  }
  const halo = mk("circle", { r: width * 3.2, fill: "rgba(200,242,78,0.22)" });
  const head = mk("circle", { r: width * 1.25, fill: "#f6f6f7" });
  // progress in lap *time*
  function set(p) {
    p = clamp01(p);
    let i = 0;
    while (i < fr.length - 2 && fr[i + 1] < p) i++;
    const q = clamp01((p - fr[i]) / (fr[i + 1] - fr[i] || 1));
    segs.forEach((s, k) => {
      if (k < i) { s.setAttribute("visibility", "visible"); s.setAttribute("x2", pts[k + 1][0]); s.setAttribute("y2", pts[k + 1][1]); }
      else if (k === i) {
        s.setAttribute("visibility", p > 0 ? "visible" : "hidden");
        s.setAttribute("x2", lerp(pts[k][0], pts[k + 1][0], q));
        s.setAttribute("y2", lerp(pts[k][1], pts[k + 1][1], q));
      } else s.setAttribute("visibility", "hidden");
    });
    const hx = lerp(pts[i][0], pts[i + 1][0], q), hy = lerp(pts[i][1], pts[i + 1][1], q);
    for (const c of [halo, head]) { c.setAttribute("cx", hx); c.setAttribute("cy", hy); }
    return lerp(pts[i][2], pts[i + 1][2], q); // m/s at the head
  }
  return { svg, set, head, halo, tarmac: tarmacEl, g, pts };
}

// --------------------------------------------------------------- the cut ---

await preload([
  "dash", "m-dash", "track-chart", "track-chart-bare", "import-pick", "import-laps", "event-map",
  "panel-time", "panel-inputs", "panel-grip", "panel-car", "compare", "garage", "vehicle",
  "leaderboard", "coaching", "share", "event", "m-event",
  ...Array.from({ length: data.wrappedCards }, (_, i) => `m-wrapped-${i}`),
]);

const pbMs = data.pb.ms;
const firstMs = data.progression[0].best_ms;

// Background: the glow drifts across the whole film.
tl.call((p) => {
  const g = document.getElementById("bg-glow");
  g.style.setProperty("--gx", `${lerp(78, 22, p)}%`);
  g.style.setProperty("--gy", `${18 + 10 * Math.sin(p * Math.PI * 3)}%`);
}, 0, DURATION);
tl.to("#bg-grid", { opacity: [0, 1] }, 0.2, 1.4, "outQuad");

// Chapter wipes: a dark panel with a lime leading edge crosses the frame and
// covers the cut at its midpoint.
// The panel is skewed, so it parks well clear of the frame on both sides.
function wipe(tCut) {
  tl.to("#wipe", { x: [-3300, 2600] }, tCut - 0.38, 0.76, "inOutCubic");
}
function flash(t0, peak = 0.16) {
  tl.to("#flash", { opacity: [0, peak] }, t0, 0.06, "linear");
  tl.to("#flash", { opacity: [peak, 0] }, t0 + 0.06, 0.45, "outQuad");
}
tl.to("#wipe", { x: [-3300, -3300] }, 0, 0.01);

// ======================================================== 0 · cold open ===
{
  const s = scene("s0", 0, 6.02);
  const line = raceLine(s, { x: 820, y: 150, w: 1000, h: 780, width: 7 });
  const block = el("div", { class: "abs", style: at(130, 310) }, s);
  const eb = el("div", { class: "eyebrow", text: "Circuit of the Americas", style: { marginBottom: "22px" } }, block);
  const timer = el("div", { id: "s0-timer", text: "0:00.000" }, block);
  const pbLapNo = data.pbSessionLaps.indexOf(pbMs) + 1;
  const meta = el("div", { class: "stat-label", text: `Lap ${pbLapNo} · ${data.pb.session.replace(" — ", " · ")}`, style: { marginTop: "22px" } }, block);
  const speedRow = el("div", { style: { display: "flex", gap: "56px", marginTop: "54px" } }, block);
  const spd = el("div", { html: `<div class="stat-label">Speed</div><div class="stat-value" id="s0-speed">0 mph</div>` }, speedRow);
  const car = el("div", { html: `<div class="stat-label">Car</div><div class="stat-value" style="font-family:Geist;font-size:36px;margin-top:6px">2023 Corvette Z06</div>` }, speedRow);
  const pbPill = el("div", { class: "abs pb-pill", html: "★&nbsp; PERSONAL BEST", style: at(130, 750) }, s);

  appear(eb, 0.25, { dy: 16 });
  appear(timer, 0.35, { dy: 24, blur: 14 });
  appear(meta, 0.55, { dy: 16 });
  appear(speedRow, 0.7, { dy: 16 });
  tl.to(line.tarmac, { opacity: [0, 1] }, 0.1, 1.2, "outQuad");
  const DRAW0 = 0.45, DRAW1 = 5.1;
  tl.call((p) => {
    const v = line.set(p);
    const ms = Math.round(p * pbMs);
    timer.textContent = fmtLap(ms);
    document.getElementById("s0-speed").textContent = `${Math.round(v * 2.236936)} mph`;
  }, DRAW0, DRAW1 - DRAW0, "linear");
  tl.to([line.head, line.halo], { opacity: [1, 0] }, DRAW1 + 0.25, 0.4);
  tl.call((p) => { timer.style.color = p > 0 ? "var(--lime)" : "var(--text-strong)"; }, DRAW1, 0.01);
  tl.to(pbPill, { opacity: [0, 1], scale: [0.6, 1], y: [10, 0] }, DRAW1 + 0.05, 0.55, "outBack");
  flash(DRAW1, 0.12);
  // out: the whole frame leans in and dissolves into the brand
  tl.to(s, { scale: [1, 1.06], opacity: [1, 0], blur: [0, 14] }, 5.55, 0.47, "inCubic");
}

// ============================================================ 1 · brand ===
{
  const s = scene("s1", 5.9, 10.02);
  const lock = el("div", { class: "abs", style: at(0, 330, { width: px(W), display: "flex", justifyContent: "center", alignItems: "center", gap: "40px" }) }, s);
  const mark = el("div", {
    html: `<svg width="150" height="150" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#c8f24e"/><g transform="translate(31.244 22.5) scale(0.08744)"><g fill="#0c1400"><rect x="0.59" y="115.85" width="163" height="442.77" transform="rotate(-44.9265 0.59 115.85)"/><rect x="311.97" y="198.25" width="163" height="442.77" transform="rotate(44.5184 311.97 198.25)"/></g></g></svg>`,
    style: { width: "150px", height: "150px", flex: "none" },
  }, lock);
  const wordWrap = el("div", { style: { overflow: "hidden", paddingBottom: "12px" } }, lock);
  const word = el("div", { class: "wordmark", text: "Track Evolution" }, wordWrap);
  const tagline = headline(s, "Your track days, *remembered lap by lap.*", { x: 0, y: 560, size: 58, width: W });
  tagline.el.style.textAlign = "center";
  tagline.el.style.fontWeight = "600";
  tl.to(mark, { scale: [0.2, 1], opacity: [0, 1], rotate: [-90, 0] }, 6.0, 0.7, "outBack");
  tl.to(word, { x: [-60, 0], opacity: [0, 1], blur: [10, 0] }, 6.35, 0.75, "outQuart");
  rise(tagline.words, 6.9, { each: 0.07, dy: 30 });
  flash(6.0, 0.1);
  tl.to(s, { scale: [1, 0.94], opacity: [1, 0], blur: [0, 10] }, 9.6, 0.4, "inCubic");
}

// ========================================================= 2 · logbook ===
{
  const s = scene("s2", 10, 18.02);
  const eb = eyebrow(s, "The logbook", 120, 176);
  const h = headline(s, "Every track day./Every session./*Every lap.*", { x: 120, y: 222, size: 92 });
  const chips = el("div", { class: "abs", style: at(120, 560, { display: "flex", alignItems: "center" }) }, s);
  const chipEls = [];
  ["Tracks", "Events", "Sessions", "Laps"].forEach((t, i) => {
    if (i) chipEls.push(el("span", { class: "hsep", text: "›" }, chips));
    chipEls.push(el("span", { class: "hchip", text: t }, chips));
  });
  const br = browserFrame(s, { x: 790, y: 150, w: 1000, h: 625, url: "trackevolution.app", img: "dash" });
  br.img.style.width = px(1000);
  const ph = phoneFrame(s, { x: 1590, y: 360, w: 290, h: 628, img: "m-dash" });
  const cap = caption(s, "Tracks, events, sessions and lap times — <b>unlimited, and free.</b>", 120, 700, 480, ["FREE"]);
  cap.style.flexDirection = "column";
  cap.style.alignItems = "flex-start";

  appear(eb, 10.15, { dy: 14 });
  rise(h.words, 10.25, { each: 0.08 });
  chipEls.forEach((c, i) => appear(c, 10.95 + i * 0.08, { dy: 18, blur: 6, dur: 0.5 }));
  tl.to(br.root, { opacity: [0, 1], x: [260, 0], ry: [-24, -9], rx: [6, 3] }, 11.6, 1.0, "outQuart");
  tl.to(br.root, { ry: [-9, -4], rx: [3, 1] }, 12.6, 5.4, "linear");
  br.root.style.transformOrigin = "0% 50%";
  tl.to(br.img, { scale: [1, 1.06], y: [0, -20] }, 12.0, 6.0, "inOutQuad");
  tl.to(ph.root, { opacity: [0, 1], y: [240, 0] }, 12.2, 0.9, "outQuart");
  const scroll = IMG["m-dash"].h * (ph.sw / 390) - ph.sh;
  tl.to(ph.img, { y: [0, -Math.min(560, Math.max(0, scroll))] }, 13.4, 3.6, "inOutCubic");
  appear(cap, 13.2, { dy: 20 });
}
wipe(18);

// ======================================================== 3 · progress ===
{
  const s = scene("s3", 18, 24.02);
  const eb = eyebrow(s, "Progress", 120, 176);
  const h = headline(s, "Watch yourself/get *faster.*", { x: 120, y: 222, size: 92 });
  const sb = sub(s, "Your best lap at every track and layout, event after event. <b>Lower is faster.</b>", 120, 450, 520);
  const box = data.boxes.trackChart;
  const cw = 1040, ch = Math.round(cw * (box.card.h / box.card.w));
  const card = el("div", { class: "card-frame", style: at(770, 250, { width: px(cw), height: px(ch) }) }, s);
  const bare = addImg(card, "track-chart-bare", { width: px(cw), position: "absolute", left: "0", top: "0" });
  const lined = addImg(card, "track-chart", { width: px(cw), position: "absolute", left: "0", top: "0" });
  // the line draws itself in: the lined capture wiped in over the bare one
  const k = cw / box.card.w;
  const plotL = (box.plot.x * k / cw) * 100, plotR = ((box.plot.x + box.plot.w) * k / cw) * 100;
  tl.call((p) => { lined.style.clipPath = `inset(0 ${100 - lerp(plotL, plotR, p)}% 0 0)`; }, 19.0, 2.6, "inOutCubic");
  const big = el("div", { class: "abs headline", html: `<span class="accent">−${((firstMs - pbMs) / 1000).toFixed(1)} s</span>`, style: at(120, 620, { fontSize: "150px" }) }, s);
  const from = el("div", { class: "abs mono", html: `${fmtLap(firstMs)} <span style="color:var(--lime)">→</span> <span style="color:var(--text-strong)">${fmtLap(pbMs)}</span>`, style: at(128, 800, { fontSize: "34px", color: "var(--muted)" }) }, s);
  const note = el("div", { class: "abs sub", text: "Circuit of the Americas · six weekends, one car", style: at(128, 856, { fontSize: "24px" }) }, s);

  appear(eb, 18.3, { dy: 14 });
  rise(h.words, 18.4, { each: 0.08 });
  appear(sb, 18.8, { dy: 16 });
  tl.to(card, { opacity: [0, 1], y: [60, 0], scale: [0.96, 1] }, 18.55, 0.9, "outQuart");
  tl.to(card, { scale: [1, 1.03] }, 19.5, 4.5, "linear");
  appear(big, 21.5, { dy: 40, blur: 16, dur: 0.7 });
  appear(from, 21.8, { dy: 16 });
  appear(note, 22.0, { dy: 12 });
  leave([eb, h.el, sb, big, from, note, card], 23.55, 0.4);
}

// ========================================================== 4 · import ===
{
  const s = scene("s4", 24, 32.02);
  const eb = eyebrow(s, "Telemetry import", 120, 150);
  const h = headline(s, "Drop in your footage./Get *every lap.*", { x: 120, y: 196, size: 80 });
  const files = [
    ["MP4", "PDR_0912_1445.mp4", "Corvette PDR"],
    ["MP4", "GX010057.MP4", "GoPro"],
    ["VBO", "session_04.vbo", "Racelogic VBO"],
    ["CSV", "recording.csv", "Track Precision"],
  ].map(([ext, name, kind], i) =>
    el("div", { class: "abs file", html: `<span class="ico"><b>${ext}</b></span><span class="name">${name}</span><span class="kind">${kind}</span>`, style: at(120, 420 + i * 92) }, s)
  );
  const box = data.boxes.importPanel;
  const pw = 1040, phh = Math.round(pw * (box._size.h / box._size.w));
  const card = el("div", { class: "card-frame", style: at(770, 150, { width: px(pw), height: px(phh) }) }, s);
  const pick = addImg(card, "import-pick", { width: px(pw), position: "absolute", left: "0", top: "0" });
  const laps = addImg(card, "import-laps", { width: px(pw), position: "absolute", left: "0", top: "0" });
  const k = pw / box._size.w;
  // the start/finish on the picker map, in stage coordinates
  const sfx = 770 + (box.map.x + data.boxes.importClick.x * box.map.w) * k;
  const sfy = 150 + (box.map.y + data.boxes.importClick.y * box.map.h) * k;
  const cursor = el("div", { class: "cursor", html: `<svg viewBox="0 0 34 44" width="34" height="44"><path d="M3 2 L3 34 L11 27 L17 41 L23 38 L17 25 L28 25 Z" fill="#f6f6f7" stroke="#0a0a0b" stroke-width="2.5" stroke-linejoin="round"/></svg>`, style: at(0, 0) }, s);
  const ripple = el("div", { class: "click", style: at(sfx, sfy) }, s);
  const lapRing = el("div", { class: "ring", style: at(770 + box.laps.x * k - 10, 150 + box.laps.y * k - 10, { width: px(box.laps.w * k * 0.49), height: px(box.laps.h * k + 20) }) }, s);
  const cap = caption(s, "Parsed right on your device — <b>your video is never uploaded.</b>", 120, 850, 1690, ["FREE"]);

  appear(eb, 24.3, { dy: 14 });
  rise(h.words, 24.4, { each: 0.07 });
  files.forEach((f, i) => tl.to(f, { opacity: [0, 1], x: [-120, 0], blur: [8, 0] }, 25.0 + i * 0.12, 0.6, "outQuart"));
  tl.to(card, { opacity: [0, 1], x: [120, 0] }, 25.5, 0.9, "outQuart");
  tl.to(laps, { opacity: [0, 0] }, 0, 0.01);
  tl.to(cursor, { opacity: [0, 1] }, 26.4, 0.2);
  tl.to(cursor, { x: [1560, sfx - 3], y: [930, sfy - 2] }, 26.4, 1.0, "inOutCubic");
  tl.to(ripple, { opacity: [0, 1], scale: [0.2, 0.2] }, 27.42, 0.01);
  tl.to(ripple, { opacity: [1, 0], scale: [0.3, 1.6] }, 27.43, 0.6, "outQuad");
  tl.to(cursor, { scale: [1, 0.86] }, 27.38, 0.08);
  tl.to(cursor, { scale: [0.86, 1] }, 27.48, 0.12);
  tl.to(laps, { opacity: [0, 1] }, 27.5, 0.18, "linear");
  tl.to(cursor, { opacity: [1, 0], x: [sfx - 3, sfx + 60], y: [sfy - 2, sfy + 90] }, 28.2, 0.6, "inCubic");
  tl.to(lapRing, { opacity: [0, 1], scale: [1.08, 1] }, 27.8, 0.4, "outQuart");
  tl.to(lapRing, { opacity: [1, 0] }, 30.2, 0.5);
  appear(cap, 28.5, { dy: 18 });
}
wipe(32);

// ========================================================== 5 · record ===
{
  const s = scene("s5", 32, 38.02);
  const bgLine = raceLine(s, { x: 700, y: 110, w: 1180, h: 860, width: 5, tarmac: true });
  bgLine.svg.style.opacity = "0.35";
  const eb = eyebrow(s, "Record laps", 120, 176);
  const h = headline(s, "No lap timer?/Your phone *is one.*", { x: 120, y: 222, size: 92 });
  const sb = sub(s, "Start recording, stow the phone, and pick the start/finish line back in the paddock.", 120, 450, 540);
  const ph = phoneFrame(s, { x: 1150, y: 90, w: 410, h: 890 });
  // The lap that became the PB, mid-lap: its predictive delta runs against
  // the session's best so far, which is what the recorder compares with.
  const laps = data.pbSessionLaps, pbIdx = laps.indexOf(pbMs);
  const last = laps[pbIdx - 1], best = Math.min(...laps.slice(0, pbIdx));
  const target = (pbMs - best) / 1000;
  const outLapS = 165, lapStartS = outLapS + laps.slice(0, pbIdx).reduce((a, b) => a + b, 0) / 1000;
  const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  const evDate = new Date(`${data.pb.date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const rec = el("div", {
    class: "rec",
    html: `
      <div class="bar"><span>‹ Event</span><span>Record laps</span><span style="width:52px"></span></div>
      <div class="tecard">
        <div class="eb" style="color:var(--lime)">Recording</div>
        <div class="hero" id="s5-elapsed" style="font-size:66px;color:var(--text-strong);margin-top:12px">14:52</div>
        <div class="hero" id="s5-delta" style="font-size:96px;color:var(--lime);margin-top:26px">−0.42</div>
        <div style="font-size:15px;color:var(--muted);margin-top:8px">ahead of your best lap</div>
        <div class="stats" style="margin-top:22px">
          <div><span class="eb">Lap</span><span class="v">${pbIdx + 1}</span></div>
          <div><span class="eb">Current</span><span class="v" id="s5-cur">1:38</span></div>
          <div><span class="eb">Last</span><span class="v">${fmtMs(last)}</span></div>
          <div><span class="eb">Best</span><span class="v">${fmtMs(best)}</span></div>
        </div>
      </div>
      <div style="font-size:15px;color:var(--muted)">Attached to Circuit of the Americas · ${evDate}</div>
      <div class="tecard">
        <div class="stats">
          <div><span class="eb">Fixes</span><span class="v" id="s5-fix">8,920</span></div>
          <div><span class="eb">Speed</span><span class="v" id="s5-spd">146 mph</span></div>
          <div><span class="eb">Accuracy</span><span class="v">±10 ft</span></div>
        </div>
      </div>
      <div style="flex:1"></div>
      <div class="stop">Stop recording</div>`,
  }, ph.screen);
  const cap = caption(s, "Live lap timing and a predictive delta from the phone's GPS — <b>start and stop it from CarPlay.</b>", 120, 760, 560, ["PRO"]);
  cap.style.flexDirection = "column";
  cap.style.alignItems = "flex-start";

  appear(eb, 32.3, { dy: 14 });
  rise(h.words, 32.4, { each: 0.08 });
  appear(sb, 32.9, { dy: 16 });
  tl.to(ph.root, { opacity: [0, 1], y: [180, 0], rotate: [4, 0] }, 32.5, 1.0, "outQuart");
  appear(cap, 34.0, { dy: 16 });
  // the lap runs on: the delta breathes, the fixes count up
  tl.call((p, t) => {
    const lapS = 96 + (t - 32);
    document.getElementById("s5-cur").textContent = mmss(lapS);
    document.getElementById("s5-elapsed").textContent = mmss(lapStartS + lapS);
    const d = target - 0.05 * Math.sin((t - 32) * 1.1) - 0.02 * Math.sin((t - 32) * 3.7);
    document.getElementById("s5-delta").textContent = `${d < 0 ? "−" : "+"}${Math.abs(d).toFixed(2)}`;
    // a phone's GPS fixes about once a second
    document.getElementById("s5-fix").textContent = Math.round(lapStartS + lapS).toLocaleString("en-US");
    const v = bgLine.set(lapS / (pbMs / 1000));
    document.getElementById("s5-spd").textContent = `${Math.round(v * 2.236936)} mph`;
  }, 32, 6, "linear");
  leave([eb, h.el, sb, cap], 37.55, 0.4);
  tl.to(ph.root, { opacity: [1, 0], x: [0, 60] }, 37.55, 0.4, "inCubic");
}
wipe(38);

// ======================================================== 6 · analysis ===
{
  const s = scene("s6", 38, 52.02);
  const eb = eyebrow(s, "Analysis", 120, 150);
  const h = headline(s, "See exactly where the time *went.*", { x: 120, y: 192, size: 74, fit: 1500 });
  const proTag = el("div", { class: "abs", html: tag("PRO"), style: at(1720, 150) }, s);
  // the montage area; each card is sized to its crop, centred in it
  const AREA = { x: 120, y: 340, w: 1680, h: 660 };
  const P = data.boxes.panel;
  const shots = [
    { img: "panel-time", region: { x: 12, y: 336, w: 1040, h: 398 }, label: "Sector splits, theoretical best and a lap-vs-lap delta" },
    { img: "event-map", region: null, label: "Where ABS and traction control stepped in" },
    { img: "panel-inputs", region: { x: 12, y: 1258, w: 1040, h: 346 }, label: "Gear ribbon and shift points on every lap" },
    { img: "panel-grip", region: { x: 150, y: 338, w: 764, h: 470 }, label: "The friction circle: how much tire you actually used" },
    { img: "panel-car", region: { x: 12, y: 366, w: 1040, h: 540 }, label: "Car health: temperatures, pressures and fuel, lap by lap" },
    { img: "compare", region: { x: 188, y: 1005 - (data.boxes.compare.clipY ?? 0), w: 1064, h: 222 }, label: "Any two laps, side by side — even two seasons apart" },
  ];
  const t0s = [39.4, 42.0, 44.0, 46.0, 48.0, 50.0];
  let lastCard = null;
  shots.forEach((shot, i) => {
    const reg = shot.region ?? { x: 0, y: 0, w: IMG[shot.img].w, h: IMG[shot.img].h };
    let CW = AREA.w, CH = CW * (reg.h / reg.w);
    if (CH > AREA.h) { CH = AREA.h; CW = CH * (reg.w / reg.h); }
    const CX = AREA.x + (AREA.w - CW) / 2, CY = AREA.y + (AREA.h - CH) / 2;
    const c = cardFrame(s, { x: CX, y: CY, w: CW, h: CH });
    lastCard = { CX, CY, CW, CH };
    const im = addImg(c.crop, shot.img);
    // the crop fills the card, then drifts in 6 % about its centre
    const sc = CW / reg.w, z = 1.06;
    const f1 = { x: -reg.x * sc, y: -reg.y * sc, scale: sc };
    const f2 = { x: CW / 2 - (reg.x + reg.w / 2) * sc * z, y: CH / 2 - (reg.y + reg.h / 2) * sc * z, scale: sc * z };
    const tIn = t0s[i], tOut = i + 1 < t0s.length ? t0s[i + 1] : 51.6;
    tl.to(im, { x: [f1.x, f2.x], y: [f1.y, f2.y], scale: [f1.scale, f2.scale] }, tIn - 0.2, tOut - tIn + 0.6, "linear");
    tl.to(c.root, { opacity: [0, 1], x: [140, 0], blur: [10, 0] }, tIn, 0.55, "outQuart");
    if (i + 1 < t0s.length) tl.to(c.root, { opacity: [1, 0], x: [0, -140], blur: [0, 10] }, tOut - 0.05, 0.45, "inCubic");
    else tl.to(c.root, { opacity: [1, 0], y: [0, -30], blur: [0, 10] }, 51.55, 0.4, "inCubic");
    const lab = pillLabel(s, shot.label, CX, CY - 58);
    appear(lab, tIn + 0.15, { dy: 12, dur: 0.45 });
    if (i + 1 < t0s.length) tl.to(lab, { opacity: [1, 0], y: [0, -10] }, tOut - 0.05, 0.3, "inCubic");
    else tl.to(lab, { opacity: [1, 0] }, 51.55, 0.3);
  });
  // the cross-season delta, said out loud
  const d = el("div", { class: "abs headline", html: `<span class="accent">−${((firstMs - pbMs) / 1000).toFixed(1)}&nbsp;s</span><span style="font-size:34px;color:var(--muted);font-weight:500;letter-spacing:0"> &nbsp;your best lap, September 2026 against March 2025</span>`, style: at(lastCard.CX, lastCard.CY + lastCard.CH + 30, { fontSize: "88px" }) }, s);
  appear(d, 50.5, { dy: 26 });
  tl.to(d, { opacity: [1, 0] }, 51.55, 0.3);

  appear(eb, 38.2, { dy: 14 });
  rise(h.words, 38.3, { each: 0.07 });
  appear(proTag, 38.9, { dy: 10 });
  leave([eb, h.el, proTag], 51.55, 0.4);
  flash(38.0, 0.1);
}
wipe(52);

// ========================================================== 7 · garage ===
{
  const s = scene("s7", 52, 58.02);
  const eb = eyebrow(s, "Garage", 120, 176);
  const h = headline(s, "Know before the/weekend, *not after.*", { x: 120, y: 222, size: 80 });
  const sb = sub(s, "Pads, tires and fluids tracked per car, with wear projected from the laps you log.", 120, 420, 520);
  const bw = 1060, bh = 662;
  const br = browserFrame(s, { x: 770, y: 150, w: bw, h: bh, url: "trackevolution.app/#/garage" });
  const kG = bw / IMG.garage.w;
  const g = addImg(br.vp, "garage", { width: px(bw) });
  const v = addImg(br.vp, "vehicle", { width: px(bw) });
  const fp = data.boxes.vehicle.frontPads;
  const kV = bw / IMG.vehicle.w;
  // start with the front pads near the top, but never scroll past the capture
  const f1 = { x: 0, y: Math.max(bh - IMG.vehicle.h * kV, -Math.max(0, (fp.y - 120) * kV)) };
  const zoom = 1.32;
  const f2 = focus("vehicle", bw, bh, fp, zoom, kV);
  // ring around the front pads' wear line, in stage coordinates at the zoom
  const ring = el("div", { class: "ring", style: at(770 + f2.x + (fp.x + 4) * f2.scale, 150 + 46 + f2.y + (fp.y + 4) * f2.scale, { width: px((fp.w - 8) * f2.scale), height: px((fp.h - 8) * f2.scale) }) }, s);
  const cap = caption(s, "The app tells you <b>front pads: about two days left</b> before the weekend.", 120, 620, 520, ["PRO"]);
  cap.style.flexDirection = "column";
  cap.style.alignItems = "flex-start";

  appear(eb, 52.3, { dy: 14 });
  rise(h.words, 52.4, { each: 0.07 });
  appear(sb, 52.9, { dy: 16 });
  tl.to(br.root, { opacity: [0, 1], y: [80, 0] }, 52.5, 0.9, "outQuart");
  tl.to(v, { opacity: [0, 0] }, 0, 0.01);
  tl.to(g, { scale: [1, 1.04] }, 52.5, 2.0, "linear");
  tl.to(v, { opacity: [0, 1] }, 54.35, 0.35, "linear");
  tl.to(g, { opacity: [1, 0] }, 54.55, 0.3, "linear");
  tl.to(v, { x: [0, f2.x], y: [f1.y, f2.y], scale: [kV / kV, f2.scale / kV] }, 54.4, 1.4, "inOutCubic");
  v.style.transformOrigin = "0 0";
  // (the vehicle image's CSS width already carries kV; the scale above is relative)
  tl.to(ring, { opacity: [0, 1], scale: [1.06, 1] }, 55.9, 0.45, "outQuart");
  appear(cap, 55.6, { dy: 16 });
  leave([eb, h.el, sb, cap, ring], 57.55, 0.4);
  tl.to(br.root, { opacity: [1, 0], y: [0, -30] }, 57.55, 0.4, "inCubic");
}

// ======================================================= 8 · community ===
{
  const s = scene("s8", 58, 64.02);
  const eb = eyebrow(s, "Leaderboards & sharing", 120, 176);
  const h = headline(s, "See where you/*stack up.*", { x: 120, y: 222, size: 92 });
  const sb = sub(s, "Per-track leaderboards, opt-in. Only GPS- or telemetry-timed laps rank — <b>nobody types their way up.</b>", 120, 450, 540);
  const bw = 1060, bh = 662;
  const br = browserFrame(s, { x: 770, y: 130, w: bw, h: bh, url: "trackevolution.app/#/track/cota/leaderboard", img: "leaderboard" });
  br.img.style.width = px(bw);
  const kL = bw / IMG.leaderboard.w;
  const you = data.boxes.leaderboard.you;
  const ring = el("div", { class: "ring", style: at(770 + you.x * kL - 4, 130 + 46 + you.y * kL - 4, { width: px(you.w * kL + 8), height: px(you.h * kL + 8) }) }, s);
  const rank = data.leaderboard.findIndex((e) => e.you) + 1;
  const rankPill = el("div", { class: "abs pb-pill", html: `P${rank} of ${data.leaderboard.length}`, style: at(770 + bw - 230, 130 + 46 + you.y * kL - 76) }, s);
  // the coach card, cut from the Coaching page
  // the coach's row on the Coaching page, cropped to its card
  const row = { x: 188, y: 467, w: 1064, h: 88 };
  const kC = 0.86;
  const cc = cardFrame(s, { x: 900, y: 912, w: row.w * kC, h: row.h * kC });
  cc.root.style.background = "transparent";
  cc.root.style.border = "none";
  const ci = addImg(cc.crop, "coaching");
  tl.to(ci, { x: [-row.x * kC, -row.x * kC], y: [-row.y * kC, -row.y * kC], scale: [kC, kC] }, 0, 0.01);
  const coachLab = pillLabel(s, "Shared with your coach — read-only", 900, 860);
  const cap = caption(s, "Share a read-only page of your times — or your whole logbook with your coach.", 120, 700, 540, ["FREE", "PRO"]);
  cap.style.flexDirection = "column";
  cap.style.alignItems = "flex-start";

  appear(eb, 58.3, { dy: 14 });
  rise(h.words, 58.4, { each: 0.08 });
  appear(sb, 58.9, { dy: 16 });
  tl.to(br.root, { opacity: [0, 1], x: [120, 0] }, 58.5, 0.9, "outQuart");
  tl.to(ring, { opacity: [0, 1], scale: [1.04, 1] }, 59.5, 0.45, "outQuart");
  tl.to(rankPill, { opacity: [0, 1], scale: [0.6, 1] }, 59.7, 0.5, "outBack");
  tl.to(cc.root, { opacity: [0, 1], y: [90, 0] }, 60.9, 0.8, "outQuart");
  appear(coachLab, 61.1, { dy: 20, dur: 0.6 });
  appear(cap, 61.2, { dy: 16 });
  leave([eb, h.el, sb, cap, ring, rankPill, coachLab], 63.55, 0.4);
  tl.to([br.root, cc.root], { opacity: [1, 0] }, 63.55, 0.4, "inCubic");
}
wipe(64);

// ============================================================== 9 · AI ===
{
  const s = scene("s9", 64, 70.02);
  const ai = data.ai;
  const eb = eyebrow(s, "AI assistants", 120, 176);
  const h = headline(s, "Ask about/*your driving.*", { x: 120, y: 222, size: 92 });
  const sb = sub(s, "Connect Claude, ChatGPT or any MCP assistant. It reads the same numbers the app shows — <b>and can't change a thing.</b>", 120, 450, 540);
  const chat = el("div", { class: "chat", style: at(780, 200, { width: "1020px", height: "600px" }) }, s);
  el("div", { class: "head", html: `<span style="width:12px;height:12px;border-radius:50%;background:var(--muted)"></span>Your AI assistant<span class="conn"><span style="width:9px;height:9px;border-radius:50%;background:var(--lime)"></span>Track Evolution connected</span>` }, chat);
  const body = el("div", { class: "body" }, chat);
  const q = `Where did I find ${((ai.b.ms - ai.a.ms) / 1000).toFixed(1)} seconds at COTA since February?`;
  const user = el("div", { class: "bubble user", text: q }, body);
  const tools = el("div", { html: `<span class="toolchip"><i></i>get_track_history</span><span class="toolchip"><i></i>compare_laps</span>` }, body);
  const bot = el("div", { class: "bubble bot" }, body);
  const NB = "\u00a0";
  const sec = ai.sectorsS.map((v, i) => `S${i + 1}${NB}${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(2)}${NB}s`).join(" · ");
  const [z1, z2] = ai.zones;
  const apex = Math.round(((mph(z1.apexGainKph) + mph(z2.apexGainKph)) / 2) * 2) / 2;
  const later = Math.round((((z1.laterM ?? 20) + (z2.laterM ?? 20)) / 2) / 5) * 5;
  // [text, bold?] runs, typed in order
  const runs = [
    ["Your September PB, ", false], [fmtLap(ai.a.ms), true], [", against February's best, ", false], [fmtLap(ai.b.ms), true], [":\n", false],
    [sec, true], ["\n\nThe two biggest gains are braking zones — into T1 and at the end of the back straight. You brake about ", false],
    [`${later}${NB}m later`, true], [" and carry about ", false], [`${apex}${NB}mph more`, true], [" to the apex: ", false],
    [`${z1.gainS.toFixed(2)}${NB}s and ${z2.gainS.toFixed(2)}${NB}s`, true], [".\n\nPeak lateral G is up from ", false],
    [ai.latG[0].toFixed(2), true], [" to ", false], [ai.latG[1].toFixed(2), true], [" — more of the tire, mid-corner.", false],
  ];
  const total = runs.reduce((n, r) => n + r[0].length, 0);
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const cursorHtml = `<span style="display:inline-block;width:10px;height:22px;background:var(--lime);vertical-align:-3px;margin-left:2px"></span>`;
  tl.call((p) => {
    let n = Math.round(p * total), html = "";
    for (const [t, b] of runs) {
      if (n <= 0) break;
      const part = esc(t.slice(0, n));
      html += b ? `<b>${part}</b>` : part;
      n -= t.length;
    }
    bot.innerHTML = html + (p > 0 && p < 1 ? cursorHtml : "");
    bot.style.visibility = p > 0 ? "visible" : "hidden";
  }, 66.1, 2.9, "linear");

  appear(eb, 64.3, { dy: 14 });
  rise(h.words, 64.4, { each: 0.08 });
  appear(sb, 64.9, { dy: 16 });
  tl.to(chat, { opacity: [0, 1], x: [120, 0] }, 64.5, 0.9, "outQuart");
  appear(user, 65.0, { dy: 24, dur: 0.5 });
  tools.querySelectorAll(".toolchip").forEach((c, i) => appear(c, 65.55 + i * 0.2, { dy: 10, dur: 0.4 }));
  const tagEl = el("div", { class: "abs", html: tag("PRO"), style: at(120, 640) }, s);
  appear(tagEl, 65.2, { dy: 10 });
  leave([eb, h.el, sb, tagEl], 69.55, 0.4);
  tl.to(chat, { opacity: [1, 0], x: [0, 60] }, 69.55, 0.4, "inCubic");
}

// ========================================================= 10 · wrapped ===
{
  const s = scene("s10", 70, 74.02);
  const eb = eyebrow(s, "Season Wrapped", 120, 176);
  const h = headline(s, "Your season,/handed back/*as a story.*", { x: 120, y: 222, size: 92 });
  const back = phoneFrame(s, { x: 1010, y: 150, w: 380, h: 822, img: `m-wrapped-${data.wrappedCards - 1}` });
  const ph = phoneFrame(s, { x: 1370, y: 110, w: 400, h: 866, img: "m-wrapped-0" });
  const order = [1, 2, 3, 4, 5, 6].filter((i) => i < data.wrappedCards - 1);
  const cards = [ph.img, ...order.map((i) => el("img", { src: SHOT(`m-wrapped-${i}`), style: { top: "54px" } }, ph.screen))];
  const per = 3.3 / cards.length;
  cards.forEach((c, i) => {
    const t = 70.35 + i * per;
    if (i) tl.to(c, { opacity: [0, 1], x: [50, 0] }, t, 0.2, "outCubic");
    if (i + 1 < cards.length) tl.to(c, { opacity: [1, 0], x: [0, -30] }, t + per - 0.04, 0.14, "inQuad");
  });
  const tagEl = el("div", { class: "abs", html: tag("FREE"), style: at(120, 590) }, s);
  const sb = sub(s, "Every November: track days, laps and miles, the time you found, and a card for the group chat.", 120, 660, 520);
  appear(eb, 70.2, { dy: 14 });
  rise(h.words, 70.3, { each: 0.07 });
  appear(tagEl, 70.9, { dy: 10 });
  appear(sb, 71.0, { dy: 16 });
  tl.to(ph.root, { opacity: [0, 1], y: [160, 0] }, 70.25, 0.8, "outQuart");
  tl.to(back.root, { opacity: [0, 0.55], y: [200, 0], rotate: [-4, -8], x: [80, 0] }, 70.45, 0.9, "outQuart");
  leave([eb, h.el, tagEl, sb], 73.55, 0.4);
  tl.to([ph.root, back.root], { opacity: [1, 0] }, 73.55, 0.4);
}
wipe(74);

// ====================================================== 11 · everywhere ===
{
  const s = scene("s11", 74, 78.02);
  const h = headline(s, "iPhone. iPad. Mac./Android. *The web.*", { x: 120, y: 190, size: 88 });
  const sb = sub(s, "Your whole logbook works offline in the paddock, and syncs when you're back.", 120, 400, 560);
  const br = browserFrame(s, { x: 770, y: 150, w: 1040, h: 650, url: "trackevolution.app", img: "event" });
  br.img.style.width = px(1040);
  const ph = phoneFrame(s, { x: 1540, y: 360, w: 310, h: 672, img: "m-event" });
  const plat = el("div", { class: "abs platforms", html: ["iPhone", "iPad", "Mac", "Android", "Web"].map((p) => `<span>${p}</span>`).join(""), style: at(120, 560) }, s);
  rise(h.words, 74.3, { each: 0.08 });
  appear(sb, 74.8, { dy: 16 });
  [...plat.children].forEach((c, i) => appear(c, 75.0 + i * 0.08, { dy: 14, dur: 0.5 }));
  tl.to(br.root, { opacity: [0, 1], x: [140, 0] }, 74.4, 0.9, "outQuart");
  tl.to(br.img, { y: [0, -Math.max(0, Math.min(300, IMG.event.h * (1040 / IMG.event.w) - 650))] }, 75.0, 3.0, "inOutQuad");
  tl.to(ph.root, { opacity: [0, 1], y: [200, 0] }, 74.7, 0.9, "outQuart");
  const scroll = IMG["m-event"].h * (ph.sw / 390) - ph.sh;
  tl.to(ph.img, { y: [0, -Math.min(900, Math.max(0, scroll))] }, 75.2, 2.6, "inOutCubic");
}
wipe(78);

// ============================================================= 12 · CTA ===
{
  const s = scene("s12", 78, DURATION + 1);
  const lock = el("div", { class: "abs", style: at(0, 230, { width: px(W), display: "flex", justifyContent: "center", alignItems: "center", gap: "32px" }) }, s);
  const mark = el("div", {
    html: `<svg width="118" height="118" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#c8f24e"/><g transform="translate(31.244 22.5) scale(0.08744)"><g fill="#0c1400"><rect x="0.59" y="115.85" width="163" height="442.77" transform="rotate(-44.9265 0.59 115.85)"/><rect x="311.97" y="198.25" width="163" height="442.77" transform="rotate(44.5184 311.97 198.25)"/></g></g></svg>`,
    style: { width: "118px", height: "118px" },
  }, lock);
  const word = el("div", { class: "wordmark", text: "Track Evolution", style: { fontSize: "96px" } }, lock);
  const line = headline(s, "Free is the logbook. *Pro is the analysis.*", { x: 0, y: 420, size: 56, width: W });
  line.el.style.textAlign = "center";
  line.el.style.fontWeight = "600";
  const url = el("div", { class: "abs mono", text: "trackevolution.app", style: at(0, 530, { width: px(W), textAlign: "center", fontSize: "46px", color: "var(--lime)", fontWeight: "500" }) }, s);
  const stores = el("div", { class: "abs", style: at(0, 650, { width: px(W), display: "flex", justifyContent: "center", gap: "22px" }) }, s);
  const a = el("div", { class: "store", html: `<div><small>Download on the</small>App Store</div>` }, stores);
  const b = el("div", { class: "store", html: `<div><small>Get it on</small>Google Play</div>` }, stores);
  const c = el("div", { class: "store", html: `<div><small>Or just open it in</small>any browser</div>` }, stores);
  const fine = el("div", { class: "abs", text: "Screens show a demo logbook. Circuit geometry © OpenStreetMap contributors, via TUM's open racetrack database.", style: at(0, 1010, { width: px(W), textAlign: "center", fontSize: "17px", color: "var(--faint)" }) }, s);
  tl.to(mark, { scale: [0.3, 1], opacity: [0, 1], rotate: [-60, 0] }, 78.15, 0.7, "outBack");
  tl.to(word, { x: [-40, 0], opacity: [0, 1], blur: [10, 0] }, 78.35, 0.7, "outQuart");
  rise(line.words, 78.9, { each: 0.06, dy: 28 });
  appear(url, 79.6, { dy: 20 });
  [a, b, c].forEach((x, i) => appear(x, 80.0 + i * 0.12, { dy: 22, dur: 0.6 }));
  appear(fine, 80.6, { dy: 6 });
  flash(78.0, 0.1);
  tl.to("#fade", { opacity: [0, 1] }, DURATION - 0.9, 0.9, "inQuad");
}

// ---------------------------------------------------------------- drive ---

window.__duration = DURATION;
window.__seek = (t) => tl.seek(t);
await document.fonts.ready;
const q = new URLSearchParams(location.search);
tl.seek(Number(q.get("t") ?? 0));
window.__ready = true;
