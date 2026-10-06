// Render the App Store app preview from appstore/preview.html:
//
//   node appstore/render-preview.mjs              → out/appstore/app-preview-886x1920.mp4
//   node appstore/render-preview.mjs --draft      every scene from its web stand-in
//   node appstore/render-preview.mjs --stills 2,9 single frames → out/appstore/stills/
//
// Each scene plays its clip of the native app, out/ios/<scene>.mov (or .mp4),
// from the second given in out/ios/trims.json ({ "<scene>": seconds }, default
// 0.5) — see ios-capture.sh. A scene with no clip falls back to a stand-in
// built from the web app's phone captures and is badged DRAFT, and the file is
// then named app-preview-886x1920-DRAFT.mp4: App Store Connect takes only
// captures of the app itself, so a draft is for judging the cut, never for
// upload.
//
// The output follows Apple's app preview specification: H.264 High Profile
// Level 4.0, progressive, 30 fps, ~11 Mbps, AAC 256 kbps stereo 48 kHz,
// 15–30 s. The score is the promo's (out/score.wav, from audio/score.mjs),
// excerpted from its analysis section and faded so the loop has no seam.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchStage, openStage } from "../lib/stage.mjs";
import { PROMO } from "../lib/worker.mjs";
import { DURATION, FPS, LEAD, SLOTS } from "./shots.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const OUT = path.join(PROMO, "out", "appstore");
const IOS = path.join(PROMO, "out", "ios");
const FRAMES = path.join(OUT, ".frames");
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const W = 886, H = 1920;
const SCREEN_W = 700; // preview.js's screen width
const draftOnly = args.includes("--draft");
// Where the score's excerpt starts: the analysis section, so its hits at 52
// and 64 s land on the preview's cuts at 14 and 26 s.
const SCORE_FROM = 38;

function ffmpeg(argv, opts = {}) {
  const r = spawnSync(FFMPEG, ["-hide_banner", ...argv], { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`ffmpeg ${argv.join(" ")}\n${r.stderr}`);
  return r.stderr;
}

// --- the native clips, as frames ------------------------------------------------
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
const trims = existsSync(path.join(IOS, "trims.json")) ? JSON.parse(readFileSync(path.join(IOS, "trims.json"), "utf8")) : {};
const manifest = {};
if (!draftOnly) {
  for (const s of SLOTS) {
    const src = [".mov", ".mp4", ".m4v"].map((e) => path.join(IOS, s.id + e)).find(existsSync);
    if (!src) continue;
    const dir = path.join(FRAMES, s.id);
    mkdirSync(dir, { recursive: true });
    const need = s.t1 - s.t0 + LEAD + 0.2;
    ffmpeg(["-loglevel", "error", "-ss", String(trims[s.id] ?? 0.5), "-i", src, "-t", String(need),
      "-vf", `fps=${FPS},scale=${SCREEN_W}:-2:flags=lanczos`, "-q:v", "2", path.join(dir, "%04d.jpg")]);
    const probe = spawnSync(FFMPEG.replace(/ffmpeg$/, "ffprobe"), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path.join(dir, "0001.jpg")], { encoding: "utf8" });
    const [w, h] = probe.stdout.trim().split(",").map(Number);
    const count = readdirCount(dir);
    if (count < Math.round((s.t1 - s.t0) * FPS)) console.warn(`${s.id}: the clip is ${(count / FPS).toFixed(1)} s from its trim, short of the scene's ${s.t1 - s.t0} s — its last frame holds`);
    manifest[s.id] = { count, w, h };
    console.log(`${s.id}: ${count} frames from ${path.relative(PROMO, src)}`);
  }
}
writeFileSync(path.join(FRAMES, "manifest.json"), JSON.stringify(manifest));
function readdirCount(dir) {
  let n = 0;
  while (existsSync(path.join(dir, `${String(n + 1).padStart(4, "0")}.jpg`))) n++;
  return n;
}

const browser = await launchStage();
const pagePath = `promo/appstore/preview.html${draftOnly ? "?draft" : ""}`;

const stills = opt("stills");
if (stills) {
  const page = await openStage(browser, pagePath, { width: W, height: H });
  const dir = path.join(OUT, "stills");
  mkdirSync(dir, { recursive: true });
  for (const t of stills.split(",").map(Number)) {
    const file = path.join(dir, `t-${t.toFixed(2)}.png`);
    await page.evaluate((t) => window.__seek(t), t);
    await page.screenshot({ path: file });
    console.log(path.relative(PROMO, file));
  }
  await browser.close();
  process.exit(0);
}

// --- frames → H.264 ---------------------------------------------------------------
const WORKERS = Math.max(1, Number(opt("workers", 3)));
const frames = Math.round(DURATION * FPS);
const tmp = path.join(OUT, ".segments");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const chunk = Math.ceil(frames / WORKERS);
let done = 0, drafts = 0;
const t0 = Date.now();
async function renderSegment(i0, i1, file) {
  const page = await openStage(browser, pagePath, { width: W, height: H });
  drafts = await page.evaluate(() => window.__drafts);
  // Lossless intermediates; the one lossy encode is the final pass below,
  // which sets the bit rate Apple asks for.
  const ff = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
    "-c:v", "libx264", "-preset", "veryfast", "-qp", "0", "-pix_fmt", "yuv444p", file], { stdio: ["pipe", "inherit", "inherit"] });
  for (let i = i0; i < i1; i++) {
    await page.evaluate((t) => window.__seek(t), i / FPS);
    const buf = await page.screenshot({ type: "png" });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if (++done % FPS === 0) process.stdout.write(`\r${(done / FPS).toFixed(0)}s of ${DURATION}s rendered (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  ff.stdin.end();
  await new Promise((r, j) => ff.on("close", (code) => (code === 0 ? r() : j(new Error(`ffmpeg exited ${code}`)))));
}
const segments = [];
await Promise.all(Array.from({ length: WORKERS }, (_, k) => {
  const a = k * chunk, b = Math.min(frames, a + chunk);
  if (a >= b) return null;
  const file = path.join(tmp, `seg-${k}.mkv`);
  segments[k] = file;
  return renderSegment(a, b, file);
}));
await browser.close();
const list = path.join(tmp, "list.txt");
writeFileSync(list, segments.filter(Boolean).map((f) => `file '${f}'`).join("\n"));

// --- the score ---------------------------------------------------------------------
const SCORE = path.join(PROMO, "out", "score.wav");
let audio = [];
if (existsSync(SCORE)) {
  const cut = path.join(tmp, "score.wav");
  ffmpeg(["-y", "-loglevel", "error", "-ss", String(SCORE_FROM), "-t", String(DURATION), "-i", SCORE,
    "-af", `afade=t=in:d=0.12,afade=t=out:st=${(DURATION - 1.6).toFixed(2)}:d=1.6`, "-ar", "48000", "-ac", "2", cut]);
  const measured = ffmpeg(["-i", cut, "-af", "ebur128", "-f", "null", "-"]);
  const integrated = Number(measured.match(/Summary:[\s\S]*?I:\s+(-?[\d.]+) LUFS/)[1]);
  const gain = (-16 - integrated).toFixed(2);
  audio = ["-i", cut, "-map", "0:v", "-map", "1:a", "-af", `volume=${gain}dB,alimiter=limit=0.89`, "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2"];
  console.log(`\nscore ${SCORE_FROM}–${SCORE_FROM + DURATION} s, ${integrated} LUFS → -16 (${gain} dB)`);
} else {
  // Apple wants an audio track; silence is a valid one.
  console.log("\nno out/score.wav — run `node audio/score.mjs` for the music; muxing silence");
  audio = ["-f", "lavfi", "-t", String(DURATION), "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "256k"];
}

const name = drafts ? `app-preview-${W}x${H}-DRAFT.mp4` : `app-preview-${W}x${H}.mp4`;
const final = path.join(OUT, name);
for (const stale of [`app-preview-${W}x${H}-DRAFT.mp4`, `app-preview-${W}x${H}.mp4`]) rmSync(path.join(OUT, stale), { force: true });
ffmpeg(["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, ...audio,
  "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-level:v", "4.0", "-pix_fmt", "yuv420p",
  "-b:v", "11M", "-maxrate", "12M", "-bufsize", "12M", "-r", String(FPS), "-g", String(FPS),
  "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
  "-t", String(DURATION), "-movflags", "+faststart", final]);
rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${path.relative(PROMO, final)} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (drafts) console.log(`${drafts} of ${SLOTS.length} scenes are web stand-ins — record them in the Simulator (appstore/ios-capture.sh) before uploading`);
