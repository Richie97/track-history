# Track Evolution

A personal HPDE/track-day logbook: events, sessions, lap times and notes per track,
with progress charts over time. Runs on Cloudflare Workers + D1 (SQLite), signs in
with Google (or Apple), and fits comfortably in Cloudflare's free tier.

**The app:** https://trackevolution.app — the hosted instance, and where the docs
site points users. (This README covers development and deploying an instance;
the public docs site intentionally doesn't.)

**Marketing & docs site:** https://docs.trackevolution.app (also served at
https://richie97.github.io/track-history/) — static
pages in [`site/`](site/), deployed to GitHub Pages by
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) on every push to
`main` that touches `site/`. (One-time setup: repo *Settings → Pages → Source:
GitHub Actions*.)

Both the site and the app carry Open Graph / Twitter-card tags for link
previews; they share one social preview image, checked in as identical copies
at `site/og-image.png` and `public/og-image.png` (1200×630 PNG, rendered from
the site's design tokens — regenerate both together if the brand or tagline
changes).

## Stack

- **Cloudflare Workers** — serves the API (Hono) and the static frontend
- **D1** — SQLite database (tracks → events → sessions → laps; per-user tracks
  link to a seeded canonical track catalog by name, so the same physical track
  is identifiable across users — the catalog also backs the track-name
  suggestions in the event form)
- **Google OAuth** — login; new accounts get their own empty workspace. **Sign
  in with Apple** is an optional second provider (needs an Apple developer
  account — see deployment below); accounts are linked by email, so signing in
  with either provider reaches the same logbook
- Frontend is dependency-free vanilla JS (hash-routed SPA, SVG charts,
  offline-first via an IndexedDB response cache + write queue)

## Local development

```sh
npm install
npm run seed:generate       # writes seed/seed.sql from your seed data (see below)
npm run db:migrate:local    # creates the local SQLite schema
npm run db:seed:local       # loads the seed data
npm run dev                 # http://localhost:8787
```

Create `.dev.vars` (gitignored) for local development:

```
DEV_MODE=1
DEV_USER_EMAIL=you@example.com   # match your seed data's USER_EMAIL
DEV_USER_NAME=Your Name
GOOGLE_CLIENT_ID=dev
GOOGLE_CLIENT_SECRET=dev
```

`DEV_MODE=1` replaces Google login with a local dev user so you can develop
without OAuth credentials. The bypass only works on local dev hosts
(`localhost`, `127.0.0.1`, `[::1]`, `10.0.2.2`) — on any other hostname login
falls through to real OAuth — but it must still never be set in production.

### The API contract (`contracts/golden/`)

`npm run contracts:generate` starts the Worker against a scratch D1, builds a
fixed fixture, and writes every API response to `contracts/golden/` as JSON.
Those files are committed: they are the pinned shape of the API, and the native
iOS/Android clients' test suites decode them, so a response-shape change fails
those builds with a readable diff instead of breaking at runtime on a phone.

Regenerate whenever you deliberately change a response shape, and commit the
result with the change. CI runs `npm run contracts:check`, which regenerates and
fails if the tree is dirty.

The fixture is deliberately awkward — an event with no laps (`best_ms` and
`consistency` null), a session below the 3-lap threshold where `consistency`
stays null, sessions with and without channel data, both VIR layouts as separate
tracks, and one error response per status the clients handle. Volatile fields
(ids, timestamps) are normalized to stable placeholders of the same type rather
than deleted, so nullability is still pinned. Regenerating twice must produce a
byte-identical tree.

Why a standalone script rather than a test: `test/api/` runs inside workerd,
which has no filesystem access and so cannot write the files.

### Cross-language fixtures (`contracts/logic/`)

Some pure logic is ported from `public/js/` into the native clients — the lap
geometry that turns a recorded GPS trace into lap times, for instance.
`npm run contracts:logic` runs the **web** implementation over an analytic input
and commits what it produced; the Swift and Kotlin ports then assert identical
output, lap times to the millisecond. Reimplementing the fixture generator in
each language would only prove the three of them agree with each other.
`contracts:check` covers this tree too.

### Seeding your own history

`seed/generate.mjs` reads `seed/data.personal.mjs` if it exists (gitignored —
your real name, email and lap history stay out of the repo), otherwise
`seed/data.example.mjs`. Copy the example file to `data.personal.mjs`, fill in
your events, and re-run `npm run seed:generate`.

## Deploying to Cloudflare (one-time setup)

1. **Login & create the database**

   ```sh
   npx wrangler login
   npx wrangler d1 create track-history
   ```

   Copy the `database_id` it prints into `wrangler.jsonc` (replacing the zeros).

2. **Apply schema + seed your history**

   ```sh
   npm run db:migrate:remote
   npm run db:seed:remote      # imports your history (run once)
   ```

3. **Create a Google OAuth client**

   - Go to https://console.cloud.google.com/apis/credentials (any project)
   - *Create credentials → OAuth client ID → Web application*
   - Authorized redirect URI: `https://track-history.<your-subdomain>.workers.dev/auth/callback`
     (run `npx wrangler deploy` once first if you don't know your `workers.dev` subdomain;
     add your custom domain's `/auth/callback` too if you attach one)
   - If prompted to configure the consent screen: External, add yourself as a test
     user — or publish it, since only people you expect can do anything anyway.

4. **Set secrets & deploy**

   ```sh
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npm run deploy
   ```

5. **(Optional) Enable Sign in with Apple**

   Requires a paid Apple developer account. In the
   [developer portal](https://developer.apple.com/account/resources/):

   - Create (or reuse) an **App ID**, then create a **Services ID** (this is
     your `APPLE_CLIENT_ID`) with *Sign in with Apple* enabled; register your
     domain and `https://<your-domain>/auth/apple/callback` as the return URL
   - Create a **Sign in with Apple key**, note its Key ID, and download the
     `.p8` file (downloadable only once)
   - Set the secrets — the login screen shows the Apple button automatically
     once they're present (`GET /auth/providers` tells the frontend):

   ```sh
   npx wrangler secret put APPLE_CLIENT_ID    # the Services ID, e.g. app.example.web
   npx wrangler secret put APPLE_TEAM_ID
   npx wrangler secret put APPLE_KEY_ID
   npx wrangler secret put APPLE_PRIVATE_KEY  # paste the .p8 file's full PEM contents
   npm run deploy
   ```

Sign in with the account matching your seed data's `USER_EMAIL` and it
claims the imported history automatically. Other accounts get a fresh,
empty logbook.

## Native apps (in progress)

The Capacitor shells are being replaced by first-party native clients —
**SwiftUI** in [`apps/ios/`](apps/ios/) and **Jetpack Compose** in
[`apps/android/`](apps/android/) — so that background GPS recording and
CarPlay/Android Auto stop fighting a web view. The backend and the web app
(`public/`) are unchanged by that work: the web app stays the feature frontier
and keeps the desk-bound long tail (`.vbo` and other logger-file import, year in
review, the setup notebook and its lap-time correlation), while the native apps
own the on-track path — recording, the logbook you check between sessions, the
garage you check before an event, CarPlay/Android Auto, and **video** import,
which belongs on the device the footage is already on.

The work breakdown lives in [`docs/specs/native/`](docs/specs/native/) as `NS-*`
specs. The Capacitor apps below keep shipping until the native ones land.

The iOS client now carries the whole logbook natively — dashboard, event detail,
event form, track page, settings and the garage (vehicles, consumables, wear and
measurements), plus the read-only page a `trackevolution.app/share/<slug>` link
opens — on top of the lap recorder, the offline cache and write queue, and the
charts. **Video telemetry import is native too**: a PDR or GoPro clip picked from
Files or Photos is parsed on the phone, laps and all, without the video being
copied or uploaded. The setup notebook, the setup-vs-lap-times diff, year in
review, compare and `.vbo` import stay web-only by design.

```sh
cd apps/ios/Packages/TrackEvolutionKit && swift test   # iOS pure logic, no simulator
open apps/ios/TrackEvolution.xcodeproj                 # the iOS app

# the screens, against a local dev server (skips without one)
npm run dev
xcodebuild test -project apps/ios/TrackEvolution.xcodeproj -scheme TrackEvolution \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:TrackEvolutionUITests/CoreScreensUITests

cd apps/android && ./gradlew :core:test                # Android pure logic, no emulator
cd apps/android && ./gradlew :app:assembleDebug        # the Android app (needs the SDK)
```

The Android project is two modules, and the split is the point: `:core` is pure
Kotlin/JVM, so its tests run in seconds with no SDK and no emulator, while
`:app` is the Compose shell around it. Building `:app` needs an Android SDK —
either `ANDROID_HOME` in the environment or an `sdk.dir` line in a local
`apps/android/local.properties` (gitignored; Android Studio writes it for you).
`:core:test` deliberately still works without one.

`:core` currently holds the recorder core, the lap geometry, the domain models
and the API client; `:app` holds the design system. The screens themselves are
still to come. Two things worth knowing before touching either:

- **The palette is generated, not typed.** `public/style.css` is the source of
  truth for the design system, and `node apps/android/tools/generate-tokens.mjs`
  turns its dark and light token blocks into
  `ui/theme/ColorTokens.generated.kt`. Read colors through `TrackTheme.colors`,
  never as a hex literal, and change the stylesheet plus re-run the generator
  rather than editing the output. Material You dynamic color is deliberately off:
  the lime accent is the "faster" signal the charts rely on, and a wallpaper must
  not be able to recolor it. Geist and Geist Mono ship as variable fonts under
  `res/font/` (SIL OFL 1.1, license in `assets/licenses/`).
- **There is a token gallery.** A debug build adds a second launcher icon, "TE
  Tokens", showing every color in both themes plus the type scale and radii —
  which is how the port gets checked against https://trackevolution.app, and
  against the largest system font size, without diffing hex codes by eye. It
  lives in the `debug` source set, so it is not compiled into a release build.

iOS specifics — the generated-but-committed Xcode project, the bundle id shared
with the Capacitor app, Swift 6 concurrency, and why the CarPlay entitlement
stays out of the checkout — are in [`apps/ios/README.md`](apps/ios/README.md).

## Mobile apps (Capacitor)

[`mobile/`](mobile/) wraps the same frontend in native iOS/Android shells for
the App Store / Play Store. `public/` stays the single source of truth:
`mobile/scripts/sync-www.mjs` copies it into the Capacitor webDir, drops the
service worker, and swaps the module entry to `overrides/native.js`, which
configures the platform seam (`public/js/platform.js`) — bearer-token auth
against a configurable server, Google/Apple sign-in via the system browser
(PKCE + `POST /auth/exchange`), OS share sheet, haptics, status-bar theming — and then
imports the untouched `app.js`.

**Prereqs:** Xcode (iOS) / Android Studio (Android), plus CocoaPods on macOS.

```sh
cd mobile
npm install
npm run ios        # sync www/ + cap sync + open Xcode
npm run android    # sync www/ + cap sync + open Android Studio
npm run assets     # regenerate icons/splash from resources/ (uses @capacitor/assets)
```

**Developing against a local server:** run `npm run dev` at the repo root with
`DEV_MODE=1`, then open the app's server settings and point it at
`http://localhost:8787` (iOS simulator) or `http://10.0.2.2:8787` (Android
emulator — debug builds allow cleartext for this). The *Server:* link lives on
the "Can't reach the server" screen (it's deliberately not shown on the normal
sign-in screen) — get there by launching the app with networking off, e.g.
airplane mode. Sign-in then uses the dev bypass, no Google config needed.

**Users can also point the app at a self-hosted instance** via the same Server
setting; the Worker ships CORS for the Capacitor shell origins, so a standard
deploy of this repo works out of the box.

**Live lap recording:** the native apps can record a session's laps straight
from the phone's GPS (`public/js/record/` — the event page's *Record laps with
your phone* panel, native-only). Recording runs with the screen locked via
`@capacitor-community/background-geolocation` (Android: foreground service +
persistent notification; iOS: the `location` background mode — both configured
in the committed native projects, with `android.useLegacyBridge` set in
`capacitor.config.json` per the plugin's docs so background updates aren't
killed after 5 minutes). The recorder buffers ~1 Hz fixes in memory,
checkpoints them through Capacitor Preferences every few seconds (a killed app
recovers the recording on next launch), and auto-stops after the car has been
parked for 15 minutes. Stopping feeds the trace into the same import review +
start/finish line picker as a GoPro file — laps, best-lap racing line, and
per-lap speed channels, saved through the normal sessions API. Nothing needs
the server: the raw GPS trace never leaves the phone.

**CarPlay (iOS):** the iOS shell ships a CarPlay "driving task" scene
(`mobile/ios/App/App/CarPlaySceneDelegate.swift`) that remote-controls the lap
recorder — one Start/Stop button plus a status line on the car screen, so you
can start recording from the grid without touching the phone. Starting
attaches to the event whose dates cover today; with no matching event (or
offline, or signed out) it records anyway — recording is entirely on-device —
and the dashboard shows a banner for the event-less recording: create the
event whenever you like and the recording is adopted the moment you open that
event's record screen, feeding the usual review/line-picker/save flow.
Stopping keeps the recording checkpointed on the phone until it's saved or
discarded. The scene talks to the web
app through the app-local `CarPlayBridgePlugin.swift`
(`Capacitor.Plugins.CarPlayBridge`), wired to `platform.recorderRemote` /
`platform.onRecorderState` in `overrides/native.js`.

CarPlay apps require an Apple-granted entitlement.
**`com.apple.developer.carplay-driving-task` has been granted** and is checked in
— `mobile/ios/App/App/*.entitlements` for the Capacitor app, and
`apps/ios/App/TrackEvolution.entitlements` for the native one.

Two consequences worth knowing:

- **Removing the key doesn't break anything visibly.** The build still succeeds,
  the phone app is unaffected, and the CarPlay scene simply never attaches — so
  the feature disappears with nothing failing. CI asserts the key is present, and
  lints every entitlements file, for exactly that reason.
- **A device build that fails complaining about this key means a stale
  provisioning profile**, not a wrong key: refresh it (Xcode → Settings →
  Accounts → Download Manual Profiles). Signing fails for entitlements a profile
  doesn't carry, so a profile created before the grant won't do.

Still outstanding: documenting the feature for users in
`site/docs/lap-recording.html`. It is deliberately absent there until a
CarPlay-enabled build actually ships — the docs site must not advertise
features the shipped app doesn't have.

**Testing CarPlay in the iOS Simulator:** run on an iPhone simulator, then open
**I/O → External Displays → CarPlay** in the Simulator app. Tap the app icon
on the CarPlay home screen; use **Features → Location → Freeway Drive** for
GPS fixes fast enough to arm the recorder. Real head units (and Apple's
CarPlay Simulator from Additional Tools for Xcode, which runs a signed device
build) need the granted entitlement and a matching profile.

Note the CarPlay scene manifest moved the iOS app onto the UIKit scene
lifecycle: the iPhone window is now a scene (`PhoneSceneDelegate.swift`, which
also forwards OAuth-callback and universal-link URLs to Capacitor — under
scenes they bypass the `AppDelegate` callbacks).

**Release checklist:**

- iOS: set the real `<Team ID>.app.trackevolution` in `wrangler.jsonc`'s
  `IOS_APP_ID` (served at `/.well-known/apple-app-site-association`) and
  redeploy the Worker, so Universal Links to `/share/*` open the app.
  The Associated Domains entitlement lives only in the **Release**
  configuration (`App.entitlements`); Debug builds use the empty
  `AppDebug.entitlements` so free personal Apple teams can run the app on
  a device — don't add capabilities to the Debug side.
- Android: replace the placeholder SHA-256 fingerprint in
  `public/.well-known/assetlinks.json` with the one from Play Console → App
  signing, and redeploy, so App Links verify.
- Store listings: sell the logbook features; the tip link is already hidden on
  iOS builds (Apple 3.1.1) and external links open in the system browser.
- Xcode Cloud: builds work out of the box —
  `mobile/ios/App/ci_scripts/ci_post_clone.sh` installs Node/CocoaPods if
  missing, runs `npm ci`, rebuilds `www/`, and runs `cap sync ios` (which runs
  `pod install`) before the archive step, since `node_modules/`, `www/`, and
  `Pods/` are all gitignored.

## Video / telemetry import

On any event page, **Import video / telemetry…** turns recordings into sessions
with laps. Parsing happens entirely on your own device — for videos, via
byte-range reads of the embedded telemetry track (a few MB of a multi-GB file);
**files never leave your computer or phone**. Supported sources:

- **Corvette PDR (Cosworth) MP4** — lap times from beacon/odometer telemetry,
  the GPS trace from the delta-encoded lat/lon channels, and car metrics (top
  speed, max RPM, max lateral G) from the speed/engine channels; a recording
  with no beacons still gets lap times, from the GPS line picker or recovered
  from the latitude + odometer channels (details below).
- **GoPro MP4** (Hero 5+) — the GPS trace from the GPMF metadata track.
- **Racelogic VBO** (VBOX, and RaceChrono / TrackAddict / Harry's LapTimer
  exports) — laps from the file's `[laptiming]` start line when present,
  otherwise from the GPS trace.

The two **video** formats also import on the native iOS app (**Import video** on
any event page, or "Open with Track Evolution" from Files): a GoPro clip arrives
over Wi-Fi into Photos and a PDR clip lands in Files off a USB stick, so the
phone is usually where the footage already is. The parsers are ported (`PDR`,
`GPMF`, `Series` and `TelemetryChannels` in `apps/ios/Packages/TrackEvolutionKit`)
and pinned to the JavaScript implementation's output by
`contracts/logic/video-parsers.json`, so the same clip yields the same lap times
either way. The clip is read in place through a security-scoped file handle —
never copied, never uploaded. `.vbo` import stays on the web: a VBOX writes to an
SD card that gets read on a laptop.

GPS-only sources have no lap markers, so the import preview shows the driven
track map: **click where the start/finish line is** and laps are timed each
pass across it (interpolated between 10–18 Hz fixes — accurate to roughly
±0.1–0.3s, shown with `~`). One picked line applies to every file in the
batch.

Imported sessions also store **per-lap channel data** — speed for every
source, plus RPM and lateral G for PDR — resampled onto a uniform
driven-distance grid (20 m) so laps overlay corner-for-corner. On the event
page the session's lap list doubles as the chip picker for the expandable
**channel graphs** below it: all laps as a dim context envelope, up to three
laps highlighted at a time via the chips (best lap pre-selected), with a
shared distance axis and hover readouts.
Everything is derived at import time in the browser (recordings are never
uploaded), sanitized server-side (`sanitizeChannels`), and stored as JSON on
the session row; the public share page never includes it.

How PDR lap times are derived (reverse-engineered from the `ctbx`/`marl`
telemetry track and validated against Cosworth Toolbox lap times):

- PDR "Beacon" events mark start/finish crossings to the millisecond, but the
  recorder drops some crossings.
- The cumulative odometer channel recovers the missing ones: beacon-to-beacon
  distance ÷ crossing count gives the lap length, and a missing crossing is the
  moment distance passes `D0 + k × lapLength` (accurate to ~0.05–0.3s, shown
  with `~`). Crossings beyond the first/last beacon are extrapolated the same
  way and sanity-checked against GPS latitude.
- The telemetry stream is **delta-encoded** (the framing matches ExifTool's
  GM.pm, the reference decoder for the Marlin format): a channel gets one
  16-byte full record — absolute channel/value/timestamp — and then streams
  8-byte diff records against the decoder's running state. Decoding the
  deltas is what yields the GPS trace (lat/lon at ~11Hz, stored as radians
  scaled by the file's channel dictionary) plus the car channels — Speed,
  RPM, accelerations — from which the import reports **top speed, max RPM
  and max lateral G**. (An earlier parser version read only full records,
  which made it look like PDR firmware recorded no GPS: longitude gets
  exactly one full record, at recording start.) All decoded coordinates
  still sit behind plausibility checks before they become a trace.
- With a GPS trace, a beacon-less PDR recording uses the same start/finish
  **line picker** as the other GPS sources. If the GPS channels don't decode,
  a beacon-less recording still gets lap times: latitude as a function of
  odometer distance repeats every lap, so the **lap length is the
  autocorrelation peak** of that profile, and lap times are cut every
  lap-length of distance (validated on real footage: lap length within 2m
  and lap times within ±0.2s of beacon-derived values). Start/finish
  alignment comes from a beacon-timed recording of the same track in the
  same import batch (matched by lap length, aligned by cross-correlating the
  latitude profiles); without one, laps are cut from where the car first
  reaches pace — real laps of the full track, just not aligned to the
  official line. All flagged `~`.

For manual testing with real recordings, drop them in a `telemetry-samples/`
directory at the repo root — it's gitignored, so large videos and personal
footage never end up in the repo. (Automated tests use small synthetic
fixtures generated by `test/fixtures/build.mjs` instead.)

## Offline support

The app is offline-first on every platform (and this is the whole offline
story for the native apps, which don't run the service worker):

- **Reads** — every successful `GET /api` response is cached in IndexedDB
  (`public/js/offline.js`), and after the dashboard loads, a background warmer
  (`public/js/prefetch.js`) prefetches every event detail — re-fetching only
  rows whose `updated_at` changed — so the whole logbook is browsable with no
  connection. On the web, the service worker additionally serves the app shell
  itself offline.
- **Writes** — mutations the app can mirror locally (events, sessions, laps,
  setup sheets, track notes/goals) are queued in IndexedDB when the network is
  down. Queued
  writes patch the cached responses so the UI reflects them immediately, and
  replay in order once the server is reachable; rows created offline get temp
  ids that are remapped to real ids on sync. Conflict policy is last-write-wins;
  writes the server rejects are dropped and reported in the sync banner.
  Vehicle, garage-part and share-link management need a live server answer and
  simply fail offline with the normal error (garage *reads* still work from
  the cache).
- `updated_at` columns (migration `0011_updated_at.sql`, maintained by SQLite
  triggers so nested writes bump their parents — laps → session → event) drive
  the staleness checks, and are the groundwork for real delta sync later.

Signing out clears the offline cache and the write queue, so a shared device
doesn't retain the previous user's logbook.

## Notes on the data model

- An event's **best time** is `MIN(best logged lap, manual best)` — the manual
  field exists because the spreadsheet-era events only recorded a best time.
- **Consistency** is the coefficient of variation (stdev ÷ mean) of all laps in an
  event; shown once an event has 3+ laps. Lower is more consistent.
- Imported per-session bests (from a spreadsheet era) appear as one-lap sessions;
  full lap-by-lap data can be attached to any event via `RAW_SESSIONS` in the seed
  data or pasted into the UI.
- **Prep checklists** hang off an upcoming event: tick items off as you pack,
  and the dashboard's countdown card shows how far through you are. The list a
  new checklist starts from is **yours to edit** — account menu → Settings → Prep
  checklist — and is stored per user (`users.checklist_template`), so every
  client offers the same list. Until you edit it you get the app's built-in
  default (`public/js/checklist.js`, ported to iOS as
  `EventDates.DEFAULT_CHECKLIST` and pinned to it by
  `contracts/logic/checklist.json`). Editing the template never rewrites a
  checklist already on an event — those are snapshots taken when the list was
  started, and rewriting one would untick what you had already dealt with.
- **Vehicles** are a per-user garage (account menu → Settings) with a name and
  free-text modification notes. An event's `car` stays a plain text column —
  the garage feeds the event form's suggestions, and the vehicle marked as
  default pre-fills new events. When the car text matches a garage vehicle by
  name (case-insensitive), the event also carries a `vehicle_id` link — that
  link is what the garage logbook below hangs off. The Settings page also
  carries the privacy policy and terms links (the only place the native apps,
  which render no footer, expose them).

## Garage logbook: consumables, wear & setup notebook

Each garage vehicle has a page (`#/vehicle/:id`) that folds the parts
spreadsheet and the paper setup notebook into the logbook:

- **Track-hours ledger** — every event computes on-track `hours`: an explicit
  per-event override (`events.track_hours`, "On-track hours" on the edit
  form), else `max(days × 2h, total logged lap time)`. The 2h/day default is
  `DEFAULT_HOURS_PER_DAY` in `src/lib/wear.ts`; lap time only ever pushes the
  estimate *up*, because best-lap-only history badly underestimates seat time.
- **Consumables** (`parts` + `part_measurements` tables) — part *instances*
  (pads, tires, rotors, brake fluid, oil…) with install/retire dates, cost,
  optional expected life and a replace-at value. **Usage is computed, never
  logged**: a part accrues the hours of every event on its vehicle inside its
  service window. Tires additionally count heat cycles (≈ event days).
  Remaining life comes from the best available basis (`wearEstimate` in
  `src/lib/wear.ts`): a least-squares fit of wear measurements vs. accrued
  hours when 2+ measurements exist ("measured"), else expected hours minus
  accrued ("expected") — and a new part with no expected life defaults it to
  the average of retired lifecycles of the same kind. Parts at/near end of
  life surface in a maintenance-due strip on the dashboard and vehicle page;
  retired parts keep hours, cost and cost-per-hour history. Replacing a
  consumable with a fresh set of the same thing is one tap — **Refresh**
  (`POST /api/parts/:id/refresh`) retires the current part and inserts a
  same-spec successor with hours reset, its expected life recalibrated from
  the lifecycle just completed.
- **Setup notebook** (`setups` table, one JSON sheet per event day, validated
  by `sanitizeSetup` in `src/lib/validate.ts`) — tire pressures (cold/hot per
  corner), camber/toe/caster, damper clicks, sway settings, fuel, and
  references to the part sets on the car. New sheets **copy forward** from the
  previous day or the vehicle's last event (`GET
  /api/events/:id/setups/prefill`), so only changes need typing; each sheet
  stores the full resolved snapshot, so diffing never chases a chain. The
  track page's "Setup vs. lap times" table (`GET /api/tracks/:id/setups`)
  shows every sheet at that track with what changed between sheets next to
  the event's best/consistency.
- **Privacy** — parts, wear, spend and setup sheets are never included in the
  public share payload.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
