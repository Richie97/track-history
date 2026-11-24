import { fmtMs } from "./export";

// The public track pages (#457): one indexable page per track_catalog row at
// https://trackevolution.app/tracks/<slug>, an index at /tracks and a sitemap
// at /tracks/sitemap.xml. Pure: the route (routes/trackPages.ts) reads D1 and
// hands the rows here.
//
// The privacy rule is that a page names no driver. It carries the catalog's
// own facts (name, length, coordinates) and, from the drivers who opted in to
// the leaderboards, a count and their best device-timed laps as bare times —
// no name, no date, no car, nothing user-entered, no telemetry. TrackStats is
// the whole of what a page may say about drivers; keep it that narrow.

export const APP_ORIGIN = "https://trackevolution.app";
export const DOCS_ORIGIN = "https://docs.trackevolution.app";
// How many unnamed best laps a page lists.
export const PUBLIC_TOP_LAPS = 10;

export type CatalogTrackRow = {
  id: number;
  name: string;
  length_m: number | null;
  lat: number | null;
  lon: number | null;
};

export type TrackStats = {
  // Opted-in drivers with a device-timed lap at the track.
  drivers: number;
  // Their bests, fastest first, at most PUBLIC_TOP_LAPS.
  best_ms: number[];
};

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;"
  );
}

// "Virginia International Raceway (Full)" → "virginia-international-raceway-full".
// The slug is derived, never stored: catalog names change only by migration,
// and test/api/track-pages.test.ts fails if two rows ever share one.
export function trackSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// The venue a catalog name belongs to: the name without its trailing layout.
export function venueOf(name: string): string {
  return name.replace(/\s*\([^()]*\)\s*$/, "").trim();
}

// "3.27 mi (5.26 km)" — both systems, since a public page has no account.
export function fmtLength(lengthM: number | null): string | null {
  if (lengthM == null || !(lengthM > 0)) return null;
  return `${(lengthM / 1609.344).toFixed(2)} mi (${(lengthM / 1000).toFixed(2)} km)`;
}

export function trackUrl(name: string): string {
  return `${APP_ORIGIN}/tracks/${trackSlug(name)}`;
}

export function findBySlug<T extends { name: string }>(rows: T[], slug: string): T | null {
  return rows.find((r) => trackSlug(r.name) === slug) ?? null;
}

// Other catalog rows at the same venue (other layouts), by name.
export function sameVenue<T extends { id: number; name: string }>(rows: T[], track: T): T[] {
  const venue = venueOf(track.name).toLowerCase();
  return rows.filter((r) => r.id !== track.id && venueOf(r.name).toLowerCase() === venue);
}

function driversText(n: number): string {
  return n === 1 ? "1 driver" : `${n} drivers`;
}

export function trackDescription(track: CatalogTrackRow, stats: TrackStats): string {
  const length = fmtLength(track.length_m);
  const facts = length ? ` The lap is ${length}.` : "";
  if (stats.drivers > 0 && stats.best_ms.length) {
    return `Lap times at ${track.name}: the fastest GPS-timed lap logged by Track Evolution drivers is ${fmtMs(
      stats.best_ms[0]
    )}, from ${driversText(stats.drivers)}.${facts}`;
  }
  return `Lap times at ${track.name}.${facts} Time your own laps there with your phone or your car's video, and track them in a free logbook.`;
}

const STAR =
  '<svg class="footer-vob-star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>';

const WEBSITE = { "@type": "WebSite", "@id": `${APP_ORIGIN}/#website`, name: "Track Evolution", url: `${APP_ORIGIN}/` };
const ORG = { "@type": "Organization", "@id": `${APP_ORIGIN}/#org`, name: "Track Evolution", url: `${APP_ORIGIN}/` };

// JSON-LD inside a <script>: "<" must not be able to close the element.
function jsonLd(graph: unknown[]): string {
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }, null, 2).replace(/</g, "\\u003c");
}

function breadcrumbs(items: Array<{ name: string; item: string }>) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, ...it })),
  };
}

// The page chrome the docs site uses, with every link absolute for this host.
function page(opts: {
  title: string;
  description: string;
  url: string;
  graph: unknown[];
  body: string;
  noindex?: boolean;
}): string {
  const t = esc(opts.title);
  const d = esc(opts.description);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${t}</title>
  <meta name="description" content="${d}">
${opts.noindex ? '  <meta name="robots" content="noindex">\n' : ""}  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Track Evolution">
  <meta property="og:title" content="${t}">
  <meta property="og:description" content="${d}">
  <meta property="og:url" content="${opts.url}">
  <meta property="og:image" content="${APP_ORIGIN}/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Track Evolution — your track days, remembered lap by lap">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="${opts.url}">
${opts.graph.length ? `  <script type="application/ld+json">\n${jsonLd(opts.graph)}\n  </script>\n` : ""}  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/site/site.css">
  <!-- Google Analytics, behind the UK/EU consent banner (analytics.js) -->
  <script src="/site/analytics.js" defer></script>
</head>
<body>

<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/">
      <img src="/favicon.svg" alt="" width="26" height="26">
      Track Evolution
    </a>
    <nav class="site-nav">
      <a href="/">Home</a>
      <a href="/tracks" class="active">Tracks</a>
      <a href="${DOCS_ORIGIN}/docs/">Docs</a>
    </nav>
  </div>
</header>

<div class="wrap">
  <main class="docs-content" style="margin: 0 auto; padding: 48px 0 72px">
${opts.body}
  </main>
</div>

<footer class="site-footer">
  <div class="wrap">
    <span class="footer-about">
      <span>Track Evolution — a personal HPDE / track-day logbook.</span>
      <span class="footer-vob">${STAR}Veteran-owned business · Speedshift LLC</span>
    </span>
    <span>
      <a href="/tracks">Tracks</a> ·
      <a href="${DOCS_ORIGIN}/docs/">Docs</a> ·
      <a href="${DOCS_ORIGIN}/docs/privacy.html">Privacy</a> ·
      <a href="${DOCS_ORIGIN}/docs/terms.html">Terms</a> ·
      <button type="button" class="footer-cookies" data-consent-open>Cookies</button>
    </span>
  </div>
</footer>

</body>
</html>
`;
}

const CTA = `    <p class="cta" style="justify-content: flex-start; margin-top: 24px">
      <a class="btn primary" href="/get">Get the app</a>
      <a class="btn" href="/login">Use it in your browser</a>
    </p>`;

export function trackPageHtml(track: CatalogTrackRow, stats: TrackStats, all: CatalogTrackRow[]): string {
  const url = trackUrl(track.name);
  const name = esc(track.name);
  const length = fmtLength(track.length_m);
  const description = trackDescription(track, stats);
  const others = sameVenue(all, track);
  const hasLaps = stats.drivers > 0 && stats.best_ms.length > 0;

  const facts: string[] = [];
  if (length) facts.push(`<tr><th scope="row">Lap length</th><td>${length}</td></tr>`);
  if (hasLaps) {
    facts.push(`<tr><th scope="row">Fastest lap logged</th><td>${fmtMs(stats.best_ms[0])}</td></tr>`);
    facts.push(`<tr><th scope="row">Drivers on the leaderboard</th><td>${stats.drivers}</td></tr>`);
  }

  const laps = hasLaps
    ? `    <p>
      The best lap of each of the fastest ${stats.best_ms.length === 1 ? "driver" : `${stats.best_ms.length} drivers`}
      on the Track Evolution leaderboard for ${name}${
        stats.drivers > stats.best_ms.length ? `, out of ${stats.drivers}` : ""
      }. Every time here was measured — recorded with a phone's GPS or
      imported from the car's or a camera's telemetry — never typed in.
    </p>
    <div class="table-scroll">
      <table>
        <thead><tr><th scope="col">Rank</th><th scope="col">Best lap</th></tr></thead>
        <tbody>
${stats.best_ms.map((ms, i) => `          <tr><td>${i + 1}</td><td>${fmtMs(ms)}</td></tr>`).join("\n")}
        </tbody>
      </table>
    </div>
    <p>
      Times are from track-day drivers in all kinds of cars, on the days they
      happened to drive, so read them as a range and not a record. Drivers
      choose to join the leaderboard, and this page never shows who set a time.
    </p>`
    : `    <p>
      No Track Evolution driver has put a measured lap on the leaderboard for
      ${name} yet. Laps count once they are recorded with a phone's GPS or
      imported from the car's or a camera's telemetry — a typed-in time never
      ranks — and the driver has chosen to join the leaderboard.
    </p>`;

  const body = `    <p><a href="/tracks">← All tracks</a></p>
    <h1>${name} lap times</h1>
    <p class="lede">${esc(description)}</p>
${
  facts.length
    ? `    <div class="table-scroll">
      <table>
        <tbody>
          ${facts.join("\n          ")}
        </tbody>
      </table>
    </div>
`
    : ""
}
    <h2 id="lap-times">Lap times drivers have logged</h2>
${laps}

    <h2 id="your-laps">Time your own laps at ${name}</h2>
    <p>
      Track Evolution is a free logbook for track days: every event, session
      and lap time, with a chart of your best at each track.
    </p>
    <ul>
      <li><a href="${DOCS_ORIGIN}/docs/lap-recording.html">Record laps with your phone's GPS</a> in the iPhone and Android apps.</li>
      <li><a href="${DOCS_ORIGIN}/docs/telemetry-import.html">Import lap times from video or data you already have</a> — a Corvette or Cadillac PDR, a GoPro, an AiM SmartyCam, a VBOX or Porsche Track Precision file.</li>
      <li>Join the leaderboard for ${name} from the track's page in the app, if you want your best lap counted here. It is off until you turn it on.</li>
    </ul>
${CTA}
    <p>
      New to this? <a href="${DOCS_ORIGIN}/docs/track-days.html">Your first track day</a>
      covers what an event is, what the car needs and where to find one.
    </p>
${
  others.length
    ? `
    <h2 id="layouts">Other layouts at ${esc(venueOf(track.name))}</h2>
    <ul>
${others.map((o) => `      <li><a href="/tracks/${trackSlug(o.name)}">${esc(o.name)}</a></li>`).join("\n")}
    </ul>
`
    : ""
}`;

  const place: Record<string, unknown> = {
    "@type": "SportsActivityLocation",
    "@id": `${url}#track`,
    name: track.name,
    url,
  };
  if (track.lat != null && track.lon != null) {
    place.geo = { "@type": "GeoCoordinates", latitude: track.lat, longitude: track.lon };
  }
  const graph = [
    {
      "@type": "WebPage",
      "@id": `${url}#page`,
      url,
      name: `${track.name} lap times`,
      description,
      inLanguage: "en",
      isPartOf: WEBSITE,
      about: { "@id": `${url}#track` },
      publisher: ORG,
    },
    place,
    breadcrumbs([
      { name: "Track Evolution", item: `${APP_ORIGIN}/` },
      { name: "Tracks", item: `${APP_ORIGIN}/tracks` },
      { name: track.name, item: url },
    ]),
  ];

  return page({ title: `${track.name} lap times — Track Evolution`, description, url, graph, body });
}

const INDEX_DESCRIPTION =
  "Lap times at road courses across the United States, measured by track-day drivers: each track's length and the best laps logged on its Track Evolution leaderboard.";

export function tracksIndexHtml(all: CatalogTrackRow[]): string {
  const url = `${APP_ORIGIN}/tracks`;
  const body = `    <h1>Track lap times</h1>
    <p class="lede">${esc(INDEX_DESCRIPTION)}</p>
    <div class="table-scroll">
      <table>
        <thead><tr><th scope="col">Track</th><th scope="col">Lap length</th></tr></thead>
        <tbody>
${all
  .map(
    (t) =>
      `          <tr><td><a href="/tracks/${trackSlug(t.name)}">${esc(t.name)}</a></td><td>${fmtLength(t.length_m) ?? "—"}</td></tr>`
  )
  .join("\n")}
        </tbody>
      </table>
    </div>
    <p>
      A track's name includes its layout, and layouts are never mixed: the full
      course and a short configuration have separate pages and separate times.
    </p>
${CTA}`;
  const graph = [
    {
      "@type": "CollectionPage",
      "@id": `${url}#page`,
      url,
      name: "Track lap times",
      description: INDEX_DESCRIPTION,
      inLanguage: "en",
      isPartOf: WEBSITE,
      publisher: ORG,
    },
    breadcrumbs([
      { name: "Track Evolution", item: `${APP_ORIGIN}/` },
      { name: "Tracks", item: url },
    ]),
  ];
  return page({ title: "Track lap times — Track Evolution", description: INDEX_DESCRIPTION, url, graph, body });
}

export function trackNotFoundHtml(): string {
  return page({
    title: "Track not found — Track Evolution",
    description: "There is no track page at this address.",
    url: `${APP_ORIGIN}/tracks`,
    graph: [],
    noindex: true,
    body: `    <h1>Track not found</h1>
    <p>There is no track page at this address. <a href="/tracks">See every track</a>.</p>`,
  });
}

export function tracksSitemap(all: CatalogTrackRow[]): string {
  const locs = [`${APP_ORIGIN}/tracks`, ...all.map((t) => trackUrl(t.name))];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((l) => `  <url><loc>${l}</loc></url>`).join("\n")}
</urlset>
`;
}
