// The docs site's search and answer-engine plumbing (site/): every page names
// its own canonical URL, is listed in sitemap.xml and llms.txt, and carries
// structured data that parses — and the landing page's FAQ markup says what
// the visible FAQ says. A page added without these fails here.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const BASE = "https://docs.trackevolution.app";
const read = (p) => readFileSync(new URL(`../../site/${p}`, import.meta.url), "utf8");
const docs = readdirSync(new URL("../../site/docs", import.meta.url)).filter((f) => f.endsWith(".html"));
const pages = ["index.html", ...docs.map((f) => `docs/${f}`)];
// The landing page's canonical home is the app's own domain, where the Worker
// serves the same page to signed-out visitors (tools/landing.mjs); the copy on
// the docs host points there, and so stays out of the docs sitemap.
const HOME = "https://trackevolution.app/";
const urlOf = (p) => (p === "index.html" ? HOME : `${BASE}/${p.replace(/index\.html$/, "")}`);
const jsonLd = (html) =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
// The visible text of a fragment of our own markup. Tags are removed until
// none is left, so nothing a removal uncovers survives as a tag.
const plain = (s) => {
  let prev;
  do {
    prev = s;
    s = s.replace(/<[^>]+>/g, "");
  } while (s !== prev);
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
};

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
    if (url !== HOME) expect(sitemap).toContain(`<loc>${url}</loc>`);
    expect(llms).toContain(`(${url})`);
  });

  // A guide's screenshots (promo/guides.mjs): each is a dark image with a
  // light alternative, both on disk, described and sized.
  it.each(pages)("%s's images exist, in both colour schemes, with alt text", (p) => {
    const html = read(p);
    const dir = p.includes("/") ? "docs/" : "";
    const onDisk = (rel) => existsSync(new URL(`../../site/${dir}${rel.replace(/^\.\//, "")}`, import.meta.url));
    for (const [, src] of html.matchAll(/<(?:img src|source [^>]*srcset)="(\.\/img\/[^"]+)"/g)) expect(onDisk(src), src).toBe(true);
    for (const [fig] of html.matchAll(/<figure class="shot">[\s\S]*?<\/figure>/g)) {
      const name = fig.match(/<img src="\.\/img\/([a-z-]+)-dark\.webp"/)?.[1];
      expect(name, "a shot's <img> is the dark image").toBeTruthy();
      expect(fig).toContain(`<source media="(prefers-color-scheme: light)" srcset="./img/${name}-light.webp">`);
      expect(fig).toMatch(/<img [^>]*alt="[^"]{20,}"[^>]* width="\d+" height="\d+"/);
      expect(fig).toMatch(/<figcaption>[^<]+<\/figcaption>/);
    }
  });

  it("lists nothing in the sitemap that isn't a page", () => {
    const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    expect(locs.sort()).toEqual(pages.map(urlOf).filter((u) => u !== HOME).sort());
    const appSitemap = readFileSync(new URL("../../public/sitemap.xml", import.meta.url), "utf8");
    expect(appSitemap).toContain(`<loc>${HOME}</loc>`);
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

  // A numbered list marked `<ol id="howto-…">` is a procedure, and the page's
  // HowTo markup is those steps (tools/site-howto.mjs writes it). Worked out
  // here independently of the tool, so an edited step without a regenerate,
  // or a HowTo with no list behind it, fails.
  const HOWTO_PAGES = [
    "docs/index.html",
    "docs/lap-recording.html",
    "docs/ai.html",
    "docs/account-deletion.html",
    "docs/corvette-pdr-lap-times.html",
    "docs/cadillac-blackwing-pdr-lap-times.html",
    "docs/gopro-lap-times.html",
    "docs/aim-smartycam-lap-times.html",
    "docs/vbo-file-lap-times.html",
    "docs/porsche-track-precision-export.html",
  ];
  it.each(pages)("%s marks up the steps it shows as HowTo, word for word", (p) => {
    const html = read(p);
    const url = urlOf(p);
    const h1 = plain(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)[1]);
    const shown = [...html.matchAll(/<ol id="(howto-[a-z0-9-]+)">([\s\S]*?)<\/ol>/g)].map((m) => {
      const heading = [...html.slice(0, m.index).matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/g)].at(-1);
      return {
        id: `${url}#${m[1]}`,
        name: `${h1}: ${plain(heading[1])}`,
        steps: [...m[2].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((li) => plain(li[1])),
      };
    });
    const marked = jsonLd(html)
      .flatMap((d) => d["@graph"] ?? [d])
      .filter((n) => n["@type"] === "HowTo")
      .map((n) => {
        expect(n.step.map((s) => [s["@type"], s.position])).toEqual(n.step.map((_, i) => ["HowToStep", i + 1]));
        return { id: n["@id"], name: n.name, steps: n.step.map((s) => s.text) };
      });
    expect(marked).toEqual(shown);
    for (const h of shown) {
      expect(h.steps.length).toBeGreaterThan(1);
      for (const s of h.steps) expect(s.length).toBeGreaterThan(10);
    }
    expect(shown.length > 0, "the step-by-step pages each carry a HowTo").toBe(HOWTO_PAGES.includes(p));
  });

  it("prices the app in structured data as the pricing section does", () => {
    const html = read("index.html");
    const app = jsonLd(html)[0]["@graph"].find((n) => [].concat(n["@type"]).includes("SoftwareApplication"));
    for (const offer of app.offers.filter((o) => o.price !== "0")) expect(html).toContain(`$${offer.price}<span>`);
    // No rating or review is claimed: the site has no source for one.
    expect(app.aggregateRating).toBeUndefined();
  });
});
