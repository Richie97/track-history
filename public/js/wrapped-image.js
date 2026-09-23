// Season Wrapped (NS-36) — the poster as a picture. Drawn on a canvas in the
// browser (there is no Worker rasteriser — #155's blocker stands), in two
// sizes: a 1080×1920 story for Instagram/WhatsApp status and a 1200×630
// landscape for everywhere else. The words are posterLines', so the image can
// never say something the poster card doesn't.
//
// Colours are read from the page's design tokens at draw time, so the image is
// in whichever theme the viewer is looking at. Geist is loaded through
// document.fonts first, with the same system fallback the stylesheet declares.

import { fmtDays, plural, posterLines, trackDistance } from "./wrapped.js";

export const POSTER_SIZES = {
  story: { w: 1080, h: 1920 },
  wide: { w: 1200, h: 630 },
};

const FONT = 'Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const APP_HOST = "trackevolution.app";

// Greedy word wrap against a measure function (a canvas context's
// measureText in the browser, a stub in tests). A single word wider than the
// line is left whole rather than split mid-word.
export function wrapWords(text, maxWidth, measure) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && measure(next) > maxWidth) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export const posterFileName = (year, size) => `track-evolution-${year}-wrapped${size === "wide" ? "-wide" : ""}.png`;

// The four numbers as value/label pairs — the numbers card's cells.
export function posterStats(data, units) {
  const t = data.totals;
  const dist = trackDistance(t.miles, units);
  return [
    [fmtDays(t.track_days), plural(t.track_days, "track day")],
    [Math.round(t.tracks).toLocaleString("en-US"), plural(t.tracks, "track")],
    [Math.round(t.laps).toLocaleString("en-US"), plural(t.laps, "lap")],
    ...(t.miles_tracks_counted ? [[dist.value, dist.unit]] : []),
  ];
}

function tokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    bg: v("--bg-page", "#0a0a0b"),
    card: v("--surface-card", "#131316"),
    strong: v("--text-strong", "#f6f6f7"),
    body: v("--text-body", "#d6d6d9"),
    muted: v("--text-muted", "#97979e"),
    accent: v("--accent", "#c8f24e"),
    accentInk: v("--accent-ink", "#c8f24e"),
    accentContrast: v("--accent-contrast", "#0c1400"),
    accentTint: v("--accent-tint", "rgba(200, 242, 78, 0.14)"),
    hairline: v("--border-hairline", "rgba(255, 255, 255, 0.09)"),
  };
}

async function loadFonts() {
  try {
    await Promise.all([document.fonts?.load(`600 64px Geist`), document.fonts?.load(`400 32px Geist`)]);
  } catch {
    /* the fallback stack draws instead */
  }
}

// The brand mark: the app icon's lime tile with its chevron.
function drawMark(ctx, x, y, s, c) {
  const r = s * 0.24;
  ctx.fillStyle = c.accent;
  ctx.beginPath();
  ctx.roundRect(x, y, s, s, r);
  ctx.fill();
  ctx.strokeStyle = c.accentContrast;
  ctx.lineWidth = s * 0.13;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x + s * 0.4, y + s * 0.28);
  ctx.lineTo(x + s * 0.62, y + s * 0.5);
  ctx.lineTo(x + s * 0.4, y + s * 0.72);
  ctx.stroke();
}

function text(ctx, str, x, y, { size, weight = 400, color, spacing = 0 }) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(str, x, y);
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
}

function lines(ctx, str, x, y, maxW, style, lineH, maxLines = 3) {
  ctx.font = `${style.weight ?? 400} ${style.size}px ${FONT}`;
  const out = wrapWords(str, maxW, (s) => ctx.measureText(s).width).slice(0, maxLines);
  out.forEach((l, i) => text(ctx, l, x, y + i * lineH, style));
  return y + out.length * lineH;
}

function background(ctx, w, h, c) {
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, h);
  const g = ctx.createRadialGradient(w * 0.85, 0, 0, w * 0.85, 0, Math.max(w, h) * 0.75);
  g.addColorStop(0, c.accentTint);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function drawStory(ctx, data, units, share, c) {
  const { w, h } = POSTER_SIZES.story;
  const pad = 96;
  const p = posterLines(data, units, { share });
  background(ctx, w, h, c);
  ctx.textBaseline = "alphabetic";

  drawMark(ctx, pad, pad, 76, c);
  text(ctx, "Track Evolution", pad + 100, pad + 52, { size: 40, weight: 600, color: c.strong });

  text(ctx, "SEASON WRAPPED", pad, 290, { size: 32, weight: 600, color: c.accentInk, spacing: 4 });
  let y = lines(ctx, p.title, pad, 390, w - pad * 2, { size: 92, weight: 600, color: c.strong }, 104, 3);

  // Budgeted so four summary rows, two of them wrapping, still fit above the
  // footer: 2 × 210 of numbers, then ~130 a row (~180 when it wraps).
  y += 50;
  const stats = posterStats(data, units);
  const colW = (w - pad * 2) / 2;
  stats.forEach(([v, l], i) => {
    const cx = pad + (i % 2) * colW;
    const cy = y + Math.floor(i / 2) * 210;
    let size = 140;
    ctx.font = `600 ${size}px ${FONT}`;
    while (size > 70 && ctx.measureText(v).width > colW - 30) ctx.font = `600 ${(size -= 10)}px ${FONT}`;
    text(ctx, v, cx, cy + 130, { size, weight: 600, color: c.accentInk });
    text(ctx, l, cx, cy + 180, { size: 38, color: c.muted });
  });
  y += Math.ceil(stats.length / 2) * 210 + 40;

  ctx.fillStyle = c.hairline;
  ctx.fillRect(pad, y, w - pad * 2, 2);
  y += 70;
  for (const [k, v] of p.rows) {
    if (y > h - 230) break;
    text(ctx, k, pad, y, { size: 32, color: c.muted });
    y = lines(ctx, v, pad, y + 56, w - pad * 2, { size: 44, weight: 600, color: c.strong }, 52, 2) + 22;
  }

  text(ctx, APP_HOST, pad, h - pad, { size: 36, weight: 500, color: c.muted });
}

function drawWide(ctx, data, units, share, c) {
  const { w, h } = POSTER_SIZES.wide;
  const pad = 64;
  const p = posterLines(data, units, { share });
  background(ctx, w, h, c);
  ctx.textBaseline = "alphabetic";

  drawMark(ctx, pad, pad, 52, c);
  text(ctx, "Track Evolution", pad + 70, pad + 36, { size: 28, weight: 600, color: c.strong });

  const leftW = 560;
  let y = lines(ctx, p.title, pad, 210, leftW, { size: 54, weight: 600, color: c.strong }, 62, 3);
  y += 20;
  lines(ctx, p.headline.join(" · "), pad, y + 20, leftW, { size: 28, weight: 500, color: c.accentInk }, 38, 3);

  const rx = pad + leftW + 60;
  const rw = w - rx - pad;
  // Four rows, two of them wrapping, fit: ~134 a wrapped row, ~98 a plain one.
  let ry = 130;
  for (const [k, v] of p.rows) {
    if (ry > h - 90) break;
    text(ctx, k, rx, ry, { size: 22, color: c.muted });
    ry = lines(ctx, v, rx, ry + 38, rw, { size: 30, weight: 600, color: c.strong }, 36, 2) + 24;
  }
  text(ctx, APP_HOST, pad, h - pad + 8, { size: 24, weight: 500, color: c.muted });
}

// The poster as a PNG blob. `size` is "story" or "wide".
export async function posterBlob(data, { units, share = false, size = "story" } = {}) {
  await loadFonts();
  const { w, h } = POSTER_SIZES[size];
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const c = tokens();
  (size === "wide" ? drawWide : drawStory)(ctx, data, units, share, c);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("couldn't draw the poster"))), "image/png")
  );
}

// Offer a blob as a download — the fallback wherever the Web Share API can't
// take a file (desktop Chrome and Firefox, mostly).
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Share a drawn poster through the system share sheet when the browser can
// share files (iOS Safari, Android Chrome), else download it. The blob is drawn
// *before* the tap — Safari only lets navigator.share run inside the tap's
// user activation, and a font load plus a 1080×1920 draw can outlast it. The
// file goes alone: several share targets drop an image that arrives beside a
// URL, and the link has its own Copy button. Resolves to "shared",
// "downloaded" or "cancelled".
export async function sharePosterBlob(blob, { name, title }) {
  const file = typeof File === "function" ? new File([blob], name, { type: "image/png" }) : null;
  if (file && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "cancelled";
      // Anything else (a NotAllowedError, say) falls through to the download.
    }
  }
  downloadBlob(blob, name);
  return "downloaded";
}
