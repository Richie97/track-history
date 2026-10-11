import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { APP_STORE_URL, PLAY_STORE_URL } from "../../src/lib/storeLinks";

const get = (ua?: string) =>
  SELF.fetch("https://example.com/get", { redirect: "manual", headers: ua ? { "User-Agent": ua } : {} });

describe("GET /get", () => {
  it("redirects an iPhone to the App Store", async () => {
    const res = await get("Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Mobile/15E148 Safari/604.1");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(APP_STORE_URL);
    expect(res.headers.get("Vary")).toContain("User-Agent");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("redirects an Android phone to Play", async () => {
    const res = await get("Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0.0.0 Mobile Safari/537.36");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(PLAY_STORE_URL);
  });

  it("shows both links, with link-preview tags, to anything else", async () => {
    for (const ua of ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0", undefined]) {
      const res = await get(ua);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(res.headers.get("Vary")).toContain("User-Agent");
      const html = await res.text();
      expect(html).toContain(`href="${APP_STORE_URL}"`);
      expect(html).toContain(`href="${PLAY_STORE_URL}"`);
      expect(html).toContain('property="og:url" content="https://trackevolution.app/get"');
      // The iPad-as-Mac script runs under a per-response nonce, nothing else does.
      const nonce = html.match(/<script nonce="([0-9a-f]+)">/)?.[1];
      expect(nonce).toBeTruthy();
      expect(res.headers.get("Content-Security-Policy")).toContain(`script-src 'nonce-${nonce}'`);
    }
  });
});
