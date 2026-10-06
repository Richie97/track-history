import { Hono } from "hono";
import type { AppContext } from "../types";
import { APP_STORE_URL, PLAY_STORE_URL, storeFor, storeUrl } from "../lib/storeLinks";

// GET /get — one link to hand out for "download the app": a phone is
// redirected to its own store listing, and anything else (a desktop, a link
// preview scraper) gets a page offering both. In run_worker_first, since the
// SPA fallback would otherwise answer it with index.html.
export const download = new Hono<AppContext>();

const TITLE = "Get Track Evolution";
const DESCRIPTION =
  "The track-day logbook for iPhone, iPad, Mac and Android — record laps with your phone's GPS, import telemetry, and watch your times fall.";

download.get("/", (c) => {
  // The answer depends on the User-Agent, so no cache may share it across devices.
  c.header("Vary", "User-Agent");
  c.header("Cache-Control", "no-store");
  const platform = storeFor(c.req.header("User-Agent"));
  if (platform) return c.redirect(storeUrl(platform), 302);

  const nonce = crypto.randomUUID().replace(/-/g, "");
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; ")
  );
  // og:url / og:image are absolute on purpose: link scrapers require it.
  return c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${TITLE}</title>
<meta name="description" content="${DESCRIPTION}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Track Evolution" />
<meta property="og:title" content="${TITLE}" />
<meta property="og:description" content="${DESCRIPTION}" />
<meta property="og:url" content="https://trackevolution.app/get" />
<meta property="og:image" content="https://trackevolution.app/og-image.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="Track Evolution — your track days, remembered lap by lap" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="stylesheet" href="/style.css" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<script nonce="${nonce}">
  // iPadOS Safari reports itself as a Mac; a Mac has no touch screen.
  if (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) location.replace(${JSON.stringify(APP_STORE_URL)});
</script>
</head>
<body>
<div class="login-wrap"><div class="login-card">
<div class="flag"><img src="/favicon.svg" alt="" width="56" height="56" /></div>
<h1>${TITLE}</h1>
<p>The track-day logbook, on your phone.</p>
<div class="login-buttons">
<a class="btn primary" href="${APP_STORE_URL}">Download for iPhone, iPad and Mac</a>
<a class="btn primary" href="${PLAY_STORE_URL}">Download for Android</a>
</div>
<p class="login-store"><a href="/">Or use it in your browser →</a></p>
</div></div>
</body>
</html>`);
});
