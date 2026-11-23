// Writes the HowTo structured data on the docs pages from the steps the
// pages show (#458). A numbered list marked `<ol id="howto-…">` is a
// procedure; this puts one schema.org HowTo node per such list at the end of
// the page's JSON-LD @graph, one HowToStep per <li>, the step's text being
// the item's visible text. Its name is the page's <h1> and the heading the
// list sits under, so nothing is marked up that the page doesn't say.
//
//   npm run site:howto
//
// Run it after editing a marked list (or marking a new one);
// test/unit/site-seo.test.js fails until the markup says what the page does.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const DOCS = new URL("../site/docs/", import.meta.url);
const BASE = "https://docs.trackevolution.app/docs/";

// The visible text of a fragment of our own markup.
const plain = (s) => {
  let prev;
  do {
    prev = s;
    s = s.replace(/<[^>]+>/g, "");
  } while (s !== prev);
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
};

export function howTos(html, url) {
  const h1 = plain(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)[1]);
  const nodes = [];
  for (const m of html.matchAll(/<ol id="(howto-[a-z0-9-]+)">([\s\S]*?)<\/ol>/g)) {
    const headings = [...html.slice(0, m.index).matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/g)];
    if (!headings.length) throw new Error(`${url}: #${m[1]} has no heading above it`);
    const steps = [...m[2].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((li) => plain(li[1]));
    if (steps.length < 2) throw new Error(`${url}: #${m[1]} needs at least two steps`);
    nodes.push({
      "@type": "HowTo",
      "@id": `${url}#${m[1]}`,
      name: `${h1}: ${plain(headings.at(-1)[1])}`,
      inLanguage: "en",
      isPartOf: { "@id": `${url}#page` },
      step: steps.map((text, i) => ({ "@type": "HowToStep", position: i + 1, text })),
    });
  }
  return nodes;
}

// The @graph's close, as every docs page writes it.
const GRAPH_END = "\n    ]\n  }\n  </script>";
const HOWTO_START = ',\n      {\n        "@type": "HowTo"';

export function withHowTos(html, url) {
  const end = html.indexOf(GRAPH_END);
  if (end < 0) throw new Error(`${url}: no JSON-LD @graph to add to`);
  const old = html.lastIndexOf(HOWTO_START, end);
  const head = html.slice(0, old < 0 ? end : html.indexOf(HOWTO_START));
  const nodes = howTos(html, url)
    .map((n) => ",\n" + JSON.stringify(n, null, 2).replace(/^/gm, "      "))
    .join("");
  return head + nodes + html.slice(end);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const f of readdirSync(DOCS).filter((f) => f.endsWith(".html"))) {
    const path = new URL(f, DOCS);
    const html = readFileSync(path, "utf8");
    const next = withHowTos(html, BASE + f.replace(/^index\.html$/, ""));
    if (next !== html) {
      writeFileSync(path, next);
      console.log(`wrote ${f}`);
    }
  }
}
