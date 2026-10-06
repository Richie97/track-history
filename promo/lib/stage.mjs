// Open one of the promo's composition pages (video/index.html,
// appstore/header.html, appstore/preview.html) in Chromium, with the repo
// served read-only under a made-up origin so the page can load the captures,
// out/data.json, public/js modules and the bundled Geist off disk.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { ROOT } from "./worker.mjs";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".ttf": "font/ttf", ".css": "text/css", ".svg": "image/svg+xml" };

export function launchStage() {
  return chromium.launch({ args: ["--font-render-hinting=none", "--disable-lcd-text", "--force-color-profile=srgb"] });
}

// `page` is a path relative to the repo root, query string allowed.
export async function openStage(browser, page, { width, height }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.route("http://promo.local/**", (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, "");
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      console.error("404:", rel);
      return route.fulfill({ status: 404, body: "not found" });
    }
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  p.on("pageerror", (e) => console.error("pageerror:", e.message));
  p.on("console", (m) => ["error", "warning"].includes(m.type()) && console.error(`console.${m.type()}:`, m.text()));
  await p.goto(`http://promo.local/${page}`);
  await p.waitForFunction(() => window.__ready === true, null, { timeout: 120_000 });
  return p;
}
