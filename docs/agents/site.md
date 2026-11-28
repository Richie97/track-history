# Docs site (`site/`) and promo video

Reference notes for agents, split out of `AGENTS.md`. Read this before working in the area it covers, and update it in the same change as the code it describes.

## Page inventory and what each page owes

Documentation is hand-maintained in `README.md`, the docs site, `AGENTS.md` and these notes:

1. **`README.md`** — setup, deployment, feature descriptions (it's also the
   reference the docs site was written from).
2. **The marketing/docs site (`site/`)** — static HTML deployed to GitHub Pages
   at https://docs.trackevolution.app (also served at
   https://richie97.github.io/track-history/) by
   `.github/workflows/pages.yml` (on pushes to `main` touching `site/**`).
   - `site/index.html` — landing page, **served twice**: by GitHub Pages on
     the docs host, and by the Worker at `https://trackevolution.app/` to any
     visitor with no session cookie (`home` in `src/routes/landing.ts`; `/`
     is in `run_worker_first`), so the brand's own domain answers a search
     engine or a first-time visitor with what the app is rather than a
     sign-in screen. The Worker's copy is **generated** by
     `tools/landing.mjs` (`npm run landing:generate`) into
     `src/landing.generated.ts` plus `public/site/` (the stylesheet, the
     poster and `analytics.js`): relative links re-pointed at this host or
     the docs host, and *Open the app* sent to `/login` — `SIGN_IN_PATH`, a
     path the Worker doesn't claim and so always the app shell. **An edit to
     `site/index.html`, `site/site.css`, `site/analytics.js` or the poster
     owes a regenerate**, and `test/unit/landing.test.js` fails until it is
     done. The root domain is the page's canonical home: the docs host's
     copy carries `canonical` / `og:url` of `https://trackevolution.app/`,
     is left out of `site/sitemap.xml` (it is in `public/sitemap.xml`), and
     the JSON-LD entity ids (`#org`, `#website`, `#app`) hang off the root
     domain on every page. The cookie's *presence* decides, not its
     validity (no D1 read; a stale cookie gets the shell and its sign-in
     screen), the response is `private, no-cache` + `Vary: Cookie`, and an
     inline script sends an installed PWA or a `#/…` deep link straight to
     `/login`. Update the features grid, telemetry
     sources, or getting-started steps if those change; don't let it advertise
     features that don't exist or miss ones that do. Its hero is the promo
     video (`promo/`), published at https://youtu.be/UBnjPYRr8wU, as a
     click-to-play poster (`site/promo-poster.jpg`, a frame of the render): the
     inline script swaps in the `youtube-nocookie.com` player only on a click,
     so nothing loads from YouTube until a visitor asks for it, and without
     JavaScript the poster is a plain link. A re-cut that gets a new upload
     owes the video id there and in `site/docs/index.html`'s intro, and a new
     poster frame.
   - `site/docs/index.html` — getting started *using the hosted app* (sign-in,
     first event, telemetry import, PWA install, sharing).
   - **The site points users at the hosted app, https://trackevolution.app, and
     deliberately never mentions Cloudflare, self-hosting, or deployment** —
     developer setup and deploy instructions live in `README.md` only. Keep it
     that way when editing `site/**`.
   - Download links point at the App Store listing
     (`https://apps.apple.com/us/app/track-evolution/id6792941186`) **and** the
     Play Store listing
     (`https://play.google.com/store/apps/details?id=app.trackevolution`) — the
     landing page's two CTA rows and "Works like an app"/"Record laps" cards,
     `site/docs/index.html`'s *Get it on your phone*, and
     `site/docs/lap-recording.html`'s callout, plus `appStoreLinkHtml` on the
     web sign-in screen in `public/app.js` and the `/get` redirect's
     `src/lib/storeLinks.ts`. Both apps are published, so every
     one of those places offers the pair; keep them in step — a place that
     names only one platform is a bug, and the *coming soon* placeholders the
     landing page used to carry beside the iPhone button are gone.
   - `site/docs/track-days.html` — *Your first track day*, the guide for a
     driver who has never been on track: what an HPDE is, what the car and
     driver need, where to find an event (links to the organizers —
     MotorsportReg, Track Night in America, NASA, Hooked on Driving, Chin
     Track Days, the marque clubs), the day itself, and *Recording your
     laps* — the tools drivers record with outside the app (the phone
     recorder, GM's PDR, Porsche Track Precision, Racelogic VBOX, lap-timer
     apps, GoPro, and the ones the importer can't read), each with what it
     takes to get it into the logbook. That table states import support,
     so it owes an edit whenever `site/docs/telemetry-import.html`'s
     sources change. Linked from every
     client's first-run welcome card and from Settings' *New to track days?*
     section (`TRACK_DAYS_URL` in `public/app.js`,
     `SettingsScreen.trackDaysGuideURL` on iOS, `TRACK_DAYS_GUIDE_URL` in
     Android's `DashboardScreen.kt`), so the organizer list is maintained
     here and never in an app. **The phones read it in their own web view**,
     not a browser: `TrackDaysGuideScreen` on both (`Route.trackDaysGuide` /
     `Route.TrackDaysGuide`, analytics path `/guide/track-days`), whose pure
     half is `GuidePage` under the same names — the site's header, sidebar,
     pager and footer hidden by an injected style, the docs host kept in the
     view and every other link (the organizers) sent to the browser, and the
     user agent marked `TrackEvolution-App`, which `site/analytics.js` reads
     to load nothing and show no banner. Keep it organizer-neutral and point at the
     event's own rules rather than restating them.
   - The **guides** (the sidebar's *Guides* group, between *AI assistants*
     and the privacy policy in the pager), fourteen pages that each answer
     a question drivers search for whether or not they use the app, in
     general terms first, and end on one *in Track Evolution* section
     (`id="logbook"`) saying how the app does it and which tier it is in.
     That last section states app behaviour, so each owes an edit with its
     feature: `prep-checklist.html` (the prep checklist and its default
     list, `public/js/checklist.js`), `track-day-cost.html` (event costs
     and the Pro roll-ups), `tire-pressures.html` (the setup notebook's
     pressure loop), `consumables.html` (the garage's hours rule, wear
     projections, the Equipped switch, where a due part is flagged),
     `lap-consistency.html` (the clean-lap rule — `CLEAN_FACTOR`, three
     laps — the per-session stats and sectors), `lap-delta.html` (the delta
     chart, *Compare two laps*, the recorder's live delta),
     `brake-throttle-traces.html` (the Traces tab, which sources carry
     which channels, the free channels), `friction-circle.html` (the Grip
     tab), `understeer-oversteer.html` (the balance read-out and that it is
     relative), `shift-points.html` (the gear ribbon and shift table),
     `setup-notebook.html` (setup sheets and the web's setup-vs-lap-times
     table), `temperatures.html` (the Car tab and its watch lines),
     `phone-gps-lap-timing.html` (the recorder's accuracy, the import
     sources, the `~` on estimated laps) and `working-with-a-coach.html`
     (coach sharing, the driver profile, comments). Keep the advice
     conservative and deferential — the car, tire or part maker, the
     event's rules and an instructor come first, and nothing in a guide is
     for use while driving — and give no pressure, temperature or wear
     figure as a recommendation; `track-day-cost.html`'s prices are marked
     as rough illustrations. A new guide goes in the sidebar order on
     every docs page, the pager chain, the sitemap and `llms.txt` like any
     page. The feature pages (`garage.html`, `telemetry-import.html`,
     `data-model.html`, `lap-recording.html`, `index.html`) and
     `track-days.html` link to the guide for their topic. Each guide's
     *in Track Evolution* section carries a **screenshot of the feature**
     (`<figure class="shot">`, `site/docs/img/<name>-dark.webp` with a
     `-light` alternative through `<picture>`, since the site follows the
     reader's colour scheme). They are **generated**, never hand-made:
     `promo/guides.mjs` films the real web app on the promo's fictional
     demo logbook and crops each feature (`cd promo && node guides.mjs`, or
     `--reuse` against the logbook already in `.state/`). A change to a
     screen a guide shows owes a re-run and the new images committed, and
     an image whose size changed owes its `width` / `height` in the page.
   - `site/docs/telemetry-import.html` — import sources, line picker, PDR
     derivation. Update when parsers or import behavior change.
   - **A page per import source** (#456), each answering "how do I get lap
     times out of X" for a driver searching by the thing they own:
     `corvette-pdr-lap-times.html`, `cadillac-blackwing-pdr-lap-times.html`,
     `gopro-lap-times.html`, `aim-smartycam-lap-times.html`,
     `vbo-file-lap-times.html` (VBOX and the RaceChrono / TrackAddict /
     Harry's LapTimer exports) and `porsche-track-precision-export.html`
     (its CSV and VBO exports). One shape: what you need, the steps in the
     browser and on the phone as numbered lists, where the lap times come
     from, what you get, what is free and what is Pro, and *If it doesn't
     work* — which **quotes the importer's own error messages**
     (`public/js/import/parse.js`, `gpmf.js`, `vbo.js`, `csv.js`,
     `smartycam.js`, and the review's hints in `ui.js`), so a reworded
     message owes its page the edit. `telemetry-import.html` stays the
     overview and its *Supported sources* table links to each; the pages
     link back and don't repeat its analysis walkthrough. They sit under
     *Telemetry import* in every sidebar as `<li class="sub">` items, and
     in the pager between it and *Recording laps*. A change to a parser, to
     which channels a source carries, to what a source's clip can save, or
     to a tier owes the matching page; a new import source owes a new page,
     plus the overview's table, `track-days.html`'s *Recording your laps*
     table (which links to these pages) and `llms.txt`. They describe
     another maker's product only as far as "export a `.vbo` / CSV from
     the app": don't write menu-by-menu steps for an app that isn't ours.
   - `site/docs/lap-recording.html` — recording laps with the phone's GPS in
     the mobile apps (flow, accuracy expectations, on-device data handling).
     Update when the recorder's behavior changes.
   - `site/docs/data-model.html` — hierarchy, best-time rule, consistency,
     track-day costs and their roll-ups, share-page privacy. Update when the
     data model or stats rules change.
   - `site/docs/garage.html` — the garage: consumable wear tracking (the
     hours rule — logged lap time with 3+ laps, else 1h15m per track day, measurements, projections), the vehicle
     form's catalog pick and measured steering ratio, and the per-day
     setup notebook. Update when wear math, setup fields, the
     hours-accounting rule or the vehicle form's geometry help change.
   - `site/docs/ai.html` — connecting an AI assistant (Claude, ChatGPT, any
     MCP client) to the logbook with Pro: the connector address, what it can
     and can't read, disconnecting — and **the AI Coach** (`#ai-coach`): the
     three places it opens, getting an API key from Anthropic, OpenAI or Google Gemini,
     that the driver pays the provider directly, what is sent, and how it
     differs from sharing with a human coach. Update when the MCP tools, the
     consent page, Settings' connected-assistants list, the AI Coach's entry
     points, its providers or where a key is kept change. It has **no guide
     screenshot yet**: `promo/guides.mjs` owes one of the drawer, captured on
     the fake provider (`localStorage["te-ai-fake"] = "1"`).
   - `site/docs/privacy.html` and `site/docs/terms.html` — privacy policy and
     terms of use (operator: Speedshift LLC). In the app they're linked from
     the Settings page (account dropdown → Settings) on every platform, and
     additionally from the footer (`footerHtml({ legal: true })` in
     `public/app.js`, which on every page also carries the *Veteran-owned
     business* line beside the copyright, as the site's footer does) on signed-out and public share pages, where Settings
     isn't reachable; the native apps render no footer at all. Update the
     privacy policy when data
     collection, storage, or sharing behavior changes, and bump the effective
     date on any substantive edit.
   - `site/docs/account-deletion.html` — how to request account deletion
     (a `mailto:eric@speedshift.io` request from the sign-in email; *The
     steps* at its top is the short numbered form of the sections under it,
     so an edit to either owes the other). Exists as
     a stable https URL for app-store listings that require one; keep it in
     step with the privacy policy's retention/deletion section.
   - **The site is written for users, not developers** — keep implementation
     details (frameworks, chart internals, build tooling, service-worker
     mechanics) out of it; that material belongs in `README.md`/this file.
   - If you add a docs page, add it to the sidebar of *every* docs page and
     wire the prev/next pager links.
   - Every page loads `analytics.js` (Google Analytics behind the UK/EU
     consent banner — `../analytics.js` from `docs/`, and nothing at all
     inside the phones' web view, whose user agent says `TrackEvolution-App`)
     at the end of its `<head>`, and its footer carries the *Cookies* button
     (`data-consent-open`) that reopens the banner and the *Veteran-owned
     business · Speedshift LLC* line (`.footer-vob`); a new page copies all three.
   - **Search and answer engines** (SEO / AEO): every page carries a
     `<link rel="canonical">` equal to its `og:url` and a JSON-LD block —
     the landing page's `@graph` is the Organization, WebSite,
     SoftwareApplication (with the three offers), the promo VideoObject and
     an FAQPage — and since the Worker serves the same page at the root
     domain, all of it is what `https://trackevolution.app/` says too; a docs page is a TechArticle (a legal page a WebPage) plus
     its BreadcrumbList. `site/sitemap.xml` lists every page,
     `site/robots.txt` allows everything and names the sitemap, and
     `site/llms.txt` is the plain-language index for AI assistants (facts,
     prices, supported import sources, one line per page). A new page owes
     all of these; a change to a price, a tier or an import source owes
     `llms.txt` and the landing page's FAQ and offers. The FAQ is visible
     content (`#faq`) and its markup must say the same words — never mark
     up a question the page doesn't show, and never add a rating or review
     to the structured data without a real source. **A numbered procedure
     is also marked up as a schema.org `HowTo`** (#458): a list written
     `<ol id="howto-…">` gets one HowTo node at the end of its page's
     `@graph`, a `HowToStep` per `<li>` whose text is the item's visible
     text, named `<h1>: <the heading the list sits under>`. The markup is
     **generated** by `tools/site-howto.mjs` (`npm run site:howto`) and
     never hand-edited, so **an edit to a marked list's steps, its heading
     or its page's `<h1>` owes a regenerate**, and the test fails until it
     is done. Marked today: the six per-source import pages (their browser
     and phone lists), `lap-recording.html` (*How it works*), `ai.html`
     (*Connecting Claude*), `index.html` (*Share with a coach*) and
     `account-deletion.html` (*The steps*). Mark a list only when it is a
     procedure the reader follows in order — not a schedule or a checklist
     — and keep its `<li>`s plain (no nested list). Google no longer shows
     HowTo rich results; this is for answer engines. A re-cut promo owes the
     VideoObject its id and upload date. `test/unit/site-seo.test.js` pins
     the lot. On the app host, `public/robots.txt` keeps crawlers off the
     API and auth paths but **leaves `/share/` crawlable** (a Disallow would
     also stop the link-preview scrapers that honour robots.txt),
     `public/llms.txt` points at the docs, `public/sitemap.xml` lists the
     home page, `public/index.html` carries a
     canonical to the app's home and a `<noscript>` summary, the share
     pages rewrite that canonical with their `og:url` (`setPageUrl` in
     `src/routes/share.ts`), and the unlisted `/share/(e|s)/<token>` pages
     answer `X-Robots-Tag: noindex`.
   - Every page carries Open Graph/Twitter-card meta tags. The social preview
     image is `site/og-image.png`, and `public/og-image.png` is an identical
     copy used by the app — the two must stay in sync (regenerate both if the
     brand mark, tagline, or design tokens change). `og:image`/`og:url` are
     absolute canonical URLs (docs.trackevolution.app / trackevolution.app) — the
     one exception to the relative-links rule, since social scrapers require
     absolute URLs.
   - The site is dependency-free static HTML/CSS with no build step.
     `site/site.css` mirrors the design tokens in `public/style.css` — if the
     app's design tokens change, re-mirror them. All links are relative so

## Promo video

**Promo video** (`promo/`): an 84-second film cut from the **real web app**, not mock-ups — `capture.mjs` seeds a fictional demo logbook through the API on its own scratch D1 (`promo/.state`, never the dev database), with COTA telemetry from a lap simulation (`demo/sim.mjs`) cut by the importer's own `buildLapChannels`, films each screen with Playwright, and exports the facts the motion graphics draw to `out/data.json`; `video/promo.js` is the cut on a seekable timeline (`video/timeline.js`) that `render.mjs` steps frame by frame; `audio/score.mjs` synthesises the score on the same two-second bars. Everything under `promo/out/` is a build product and gitignored. It follows the site's rules — hosted app and both stores, no hosting details — and it **states features and tiers** (the Free / Pro tags in `video/promo.js` follow the NS-32 tier table), so a change to a feature, a tier or a screen it shows owes it the edit and a re-render, like the site. The one drawn screen is the native recorder, which the web can't show; it mirrors `RecordingScreen.swift`. The published cut is on YouTube (https://youtu.be/UBnjPYRr8wU) and is the landing page's hero — see the `site/index.html` bullet under Documentation.
