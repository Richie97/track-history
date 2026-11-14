// The landing page the Worker serves at https://trackevolution.app/ is derived
// from site/ by tools/landing.mjs. These fail when a committed output is not
// what the current site/ produces — edit site/, then `npm run landing:generate`.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SIGN_IN_PATH, landingHtml, outputs } from "../../tools/landing.mjs";

const ROOT = new URL("../../", import.meta.url);

describe("tools/landing.mjs", () => {
  it.each(Object.keys(outputs()))("%s is up to date with site/", (path) => {
    const want = outputs()[path];
    const have = readFileSync(new URL(path, ROOT), typeof want === "string" ? "utf8" : null);
    expect(Buffer.from(have).equals(Buffer.from(want)), `${path} is stale — run npm run landing:generate`).toBe(true);
  });

  const html = landingHtml(readFileSync(new URL("site/index.html", ROOT), "utf8"));

  it("leaves no link relative to the docs site", () => {
    const refs = [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
    expect(refs.filter((r) => !/^(https?:|\/|#|mailto:)/.test(r))).toEqual([]);
    expect(html).toContain('href="https://docs.trackevolution.app/docs/track-days.html"');
  });

  it("opens the app at the sign-in path, never back at itself", () => {
    expect(html).toContain(`<a class="btn primary" href="${SIGN_IN_PATH}">Open the app</a>`);
    expect(html).not.toContain('href="https://trackevolution.app"');
    // The service worker caches the shell under the same path.
    expect(readFileSync(new URL("public/sw.js", ROOT), "utf8")).toContain(`const SHELL_URL = "${SIGN_IN_PATH}";`);
  });

  it("is canonical at the app's own home", () => {
    expect(html).toContain('<link rel="canonical" href="https://trackevolution.app/">');
  });

  it("stops when the source page changes shape", () => {
    expect(() => landingHtml("<html></html>")).toThrow(/nothing to rewrite/);
  });
});
