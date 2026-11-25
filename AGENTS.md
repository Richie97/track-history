# AGENTS.md

Guidance for coding agents (and humans) working in this repository. This is the
canonical instructions file — `CLAUDE.md` just imports it, so edit this file,
not that one.

## What this is

A personal HPDE/track-day logbook on Cloudflare Workers + D1 (SQLite): tracks → events → sessions → laps, with progress charts and Google (plus optional Apple) OAuth sign-in. Multi-user — every domain row is scoped to a `user_id`. The hosted instance users are pointed to is https://trackevolution.app.

## Commands

```sh
npm install
npm run seed:generate       # writes seed/seed.sql from seed data (see below)
npm run landing:generate    # regenerates the app host's landing page from site/ (see the site/index.html bullet)
npm run site:howto          # rewrites the docs pages' HowTo structured data from their marked step lists (see the SEO bullet)
node seed/cars/generate.mjs # regenerates migrations/0024_car_catalog.sql from seed/cars/ (see Seed)
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

`DEV_MODE=1` makes `GET /auth/login` sign in as a fixed local user (no Google OAuth) — navigate there once to get a session cookie. The bypass only answers on local dev hosts (`localhost`, `127.0.0.1`, `[::1]`, and the Android emulator's `10.0.2.2`); on any other hostname login falls through to real OAuth, so a leaked `DEV_MODE=1` fails closed. Still, never set it in production.

Deployment: `npm run deploy` (plus `db:migrate:remote` / `db:seed:remote`). Secrets are set via `npx wrangler secret put`.

Native clients (`apps/`, own build systems, not part of the npm project):

```sh
cd apps/ios/Packages/TrackEvolutionKit && swift test   # iOS pure logic, no simulator
# the app target's own unit tests — the layout breakpoints (NS-34) and nothing
# else; needs a simulator, unlike the Kit's
xcodebuild test -project apps/ios/TrackEvolution.xcodeproj -scheme TrackEvolution \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:TrackEvolutionTests
# the iOS screens end to end; needs `npm run dev`, skips without it
xcodebuild test -project apps/ios/TrackEvolution.xcodeproj -scheme TrackEvolution \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:TrackEvolutionUITests/CoreScreensUITests
# …and the same suite on an iPad, which is where the large-screen layout lives
xcodebuild test -project apps/ios/TrackEvolution.xcodeproj -scheme TrackEvolution \
  -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' \
  -only-testing:TrackEvolutionUITests/CoreScreensUITests
# the same iPad build as a Mac runs it (Designed for iPad, epic #230) — build only;
# no CI job runs this destination
xcodebuild build -project apps/ios/TrackEvolution.xcodeproj -scheme TrackEvolution \
  -destination 'platform=macOS,variant=Designed for iPad' CODE_SIGNING_ALLOWED=NO
apps/ios/generate.sh                                   # regenerate the Xcode project from project.yml
node apps/ios/Tools/generate-tokens.mjs                # regenerate iOS colour + layout tokens from public/style.css
cd apps/android && ./gradlew :core:test                # Android pure logic, no emulator
cd apps/android && ./gradlew :core:check               # …plus the "no Android dependency" guard
cd apps/android && ./gradlew :app:assembleDebug        # the Android Compose shell (needs ANDROID_HOME or local.properties)
cd apps/android && ./gradlew :app:bundleRelease         # the Play Store .aab, R8-minified (unsigned without TE_UPLOAD_KEYSTORE*)
node apps/android/tools/generate-tokens.mjs            # regenerate Android colour + layout tokens from public/style.css
npm run contracts:generate                             # refresh contracts/golden/ (the pinned API contract)
npm run contracts:logic                                # refresh contracts/logic/ (cross-language fixtures for ported logic)
npm run contracts:check                                # regenerate both and fail if the tree is dirty
```

The promo video (`promo/`, its own npm project — see `promo/README.md`):

```sh
cd promo && npm install                                # Playwright
node capture.mjs                                       # demo logbook on a scratch D1 (promo/.state), filmed → promo/out/screens
node audio/score.mjs                                   # the synthesised score → promo/out/score.wav
node render.mjs                                        # → promo/out/track-evolution-promo.mp4 (ffmpeg with libx264/aac, or $FFMPEG)
node render.mjs --stills 12,40.5                       # single frames, for checking a change
node guides.mjs                                        # the docs guides' screenshots → site/docs/img (dark + light WebP)
```

## Where the detail lives

This file is loaded into every agent session, so it holds only what every
change needs. The per-area notes are in `docs/agents/`. **Read the one for the
area you are about to change, and update it in the same change:**

| File | Read it before touching |
|---|---|
| `docs/agents/backend.md` | `src/`: routes, middleware, billing, coaching, clips, YouTube, MCP/OAuth, `src/lib/` |
| `docs/agents/web.md` | `public/`: `app.js` views and routes, the `js/` modules, telemetry import, offline, the lap stage, the PWA |
| `docs/agents/ios.md` | `apps/ios/`: project setup, the Kit, screens, billing, CarPlay, the Duo and the Mac |
| `docs/agents/android.md` | `apps/android/`: `:core` and `:app`, the recorder service, billing, Android Auto, screens |
| `docs/agents/clients.md` | anything that exists on more than one client: the feature split, ported logic, units, large screens, analytics, empty states |
| `docs/agents/database.md` | `migrations/`, triggers and derived columns, the seed and the car catalog |
| `docs/agents/site.md` | `site/` and `promo/`: the page inventory and what each page owes when a feature changes |
| `docs/agents/testing.md` | `test/`: the two Vitest projects and how billing, YouTube and MCP are mocked |
| `docs/agents/ci-release.md` | `.github/workflows/` and `release/`: CI, the Play test track, store submission |

Feature specs are `docs/specs/native/NS-*.md` (one per `NS-*` id, with the fixed
decisions) and `docs/specs/native/README.md` records which client gets which
feature. Search these files for a route, module or screen name rather than
reading them end to end.

## Documentation — update it as you go

**When a change alters behavior, setup or a user-facing feature, updating the
docs is part of the change, not a follow-up.** There are four places:

1. **`README.md`** — setup, deployment and feature descriptions for developers.
2. **The docs site (`site/`)** — static HTML at https://docs.trackevolution.app,
   written for drivers. `docs/agents/site.md` lists every page and what it
   owes. The rules that apply to any edit:
   - It points users at the hosted app, https://trackevolution.app, and never
     mentions Cloudflare, self-hosting, deployment or implementation details.
   - Download links come in pairs: wherever the App Store listing is linked,
     the Play Store listing is too.
   - `site/index.html` is also served by the Worker at the app's root, from a
     **generated** copy. An edit to it, `site/site.css`, `site/analytics.js` or
     the poster owes `npm run landing:generate`.
   - A numbered `<ol id="howto-…">` list has generated HowTo markup. An edit to
     its steps, its heading or the page's `<h1>` owes `npm run site:howto`.
   - The landing page's FAQ structured data must say the visible words, and a
     change to a price, tier or import source owes `site/llms.txt`, the FAQ and
     the offers. `test/unit/site-seo.test.js` and `landing.test.js` pin all of
     this.
   - A new page goes in every page's sidebar, the pager chain, the sitemap and
     `llms.txt`. Links are relative.
   - `privacy.html` owes an edit, and a new effective date, when data
     collection, storage or sharing changes.
3. **This file** — commands, the map below and the rules. Keep it short: a new
   rule that every change must respect goes here; everything else goes in
   `docs/agents/`.
4. **`docs/agents/`** — the notes for the area you changed.

## Issues close with the PR that finishes the work

Tracked work has a GitHub issue; the native work has one per `NS-*` spec. Put
`Closes #<n>` in the PR body, one line per issue, so merging closes it. A PR
that only partly implements a ticket uses `Refs #<n>`, leaves the issue open and
comments with what is outstanding. Never close an issue whose acceptance
criteria aren't all met.

## Architecture

One Cloudflare Worker serves the API and the static web app. `public/` is
served as SPA assets; the paths in `run_worker_first` (`wrangler.jsonc`) reach
the Worker first, including `/` itself, which is the landing page for a visitor
with no session cookie and the app shell otherwise.

- **Backend** (`src/`, Hono). `index.ts` composes the routers and **route order
  matters**: public routers (`/api/share`, the coach mount at
  `/api/students/:studentId`) are registered before `/api`, which sits behind
  `requireSession`. `api.ts` builds the `/api` router from a list; a new router
  is added there and to `API_ROUTERS` in `test/api/entitlement-gates.test.ts`.
  `routes/` has one router per resource, `db.ts` the data-access helpers (all
  take `(db, userId, …)` so ownership is visible at the call site), and `lib/`
  the pure, unit-tested logic. D1 costs a round trip per statement, so a route
  batches its statements and folds ownership checks into the write.
- **Web app** (`public/`). Dependency-free vanilla JS as native ES modules, no
  build step. `app.js` is state, views and the hash router; each route
  re-renders the whole view through `shell()`. Pure logic lives in `js/` where
  unit tests import it. `js/offline.js` is the offline cache and write queue.
  HTML is built with template strings: always pipe user data through `esc()`.
- **Native apps** (`apps/`). iOS is a SwiftUI app plus the `TrackEvolutionKit`
  package, which holds all pure logic and must never import UIKit or SwiftUI.
  Android is `:core` (pure Kotlin/JVM, no Android dependency, enforced by
  `checkNoAndroidDependency`) plus `:app` (Compose). Both keep bundle /
  application id `app.trackevolution`.
- **Contracts** (`contracts/`). `golden/` pins every API response shape and
  `logic/` pins ported pure logic, both generated from the server and the web
  implementation. The native decoders and ports are tested against them.
- **Database** (`migrations/`, D1/SQLite). Every domain row is scoped to a
  `user_id`. Derived columns (`updated_at`, `users.entitled_until`,
  `laps.device_timed`, the session conditions) are maintained by triggers, not
  routes.
- **Docs site** (`site/`) and **promo video** (`promo/`), each static and
  separate from the app.

## Rules every change respects

- **Schema changes are new numbered migrations**, never edits to an existing
  one. A migration that rebuilds a table must re-create its indexes and
  triggers.
- **No write route checks entitlement.** A Pro gate goes on a read
  (`requireEntitlement`), on one stripped field (`stripProFields`) or on the
  client. `POST`/`PUT`/`DELETE` on events, sessions, laps and tracks stay open
  to every account, because the offline layer drops rejected writes and a
  recording is irreplaceable. The four stated exceptions (setup-sheet writes,
  coach invites, the clip create, the YouTube create) are in
  `docs/agents/backend.md`; `test/api/entitlement-gates.test.ts` enumerates the
  guarded set, and every feature gets a row in the NS-32 tier table.
- **A 402 is an offer, not an error.** `{ error: "pro required" }` renders the
  paywall in place on every client (`proPanelHtml`, `ProUpsellCard`,
  `TEProLocked`), never a generic error or the sync banner.
- **Refusals that would confirm something exists are 404, never 403** (another
  user's lap, a coach without a grant, a share token).
- **DEV_MODE shortcuts are gated on the hostname** (`isDevHost` in
  `src/lib/dev.ts`), not only the flag, so a leaked `DEV_MODE=1` grants nothing.
- **Three clients, and "add it everywhere" is not the default.** The feature
  split is decided per feature in `docs/specs/native/README.md`; consult and
  update it before adding something to "the app". Width never reopens that
  list.
- **Ported logic keeps the same function and constant names as its JS
  original**, carries the JS test cases, and is pinned by a fixture in
  `contracts/logic/` generated from the web implementation. Assert against the
  reference, never against the other port. A change to shared behavior owes
  both ports the same edit, then `npm run contracts:check`.
- **Mirrored behavior is kept in step by hand.** Frontend and backend share no
  code (the one exception: `src/ai/` imports pure modules from `public/js/`, so
  those must never touch the DOM at load time). `recomputeDetail` in
  `offline.js` and both native `OfflineMirrors` mirror `withComputed`,
  `eventHours` and `eventCostCents`; `sanitizeSetup`, `sanitizeChannels` and
  `sanitizeLaps` have client mirrors too.
- **Generated files are never hand-edited:** `src/landing.generated.ts` and
  `public/site/`, the HowTo markup, the iOS and Android design tokens, the
  Xcode project (`project.yml` then `apps/ios/generate.sh`),
  `migrations/0024_car_catalog.sql`, `contracts/`, and the guides' screenshots.
- **`swift test` rewrites the Kit's `Package.resolved`**, which is also the
  app's. Revert that drift; never commit it.
- **Nothing car-related ships in the Android release build.** Android Auto
  lives in the `debug` source set, and `:app:checkReleaseHasNoCarApp` fails the
  build otherwise. `ACCESS_BACKGROUND_LOCATION` is debug-only for the same
  reason.
- **Imported video is never uploaded and never copied.** Parsing runs on the
  device. Only a lap clip the driver chooses to save is uploaded.
- **Privacy is by allow-list.** Share pages, shared items, the coach views, the
  leaderboards, the public track pages and the MCP tools each *copy* the
  permitted fields; a field added to a model stays private until it is added
  to a list. Never commit footage: real recordings live in the gitignored
  `telemetry-samples/`.

## Conventions

- Lap times are integer milliseconds everywhere; the web formats and parses
  `m:ss.fff` with `fmtMs` / `parseTime`.
- Stored units are fixed (°F for `events.temp_f`, km/h, psi, gallons, metres).
  The account's unit choice converts only at render and at form input.
- API errors are `{ error: string }` with a meaningful status; clients show
  that message.
- New API behavior needs a test in `test/api/`; new pure logic belongs in
  `src/lib/` or `public/js/`, where it is unit-testable.
- The vocabulary is the same on every client: **event** for the thing you add,
  **track day** only when counting days, then **session** and **lap**.
- An empty state is one component on each client (`emptyHtml`, `TEEmpty`), and
  a failed load retries through one control. See `docs/agents/clients.md`.
