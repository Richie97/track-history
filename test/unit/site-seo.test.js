// The docs site's search and answer-engine plumbing (site/): every page names
// its own canonical URL, is listed in sitemap.xml and llms.txt, and carries
// structured data that parses — and the landing page's FAQ markup says what
// the visible FAQ says. A page added without these fails here.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const BASE = "https://docs.trackevolution.app";
const read = (p) => readFileSync(new URL(`../../site/${p}`, import.meta.url), "utf8");
const docs = readdirSync(new URL("../../site/docs", import.meta.url)).filter((f) => f.endsWith(".html"));
const pages = ["index.html", ...docs.map((f) => `docs/${f}`)];
const urlOf = (p) => `${BASE}/${p.replace(/index\.html$/, "")}`;
const jsonLd = (html) =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const plain = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

describe("site pages", () => {
  const sitemap = read("sitemap.xml");
  const llms = read("llms.txt");

  it.each(pages)("%s has a canonical, a description and structured data", (p) => {
    const html = read(p);
    const url = urlOf(p);
    expect(html).toContain(`<link rel="canonical" href="${url}">`);
    expect(html).toContain(`<meta property="og:url" content="${url}">`);
    const title = html.match(/<title>([^<]*)<\/title>/)[1];
    expect(html).toContain(`<meta property="og:title" content="${title}">`);
    const desc = html.match(/<meta name="description" content="([^"]*)">/)[1];
    expect(desc.length).toBeGreaterThan(50);
    expect(html).toContain(`<meta property="og:description" content="${desc}">`);
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(jsonLd(html).length).toBeGreaterThan(0); // throws if it doesn't parse
    expect(sitemap).toContain(`<loc>${url}</loc>`);
    expect(llms).toContain(`(${url})`);
  });

  it("lists nothing in the sitemap that isn't a page", () => {
    const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    expect(locs.sort()).toEqual(pages.map(urlOf).sort());
  });

  it("points robots.txt at the sitemap and blocks nothing", () => {
    const robots = read("robots.txt");
    expect(robots).toContain(`Sitemap: ${BASE}/sitemap.xml`);
    expect(robots).not.toMatch(/^Disallow: \S/m);
  });

  it("marks up the FAQ the landing page shows, word for word", () => {
    const html = read("index.html");
    const shown = [...html.matchAll(/<div class="faq-item">\s*<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)].map((m) => [
      plain(m[1]),
      plain(m[2]),
    ]);
    const faq = jsonLd(html)[0]["@graph"].find((n) => n["@type"] === "FAQPage");
    expect(shown.length).toBeGreaterThan(0);
    expect(faq.mainEntity.map((q) => [q.name, q.acceptedAnswer.text])).toEqual(shown);
  });

  it("prices the app in structured data as the pricing section does", () => {
    const html = read("index.html");
    const app = jsonLd(html)[0]["@graph"].find((n) => [].concat(n["@type"]).includes("SoftwareApplication"));
    for (const offer of app.offers.filter((o) => o.price !== "0")) expect(html).toContain(`$${offer.price}<span>`);
    // No rating or review is claimed: the site has no source for one.
    expect(app.aggregateRating).toBeUndefined();
  });
});
