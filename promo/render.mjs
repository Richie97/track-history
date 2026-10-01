// Render the promo: open video/index.html in Chromium, seek it frame by frame
// and encode the frames with ffmpeg — H.264, 1920×1080, 30 fps — then mux the
// score (out/score.wav, from audio/score.mjs), gain-matched to -14 LUFS.
//
//   node render.mjs                     the whole film → out/track-evolution-promo.mp4
//   node render.mjs --mux               re-mux the score into the last render only
//   node render.mjs --stills 3,12.5     single frames → out/stills/t-3.00.png …
//   node render.mjs --from 38 --to 52   a section, silent, for checking a scene in motion
//   node render.mjs --workers 2         frames rendered in parallel (default 3)
//
// ffmpeg comes from $FFMPEG or PATH; it needs libx264 and aac.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { PROMO, ROOT } from "./lib/worker.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const FPS = Number(opt("fps", 30));
const WORKERS = Math.max(1, Number(opt("workers", 3)));
const OUT = path.join(PROMO, "out");
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const SILENT = path.join(OUT, "video.mp4");
const FINAL = path.join(OUT, "track-evolution-promo.mp4");
const SCORE = path.join(OUT, "score.wav");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png", ".ttf": "font/ttf", ".css": "text/css", ".svg": "image/svg+xml" };

function ffmpeg(argv, opts = {}) {
  const r = spawnSync(FFMPEG, argv, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`ffmpeg ${argv.join(" ")}\n${r.stderr}`);
  return r.stderr;
}

// The score, measured (EBU R128) and brought to -14 LUFS with a static gain —
// no single-pass loudnorm, which would ride the level and flatten the hits.
function mux() {
  if (!existsSync(SCORE)) {
    console.log("no out/score.wav — run `node audio/score.mjs` first; leaving the video silent");
    return;
  }
  const measured = ffmpeg(["-hide_banner", "-i", SCORE, "-af", "ebur128", "-f", "null", "-"]);
  const integrated = Number(measured.match(/Summary:[\s\S]*?I:\s+(-?[\d.]+) LUFS/)[1]);
  const gain = (-14 - integrated).toFixed(2);
  ffmpeg(["-y", "-loglevel", "error", "-i", SILENT, "-i", SCORE, "-map", "0:v", "-map", "1:a",
    "-c:v", "copy", "-af", `volume=${gain}dB`, "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", FINAL]);
  console.log(`wrote ${path.relative(PROMO, FINAL)} (score ${integrated} LUFS → -14, ${gain} dB)`);
}

if (args.includes("--mux")) {
  mux();
  process.exit(0);
}

const browser = await chromium.launch({ args: ["--font-render-hinting=none", "--disable-lcd-text", "--force-color-profile=srgb"] });

// One page on the composition. The repo is served read-only under a made-up
// origin: the page loads the captures, data.json and the bundled Geist off disk.
async function openPage() {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.route("http://promo.local/**", (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, "");
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      console.error("404:", rel);
      return route.fulfill({ status: 404, body: "not found" });
    }
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  page.on("console", (m) => m.type() === "error" && console.error("console:", m.text()));
  await page.goto("http://promo.local/promo/video/index.html");
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60_000 });
  return page;
}

const stills = opt("stills");
if (stills) {
  const page = await openPage();
  const dir = path.join(OUT, "stills");
  mkdirSync(dir, { recursive: true });
  for (const t of stills.split(",").map(Number)) {
    const file = path.join(dir, `t-${t.toFixed(2)}.png`);
    await page.evaluate((t) => window.__seek(t), t);
    await page.screenshot({ path: file });
    console.log(file);
  }
  await browser.close();
  process.exit(0);
}

// Render frames [i0, i1) of the film to one H.264 segment.
async function renderSegment(page, i0, i1, file, progress) {
  const ff = spawn(FFMPEG, [
    "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
    "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-profile:v", "high",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", file,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  for (let i = i0; i < i1; i++) {
    await page.evaluate((t) => window.__seek(t), i / FPS);
    const buf = await page.screenshot({ type: "png" });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    progress();
  }
  ff.stdin.end();
  await new Promise((r, j) => ff.on("close", (code) => (code === 0 ? r() : j(new Error(`ffmpeg exited ${code}`)))));
}

const duration = await (await openPage()).evaluate(() => window.__duration);
const from = Number(opt("from", 0));
const to = Math.min(duration, Number(opt("to", duration)));
const section = from > 0 || to < duration;
const f0 = Math.round(from * FPS), f1 = Math.round(to * FPS);
const tmp = path.join(OUT, ".segments");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const chunk = Math.ceil((f1 - f0) / WORKERS);
let done = 0;
const t0 = Date.now();
const progress = () => {
  done++;
  if (done % FPS === 0) process.stdout.write(`\r${(done / FPS).toFixed(0)}s of ${((f1 - f0) / FPS).toFixed(0)}s rendered (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
};
const pages = await Promise.all(Array.from({ length: WORKERS }, () => openPage()));
const segments = [];
await Promise.all(pages.map((page, k) => {
  const a = f0 + k * chunk, b = Math.min(f1, a + chunk);
  if (a >= b) return null;
  const file = path.join(tmp, `seg-${k}.mp4`);
  segments[k] = file;
  return renderSegment(page, a, b, file, progress);
}));
await browser.close();
const list = path.join(tmp, "list.txt");
writeFileSync(list, segments.filter(Boolean).map((f) => `file '${f}'`).join("\n"));
const target = section ? path.join(OUT, `section-${from}-${to}.mp4`) : SILENT;
ffmpeg(["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", target]);
rmSync(tmp, { recursive: true, force: true });
console.log(`\nwrote ${path.relative(PROMO, target)} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (!section) mux();
