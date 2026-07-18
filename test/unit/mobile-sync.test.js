import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { transformIndexHtml } from "../../mobile/scripts/transform.mjs";

// The mobile sync script rewrites public/index.html for the native shell.
// These tests pin both the transform behavior and the drift guard: if the
// markers or the app.js script tag disappear from public/index.html, the
// native build must fail loudly, not ship a broken shell.

const realIndex = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");

describe("transformIndexHtml", () => {
  it("strips the service-worker block and swaps the entry to native.js", () => {
    const out = transformIndexHtml(realIndex);
    expect(out).not.toContain("serviceWorker");
    expect(out).not.toContain("native:strip");
    expect(out).not.toContain('src="/app.js"');
    expect(out).toContain('<script type="module" src="/native.js"></script>');
  });

  it("locks viewport zoom in the native build only", () => {
    const out = transformIndexHtml(realIndex);
    expect(out).toContain("maximum-scale=1, user-scalable=no");
    // the web build's viewport must stay unlocked (browser zoom is a11y)
    expect(realIndex).not.toContain("user-scalable");
  });

  it("keeps the rest of the document intact", () => {
    const out = transformIndexHtml(realIndex);
    expect(out).toContain('<div id="app"></div>');
    expect(out).toContain("manifest.webmanifest");
    expect(out).toContain("viewport-fit=cover");
  });

  it("fails when the strip markers are missing", () => {
    const noMarkers = realIndex
      .replace(/<!-- native:strip-start[^>]*-->/, "")
      .replace("<!-- native:strip-end -->", "");
    expect(() => transformIndexHtml(noMarkers)).toThrow(/native:strip markers/);
  });

  it("fails when the app.js entry script is missing", () => {
    const noEntry = realIndex.replace('<script type="module" src="/app.js"></script>', "");
    expect(() => transformIndexHtml(noEntry)).toThrow(/no longer contains/);
  });

  it("fails when the viewport meta drifts", () => {
    const drifted = realIndex.replace("viewport-fit=cover", "viewport-fit=auto");
    expect(() => transformIndexHtml(drifted)).toThrow(/no longer contains/);
  });
});
