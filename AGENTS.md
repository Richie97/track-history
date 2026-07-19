# AGENTS.md

Guidance for coding agents (and humans) working in this repository. This is the
canonical instructions file — `CLAUDE.md` just imports it, so edit this file,
not that one.

## What this is

A personal HPDE/track-day logbook on Cloudflare Workers + D1 (SQLite): tracks → events → sessions → laps, with progress charts and Google OAuth sign-in. Multi-user — every domain row is scoped to a `user_id`. The hosted instance users are pointed to is https://trackevolution.app.

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

Mobile apps (`mobile/`, separate npm project): `cd mobile && npm install && npm run ios|android` (needs Xcode / Android Studio). `npm run sync` rebuilds `mobile/www/` from `public/` and runs `cap sync` — see the Architecture section.

## Documentation — update it as you go

Documentation is hand-maintained in three places. **When a change alters
behavior, setup, or user-facing features, updating these is part of the change,
not a follow-up:**

1. **`README.md`** — setup, deployment, feature descriptions (it's also the
   reference the docs site was written from).
2. **The marketing/docs site (`site/`)** — static HTML deployed to GitHub Pages
   at https://docs.trackevolution.app (also served at
   https://richie97.github.io/track-history/) by
   `.github/workflows/pages.yml` (on pushes to `main` touching `site/**`).
   - `site/index.html` — landing page. Update the features grid, telemetry
     sources, or getting-started steps if those change; don't let it advertise
     features that don't exist or miss ones that do.
   - `site/docs/index.html` — getting started *using the hosted app* (sign-in,
     first event, telemetry import, PWA install, sharing).
   - **The site points users at the hosted app, https://trackevolution.app, and
     deliberately never mentions Cloudflare, self-hosting, or deployment** —
     developer setup and deploy instructions live in `README.md` only. Keep it
     that way when editing `site/**`.
   - `site/docs/telemetry-import.html` — import sources, line picker, PDR
     derivation. Update when parsers or import behavior change.
   - `site/docs/lap-recording.html` — recording laps with the phone's GPS in
     the mobile apps (flow, accuracy expectations, on-device data handling).
     Update when the recorder's behavior changes.
   - `site/docs/data-model.html` — hierarchy, best-time rule, consistency,
     share-page privacy. Update when the data model or stats rules change.
   - `site/docs/privacy.html` and `site/docs/terms.html` — privacy policy and
     terms of use (operator: Speedshift LLC). In the app they're linked from
     the Settings page (account dropdown → Settings) on every platform, and
     additionally from the footer (`footerHtml({ legal: true })` in
     `public/app.js`) on signed-out and public share pages, where Settings
     isn't reachable; the native apps render no footer at all. Update the
     privacy policy when data
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
     absolute canonical URLs (docs.trackevolution.app / trackevolution.app) — the
     one exception to the relative-links rule, since social scrapers require
     absolute URLs.
   - The site is dependency-free static HTML/CSS with no build step.
     `site/site.css` mirrors the design tokens in `public/style.css` — if the
     app's design tokens change, re-mirror them. All links are relative so
     pages work both at docs.trackevolution.app and under the `/track-history/`
     GitHub Pages subpath; keep them that way.
3. **This file (`AGENTS.md`)** — commands, architecture notes, conventions.
   Update it when you add a directory, command, route, or convention that a
   future agent would need to know.

## Architecture

One Worker serves both the API and the static frontend (`wrangler.jsonc`: `public/` is served as SPA assets; `/api/*` and `/auth/*` hit the Worker first).

**Backend** (`src/`, Hono):
- `index.ts` — composes the routers. Route order matters: `/api/share` (public, no auth) is registered before `/api` so `GET /api/share/:slug` stays unauthenticated while everything else under `/api` passes through `requireSession` (`middleware.ts`).
- `routes/` — one router per resource: `auth.ts` (Google OAuth or the DEV_MODE bypass → `auth_sessions` row → `session` cookie; first Google sign-in claims a pre-seeded user row by matching email where `google_sub IS NULL`; plus the native-app flow — `?client=app&code_challenge=…` runs OAuth in the system browser and redirects to `trackevolution://auth` with a single-use code that `POST /auth/exchange` trades for a bearer token, PKCE-verified), `me.ts`, `tracks.ts`, `events.ts`, `sessions.ts` (sessions + laps), `vehicles.ts` (the per-user garage backing Settings → Vehicles; `events.car` stays free text — vehicles feed it, and at most one `is_default` row per user pre-fills new events), `share.ts` (authed slug management plus the public share endpoint, which returns stats/times but strips notes, email, and per-lap data), and `wellKnown.ts` (`/.well-known/apple-app-site-association` for iOS Universal Links; the Android `assetlinks.json` is a static file in `public/.well-known/`).
- `middleware.ts` `requireSession` accepts the session as the `session` cookie (web) **or** an `Authorization: Bearer` header (native apps) — same `auth_sessions` rows. `lib/cors.ts` answers CORS for exactly the Capacitor shell origins on `/api/*`/`/auth/*` (no credentials — bearer header, never cross-site cookies).
- `db.ts` — data-access helpers. All take `(db, userId, ...)` explicitly so ownership scoping is visible at call sites: `ownedEvent`/`ownedSession` guard nested writes, `resolveTrack` find-or-creates tracks by name (`COLLATE NOCASE`; the name carries the layout — "Virginia International Raceway (Full)" vs "(Patriot)" — so bests/goals never mix across layouts), and `EVENT_SELECT`/`listEvents`/`tracksSummary` produce event rows with lap aggregates. Tracks stay per-user, but each row carries a nullable `catalog_id` into the seeded `track_catalog` table — a canonical identity matched by name (NOCASE) via `catalogIdForName` on create and rename, so the same physical track is recognizable across users without sharing user-entered data. The catalog also backs the track-name suggestions in the event form (`GET /api/catalog`); adding a track to it means a new migration.
- `lib/` — pure logic, unit-tested: `stats.ts` (`withComputed` derives `best_ms = MIN(manual best_time_ms, best logged lap)` and `consistency` — coefficient of variation, only with 3+ laps), `validate.ts` (slug/goal/lap validation), `session.ts` (session token + cookie plumbing), `oidc.ts` (id_token decode).

**Frontend** (`public/`, dependency-free vanilla JS as native ES modules — no build step):
- `app.js` — the module entry (`<script type="module">`): app state, `shell()`, the views and the hash router (`#/`, `#/new`, `#/event/:id`, `#/event/:id/edit`, `#/track/:id`, `#/settings` — vehicle garage management plus the privacy/terms links, reached from the account dropdown — plus public `/share/<slug>` pages with their own hash routes). Each route re-renders the whole view via `shell()`, so element handles go stale after any navigation; module-level listeners are used where per-render listeners would accumulate. HTML is built with template strings — always pipe user data through `esc()`.
- `js/platform.js` — the web/native seam: a mutable `platform` object with web defaults (same-origin `apiBase`, cookie logout, clipboard copy, localStorage-backed `prefGet`/`prefSet`/`prefRemove`) and null hooks the mobile shell fills in (system-browser login, share sheet, haptics, external links, server settings, and `bgLocation` — the background GPS watcher behind the lap recorder; null on web, which hides the feature). `api.js` routes every request through `platform.apiBase`/`authToken`; `app.js` consults the hooks at its native touchpoints. Keep it import-safe in Node (no top-level `location`/`navigator`).
- `js/` — extracted modules, importable by unit tests: `format.js` (`fmtMs`/`parseTime`/`esc`…), `chart.js` (hand-rolled SVG `lineChart` + `multiLineChart` lap overlay; lower lap time plotted lower = improvement trends downward), `channel-graphs.js` (an imported session's lap list as chips plus per-lap speed/RPM/lateral-G overlay charts in a collapsible `<details>`, on a shared driven-distance axis; up to 3 laps highlighted via the chips in the `--chart-line`/`-b`/`-c` slot colors, the rest a dim envelope), `lap-stats.js` (per-session analysis: best-N avg, pace slope, warmup), `year-review.js` (year-in-review aggregation), `api.js` (fetch wrapper throwing `ApiError` with status; routes everything through the offline layer below), `theme.js`, `pull-refresh.js` (touch pull-to-refresh: dampened pull past a threshold re-runs the current route's fetches, with the brand chevron sweeping left→right in a pill while refreshing; `initPullRefresh` is wired at the bottom of `app.js`).
- `js/offline.js` + `js/prefetch.js` — the offline-first layer (the *entire* offline story in the native shells, which don't run the service worker). `offline.js` keeps an IndexedDB cache of GET `/api` responses (in-memory backend in Node, so it's unit-testable) plus a persistent queue of writes made offline: `api.js` GETs are network-first with cache fallback, and queueable mutations (events/sessions/laps/track edits — the whitelist is `QUEUEABLE`) are stored, patched into the affected cached responses so the UI shows them immediately, and replayed in order on reconnect, with temp ids (`tmp-N`) mapped to real ids; `app.js` then remaps any `#/event/tmp-N` hash. Deleting a not-yet-synced row just cancels its queued items. Conflict policy is last-write-wins; server-rejected writes are dropped and surfaced in the shell's `#sync-banner` (updated in place by `updateSyncBanner`). `offline.js` deliberately mirrors two backend behaviors — `recomputeDetail` ↔ `withComputed` in `src/lib/stats.ts`, `cleanLaps` ↔ `sanitizeLaps` in `src/lib/validate.ts` — keep them in sync. `prefetch.js` warms the cache after a dashboard load: every event detail is prefetched, re-fetching only rows whose `updated_at` (new in migration 0011, trigger-maintained) differs from the cached copy. Signing out clears cache + queue.
- `js/record/` — the live lap recorder (native apps only; the `#/event/:id/record` route and the event page's record panel appear only when `platform.bgLocation` is set): `core.js` is the pure, unit-tested logic — fix validation/buffering, forgot-to-stop auto-stop (arms only after the car has been driven at track pace, so grid waits don't kill a recording), idle trimming, and `toParsed()`, which emits the same `{kind: "live", gps, needsLine, laps: []}` shape as a file parser; `ui.js` owns the app-global recording lifecycle (module state survives navigation; fixes checkpoint through `platform.prefSet` every ~10 s keyed `recording.pending`, recovered on next visit if the app dies; stopping keeps the recording checkpointed until saved or discarded) and hands the result to `reviewResults` in `js/import/ui.js` — the identical line-picker/review/save flow as a GPS file import. The raw trace never leaves the device.
- `js/import/` — the telemetry import feature: `channels.js` builds the per-lap channel data stored with imported sessions (`sessions.channels` JSON: each lap's speed — plus RPM/lateral G for PDR — resampled onto a 20 m driven-distance grid; the shape is validated server-side by `sanitizeChannels` in `src/lib/validate.ts` — keep the two in sync); `parse.js` dispatches a dropped file to a parser (`.vbo` → `vbo.js`, `.mp4` → PDR first, then GoPro `gpmf.js`); every parser returns `{kind, date, time, durationS, laps, gps, needsLine}`. `geo.js` projects GPS traces to local meters and derives laps from start/finish line crossings; `pdr-laps.js` recovers laps for beacon-less PDR recordings from latitude+odometer periodicity (autocorrelation lap length; start/finish phase anchored to a beacon-timed batch-mate via `anchorPdrBatch`); `ui.js` is the dropzone/review flow, including the click-a-map line picker for GPS sources without lap markers — GoPro, plain VBO (one picked line applies to the whole batch, with automatic longitude-sign mirroring for Racelogic's west-positive convention). Test fixtures for all formats are generated by `test/fixtures/build.mjs`. Real sample recordings for manual import testing live in the gitignored `telemetry-samples/` at the repo root — never commit footage.
- `pdr.js` — parses lap times, the GPS trace, and car metrics (top speed / max RPM / max lateral G) out of Corvette PDR (Cosworth) MP4 telemetry entirely in the browser via byte-range reads; the video is never uploaded. The beacon/odometer lap-derivation logic is reverse-engineered — see README before touching it. The stream is **delta-encoded** (framing matches ExifTool's GM.pm): each channel gets one full record, then 8-byte diffs against running decoder state that persists across samples — decoding the deltas is what yields ~11Hz lat/lon (radians, scaled via the `mrld` channel dictionary) and the Speed/RPM/acceleration channels. Coordinates only become a `gps` trace behind plausibility checks; when they don't decode, the raw latitude/odometer series returned as `channels` still feed lap recovery in `js/import/pdr-laps.js`.
- PWA: `manifest.webmanifest` + `sw.js` make the app installable and offline-capable (the service worker covers the app shell and last-known responses on the web; structured offline reads/writes live in `js/offline.js` above, which is all the native shells have — they drop `sw.js`). The service worker serves static files stale-while-revalidate (no build step, so no cache busting — changes land on the *second* load), navigations and `GET /api/*` network-first with cache fallback; `/auth/*` and non-GET are never intercepted. Signing out deletes the cached API data (`th-data-*` caches) so a shared device doesn't retain the previous user's logbook. Icons in `icons/` + `favicon.*` are generated from the brand mark — regenerate rather than hand-edit if the mark changes.

**Mobile apps** (`mobile/`, Capacitor iOS/Android shells — own npm project): `public/` is the single source of truth; `scripts/sync-www.mjs` copies it into the gitignored `www/`, drops `sw.js`/`.well-known/`, and swaps the module entry to `overrides/native.js` (which configures `js/platform.js`, then imports `app.js`). The lap recorder's GPS comes from `@capacitor-community/background-geolocation` (fixes keep flowing with the phone locked): its service/permissions merge in from the plugin's own manifest on Android, plus our `capacitor_background_geolocation_notification_channel_name` string and `android.useLegacyBridge: true` in `capacitor.config.json` (required — without it Android halts background updates after 5 min); iOS carries the two `NSLocation*UsageDescription` strings and `UIBackgroundModes: location` in `Info.plist`. Note Android 13+ needs the `POST_NOTIFICATIONS` runtime permission for the recording notification to be *visible* — the manifest permission is merged in, but nothing requests it at runtime yet (recording still works; the notification is just hidden). **The `<!-- native:strip-start/end -->` markers, the `/app.js` script tag, and the viewport meta in `public/index.html` are load-bearing for that script** — it fails the build if they drift (pinned by `test/unit/mobile-sync.test.js`). The transform also locks viewport zoom (`maximum-scale=1, user-scalable=no`) in the native build only: it stops iOS auto-zooming (and staying zoomed) on sub-16px input focus and disables pinch/double-tap zoom, while the web build keeps browser zoom for accessibility. Native projects `ios/`/`android/` are committed (custom `trackevolution://` scheme, Universal/App Links for `/share/*`); back navigation is native per platform — iOS enables the WKWebView edge-swipe gestures (`ios/App/App/ViewController.swift`, a `CAPBridgeViewController` subclass wired up in `Main.storyboard`), Android handles the system back gesture/button via the App plugin's `backButton` listener in `overrides/native.js` (in-page history back; minimize at the root); `resources/` holds the 1024px icon/splash inputs for `npx @capacitor/assets generate`. Never edit `mobile/www/`.

**Database** (`migrations/`, applied in order by wrangler): schema changes are new numbered migration files, never edits to existing ones. `tracks`/`events`/`sessions`/`vehicles` carry an `updated_at` (ms) maintained entirely by the triggers in `0011_updated_at.sql` — inserts and updates bump the row, and nested writes bump ancestors (laps → session → event) — so route code never touches it; it drives the frontend's offline-cache staleness checks.

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
