// Pure index.html transform applied by sync-www.mjs when copying ../public
// into www/. Kept side-effect-free so test/unit/mobile-sync.test.js can cover
// it. Throws (rather than silently passing content through) when public/
// drifts from what the transform expects — the markers and the app.js script
// tag in public/index.html are load-bearing for the native build.

const STRIP_START = "<!-- native:strip-start";
const STRIP_END = "<!-- native:strip-end -->";
const APP_SCRIPT = '<script type="module" src="/app.js"></script>';
const NATIVE_SCRIPT = '<script type="module" src="/native.js"></script>';

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
  // native.js sets up the platform seam, then dynamically imports app.js.
  return stripped.replace(APP_SCRIPT, NATIVE_SCRIPT);
}
