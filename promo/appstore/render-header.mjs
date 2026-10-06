// Render the App Store creative assets from appstore/header.html:
//
//   out/appstore/universal-5244x2950.png   the universal asset (header + search results)
//   out/appstore/header-3840x1646.png      the product page header on its own (21:9)
//   out/appstore/search-3840x2560.png      the search results asset on its own (3:2)
//   out/appstore/guides.jpg                the canvas with both crops and the safe area drawn
//
// Upload the universal one, or the two dedicated ones — they are crops of the
// same canvas, so they agree either way. All are opaque RGB, as App Store
// Connect requires. Needs `node capture.mjs` first (for out/data.json) and an
// ffmpeg on PATH or in $FFMPEG.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { launchStage, openStage } from "../lib/stage.mjs";
import { PROMO } from "../lib/worker.mjs";

const OUT = path.join(PROMO, "out", "appstore");
mkdirSync(OUT, { recursive: true });
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const W = 5244, H = 2950;

function ffmpeg(argv) {
  const r = spawnSync(FFMPEG, ["-y", "-loglevel", "error", ...argv], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg ${argv.join(" ")}\n${r.stderr}`);
}

const browser = await launchStage();
const page = await openStage(browser, "promo/appstore/header.html", { width: W, height: H });
const crops = await page.evaluate(() => window.__crops);
const raw = path.join(OUT, ".universal.png");
await page.screenshot({ path: raw });
await page.close();

const guided = await openStage(browser, "promo/appstore/header.html?guides", { width: W, height: H });
const rawGuides = path.join(OUT, ".guides.png");
await guided.screenshot({ path: rawGuides });
await browser.close();

const rgb = ["-pix_fmt", "rgb24", "-frames:v", "1", "-update", "1"];
const crop = (r) => `crop=${Math.round(r.w)}:${Math.round(r.h)}:${Math.round(r.x)}:${Math.round(r.y)}`;
ffmpeg(["-i", raw, ...rgb, path.join(OUT, `universal-${W}x${H}.png`)]);
ffmpeg(["-i", raw, "-vf", `${crop(crops.header)},scale=3840:1646:flags=lanczos`, ...rgb, path.join(OUT, "header-3840x1646.png")]);
ffmpeg(["-i", raw, "-vf", `${crop(crops.search)},scale=3840:2560:flags=lanczos`, ...rgb, path.join(OUT, "search-3840x2560.png")]);
ffmpeg(["-i", rawGuides, "-vf", "scale=1920:-2", "-q:v", "3", "-frames:v", "1", "-update", "1", path.join(OUT, "guides.jpg")]);
rmSync(raw);
rmSync(rawGuides);
for (const f of [`universal-${W}x${H}.png`, "header-3840x1646.png", "search-3840x2560.png", "guides.jpg"]) console.log(`wrote out/appstore/${f}`);
