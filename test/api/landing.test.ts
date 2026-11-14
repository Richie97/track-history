import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// GET / (src/routes/landing.ts): the landing page for a visitor with no
// session cookie, the app shell for anyone carrying one.
describe("GET /", () => {
  it("serves the landing page to a visitor with no session", async () => {
    const res = await SELF.fetch("https://example.com/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    // The service worker reads this to keep the page out of its shell cache.
    expect(res.headers.get("x-te-page")).toBe("landing");
    expect(res.headers.get("vary")).toContain("Cookie");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    const html = await res.text();
    expect(html).toContain("Questions drivers ask");
    expect(html).toContain('"@type": "FAQPage"');
    expect(html).toContain('<link rel="canonical" href="https://trackevolution.app/">');
    expect(html).not.toContain('src="/app.js"');
  });

  it("serves the app shell to anyone carrying a session cookie", async () => {
    // Presence decides, not validity: a stale cookie gets the shell, whose own
    // sign-in screen takes over.
    const res = await SELF.fetch("https://example.com/", { headers: { Cookie: "session=whatever" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-te-page")).toBeNull();
    expect(res.headers.get("vary")).toContain("Cookie");
    const html = await res.text();
    expect(html).toContain('<script type="module" src="/app.js"></script>');
    expect(html).not.toContain("Questions drivers ask");
  });
});
