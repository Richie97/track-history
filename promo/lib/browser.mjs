// Chromium for filming the app and rendering the video, with Geist served
// from the copies the Android app bundles (SIL OFL 1.1, license in
// apps/android/app/src/main/assets/licenses/) — so a render needs no font
// download and looks the same on every machine.

import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { ROOT } from "./worker.mjs";

const FONT_DIR = path.join(ROOT, "apps", "android", "app", "src", "main", "res", "font");
export const GEIST = readFileSync(path.join(FONT_DIR, "geist_variable.ttf"));
export const GEIST_MONO = readFileSync(path.join(FONT_DIR, "geist_mono_variable.ttf"));

// What public/style.css's Google Fonts @import resolves to, pointed at the
// local files instead.
export const FONT_CSS = `
@font-face { font-family: "Geist"; font-style: normal; font-weight: 100 900; font-display: block;
  src: url("https://fonts.gstatic.com/promo/geist.ttf") format("truetype"); }
@font-face { font-family: "Geist Mono"; font-style: normal; font-weight: 100 900; font-display: block;
  src: url("https://fonts.gstatic.com/promo/geist-mono.ttf") format("truetype"); }
`;

export async function launch() {
  return chromium.launch({ args: ["--font-render-hinting=none", "--disable-lcd-text"] });
}

// A context that renders like a real device in dark mode, with fonts local
// and every other off-machine request refused (the app needs none).
export async function newContext(browser, { width, height, scale = 2, mobile = false, base }) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: "dark",
    reducedMotion: "reduce",
    // The PWA service worker would fetch the font CSS itself, past the
    // routes below; nothing here needs it.
    serviceWorkers: "block",
    timezoneId: "America/Chicago",
    locale: "en-US",
  });
  await ctx.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("https://fonts.googleapis.com/")) {
      return route.fulfill({ status: 200, contentType: "text/css", body: FONT_CSS });
    }
    if (url === "https://fonts.gstatic.com/promo/geist.ttf") {
      return route.fulfill({ status: 200, contentType: "font/ttf", body: GEIST });
    }
    if (url === "https://fonts.gstatic.com/promo/geist-mono.ttf") {
      return route.fulfill({ status: 200, contentType: "font/ttf", body: GEIST_MONO });
    }
    if (base && url.startsWith(base)) return route.continue();
    if (url.startsWith("file:") || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
    return route.abort();
  });
  return ctx;
}
