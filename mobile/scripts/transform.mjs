// Pure index.html transform applied by sync-www.mjs when copying ../public
// into www/. Kept side-effect-free so test/unit/mobile-sync.test.js can cover
// it. Throws (rather than silently passing content through) when public/
// drifts from what the transform expects — the markers, the app.js script
// tag, and the viewport meta in public/index.html are load-bearing for the
// native build.

const STRIP_START = "<!-- native:strip-start";
const STRIP_END = "<!-- native:strip-end -->";
const APP_SCRIPT = '<script type="module" src="/app.js"></script>';
const NATIVE_SCRIPT = '<script type="module" src="/native.js"></script>';

// In the native shells the WebView is the whole app, so viewport zoom is
// locked: it stops iOS auto-zooming (and staying zoomed) when an input with
// sub-16px text focuses, and disables pinch/double-tap zoom. The web build
// keeps the unlocked viewport — browser zoom is an accessibility feature.
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />';
const NATIVE_VIEWPORT =
  '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />';

export function transformIndexHtml(html) {
  const start = html.indexOf(STRIP_START);
  const end = html.indexOf(STRIP_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      "public/index.html is missing the native:strip markers around the service-worker block"
    );
  }
  const stripped =
    html.slice(0, start) + html.slice(end + STRIP_END.length);

  if (!stripped.includes(APP_SCRIPT)) {
    throw new Error(`public/index.html no longer contains ${APP_SCRIPT}`);
  }
  if (!stripped.includes(VIEWPORT)) {
    throw new Error(`public/index.html no longer contains ${VIEWPORT}`);
  }
  // native.js sets up the platform seam, then dynamically imports app.js.
  return stripped.replace(APP_SCRIPT, NATIVE_SCRIPT).replace(VIEWPORT, NATIVE_VIEWPORT);
}
