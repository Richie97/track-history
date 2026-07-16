# AGENTS.md

Guidance for coding agents (and humans) working in this repository. This is the
canonical instructions file — `CLAUDE.md` just imports it, so edit this file,
not that one.

## What this is

A personal HPDE/track-day logbook on Cloudflare Workers + D1 (SQLite): tracks → events → sessions → laps, with progress charts and Google OAuth sign-in. Multi-user — every domain row is scoped to a `user_id`. The hosted instance users are pointed to is https://trackhistory.app.

## Commands

```sh
npm install
npm run seed:generate       # writes seed/seed.sql from seed data (see below)
npm run db:migrate:local    # applies migrations/ to the local D1 SQLite
npm run db:seed:local       # loads seed/seed.sql locally
npm run dev                 # wrangler dev → http://localhost:8787
npm test                    # vitest: unit tests + API tests against a real D1 (miniflare)
npm run typecheck           # tsc over src/ and test/ (no linter is configured)
```

Local dev needs a gitignored `.dev.vars`:

```
DEV_MODE=1
DEV_USER_EMAIL=you@example.com   # must match the seed data's USER_EMAIL
DEV_USER_NAME=Your Name
GOOGLE_CLIENT_ID=dev
GOOGLE_CLIENT_SECRET=dev
```

`DEV_MODE=1` makes `GET /auth/login` sign in as a fixed local user (no Google OAuth) — navigate there once to get a session cookie. Never set it in production.

Deployment: `npm run deploy` (plus `db:migrate:remote` / `db:seed:remote`). Secrets are set via `npx wrangler secret put`.

## Documentation — update it as you go

Documentation is hand-maintained in three places. **When a change alters
behavior, setup, or user-facing features, updating these is part of the change,
not a follow-up:**

1. **`README.md`** — setup, deployment, feature descriptions (it's also the
   reference the docs site was written from).
2. **The marketing/docs site (`site/`)** — static HTML deployed to GitHub Pages
   at https://docs.trackhistory.app (also served at
   https://richie97.github.io/track-history/) by
   `.github/workflows/pages.yml` (on pushes to `main` touching `site/**`).
   - `site/index.html` — landing page. Update the features grid, telemetry
     sources, or getting-started steps if those change; don't let it advertise
     features that don't exist or miss ones that do.
   - `site/docs/index.html` — getting started *using the hosted app* (sign-in,
     first event, telemetry import, PWA install, sharing).
   - **The site points users at the hosted app, https://trackhistory.app, and
     deliberately never mentions Cloudflare, self-hosting, or deployment** —
     developer setup and deploy instructions live in `README.md` only. Keep it
     that way when editing `site/**`.
   - `site/docs/telemetry-import.html` — import sources, line picker, PDR
     derivation. Update when parsers or import behavior change.
   - `site/docs/data-model.html` — hierarchy, best-time rule, consistency,
     share-page privacy. Update when the data model or stats rules change.
   - `site/docs/privacy.html` and `site/docs/terms.html` — privacy policy and
     terms of use (operator: Speedshift LLC). The app footer (`footerHtml()` in
     `public/app.js`) links to them. Update the privacy policy when data
     collection, storage, or sharing behavior changes, and bump the effective
     date on any substantive edit.
   - **The site is written for users, not developers** — keep implementation
     details (frameworks, chart internals, build tooling, service-worker
     mechanics) out of it; that material belongs in `README.md`/this file.
   - If you add a docs page, add it to the sidebar of *every* docs page and
     wire the prev/next pager links.
   - Every page carries Open Graph/Twitter-card meta tags. The social preview
     image is `site/og-image.png`, and `public/og-image.png` is an identical
     copy used by the app — the two must stay in sync (regenerate both if the
     brand mark, tagline, or design tokens change). `og:image`/`og:url` are
     absolute canonical URLs (docs.trackhistory.app / trackhistory.app) — the
     one exception to the relative-links rule, since social scrapers require
     absolute URLs.
   - The site is dependency-free static HTML/CSS with no build step.
     `site/site.css` mirrors the design tokens in `public/style.css` — if the
     app's design tokens change, re-mirror them. All links are relative so
     pages work both at docs.trackhistory.app and under the `/track-history/`
     GitHub Pages subpath; keep them that way.
3. **This file (`AGENTS.md`)** — commands, architecture notes, conventions.
   Update it when you add a directory, command, route, or convention that a
   future agent would need to know.

## Architecture

One Worker serves both the API and the static frontend (`wrangler.jsonc`: `public/` is served as SPA assets; `/api/*` and `/auth/*` hit the Worker first).

**Backend** (`src/`, Hono):
- `index.ts` — composes the routers. Route order matters: `/api/share` (public, no auth) is registered before `/api` so `GET /api/share/:slug` stays unauthenticated while everything else under `/api` passes through `requireSession` (`middleware.ts`).
- `routes/` — one router per resource: `auth.ts` (Google OAuth or the DEV_MODE bypass → `auth_sessions` row → `session` cookie; first Google sign-in claims a pre-seeded user row by matching email where `google_sub IS NULL`), `me.ts`, `tracks.ts`, `events.ts`, `sessions.ts` (sessions + laps), and `share.ts` (authed slug management plus the public share endpoint, which returns stats/times but strips notes, email, and per-lap data).
- `db.ts` — data-access helpers. All take `(db, userId, ...)` explicitly so ownership scoping is visible at call sites: `ownedEvent`/`ownedSession` guard nested writes, `resolveTrack` find-or-creates tracks by (name, config) (`COLLATE NOCASE`; config is part of track identity so bests/goals never mix across layouts), and `EVENT_SELECT`/`listEvents`/`tracksSummary` produce event rows with lap aggregates.
- `lib/` — pure logic, unit-tested: `stats.ts` (`withComputed` derives `best_ms = MIN(manual best_time_ms, best logged lap)` and `consistency` — coefficient of variation, only with 3+ laps), `validate.ts` (slug/goal/lap validation), `session.ts` (session token + cookie plumbing), `oidc.ts` (id_token decode).

**Frontend** (`public/`, dependency-free vanilla JS as native ES modules — no build step):
- `app.js` — the module entry (`<script type="module">`): app state, `shell()`, the views and the hash router (`#/`, `#/new`, `#/event/:id`, `#/event/:id/edit`, `#/track/:id`, plus public `/share/<slug>` pages with their own hash routes). Each route re-renders the whole view via `shell()`, so element handles go stale after any navigation; module-level listeners are used where per-render listeners would accumulate. HTML is built with template strings — always pipe user data through `esc()`.
- `js/` — extracted modules, importable by unit tests: `format.js` (`fmtMs`/`parseTime`/`esc`…), `chart.js` (hand-rolled SVG `lineChart` + `multiLineChart` lap overlay; lower lap time plotted lower = improvement trends downward), `channel-graphs.js` (an imported session's lap list as chips plus per-lap speed/RPM/lateral-G overlay charts in a collapsible `<details>`, on a shared driven-distance axis; up to 3 laps highlighted via the chips in the `--chart-line`/`-b`/`-c` slot colors, the rest a dim envelope), `lap-stats.js` (per-session analysis: best-N avg, pace slope, warmup), `year-review.js` (year-in-review aggregation), `api.js` (fetch wrapper throwing `ApiError` with status), `theme.js`, `us-tracks.js`.
- `js/import/` — the telemetry import feature: `channels.js` builds the per-lap channel data stored with imported sessions (`sessions.channels` JSON: each lap's speed — plus RPM/lateral G for PDR — resampled onto a 20 m driven-distance grid; the shape is validated server-side by `sanitizeChannels` in `src/lib/validate.ts` — keep the two in sync); `parse.js` dispatches a dropped file to a parser (`.vbo` → `vbo.js`, `.fit` → `fit.js`, `.mp4` → PDR first, then GoPro `gpmf.js`); every parser returns `{kind, date, time, durationS, laps, gps, needsLine}`. `geo.js` projects GPS traces to local meters and derives laps from start/finish line crossings; `pdr-laps.js` recovers laps for beacon-less PDR recordings from latitude+odometer periodicity (autocorrelation lap length; start/finish phase anchored to a beacon-timed batch-mate via `anchorPdrBatch`); `ui.js` is the dropzone/review flow, including the click-a-map line picker for GPS sources without lap markers — GoPro, plain VBO/FIT (one picked line applies to the whole batch, with automatic longitude-sign mirroring for Racelogic's west-positive convention). Test fixtures for all formats are generated by `test/fixtures/build.mjs`. Real sample recordings for manual import testing live in the gitignored `telemetry-samples/` at the repo root — never commit footage.
- `pdr.js` — parses lap times, the GPS trace, and car metrics (top speed / max RPM / max lateral G) out of Corvette PDR (Cosworth) MP4 telemetry entirely in the browser via byte-range reads; the video is never uploaded. The beacon/odometer lap-derivation logic is reverse-engineered — see README before touching it. The stream is **delta-encoded** (framing matches ExifTool's GM.pm): each channel gets one full record, then 8-byte diffs against running decoder state that persists across samples — decoding the deltas is what yields ~11Hz lat/lon (radians, scaled via the `mrld` channel dictionary) and the Speed/RPM/acceleration channels. Coordinates only become a `gps` trace behind plausibility checks; when they don't decode, the raw latitude/odometer series returned as `channels` still feed lap recovery in `js/import/pdr-laps.js`.
- PWA: `manifest.webmanifest` + `sw.js` make the app installable and offline-capable. The service worker serves static files stale-while-revalidate (no build step, so no cache busting — changes land on the *second* load), navigations and `GET /api/*` network-first with cache fallback; `/auth/*` and non-GET are never intercepted. Signing out deletes the cached API data (`th-data-*` caches) so a shared device doesn't retain the previous user's logbook. Icons in `icons/` + `favicon.*` are generated from the brand mark — regenerate rather than hand-edit if the mark changes.

**Database** (`migrations/`, applied in order by wrangler): schema changes are new numbered migration files, never edits to existing ones.

**Seed** (`seed/generate.mjs`): reads `seed/data.personal.mjs` if present (gitignored — real personal data), else `seed/data.example.mjs`, and writes `seed/seed.sql`.

**Marketing/docs site** (`site/`): see the Documentation section above for the page inventory and the keep-in-sync policy.

**Tests** (`test/`, Vitest with two projects — see `vitest.config.mts`):
- `test/unit/` — pure-function tests running in Node: `src/lib/*` plus the frontend modules (`public/js/format.js`, `chart.js`) and `pdr.js` internals.
- `test/api/` — the whole Worker under `@cloudflare/vitest-pool-workers`: real D1 with migrations applied per test (`setup.ts`), requests via `SELF.fetch`. `helpers.ts` creates users/sessions directly in D1 so multi-user ownership isolation is testable; DEV_MODE bindings live in `vitest.workers.config.mts`.
- New API behavior needs a test here; new pure logic belongs in `src/lib`/`public/js` where it's unit-testable.

## Conventions

- Lap times are integer milliseconds everywhere; the frontend formats/parses `m:ss.fff` via `fmtMs`/`parseTime`.
- API errors are `{ error: string }` with a meaningful status; the frontend surfaces `err.message` from that.
- Frontend and backend share no code — keep API response shapes in sync with the `app.js` consumers by hand.
- Docs (README, `site/`, this file) are updated in the same change as the code they describe — see the Documentation section.
