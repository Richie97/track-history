# Track Evolution

A personal HPDE/track-day logbook: events, sessions, lap times and notes per track,
with progress charts over time. Runs on Cloudflare Workers + D1 (SQLite), signs in
with Google (or Apple), and fits comfortably in Cloudflare's free tier.

**The app:** https://trackevolution.app — the hosted instance, and where the docs
site points users. (This README covers development and deploying an instance;
the public docs site intentionally doesn't.)

**In the app stores:** https://apps.apple.com/us/app/track-evolution/id6792941186
(iOS) and https://play.google.com/store/apps/details?id=app.trackevolution
(Android) — both builds of the hosted app, sharing the bundle id / application id
`app.trackevolution`. Every download link in `site/` and the web sign-in screen
(`appStoreLinkHtml` in `public/app.js`) offers both platforms; keep the two in
step when either listing moves.

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

> **Migrate before you deploy.** Every authenticated request reads
> `users.entitled_until` in the same statement as the session, so a Worker
> deployed ahead of its migrations answers 500 on all of `/api/*`, not just the
> new routes. `npm run db:migrate:remote` first, `npm run deploy` second — on
> the first deploy and on every upgrade.


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

6. **(Optional) Enable subscriptions — Track Evolution Pro**

   The billing server side (spec `docs/specs/native/NS-32-subscriptions.md`)
   ships dark: without these secrets every account is free, the store routes
   answer 503, and nothing a user can see changes. See
   [Subscriptions](#subscriptions-track-evolution-pro) for what each piece is.

   ```sh
   npx wrangler secret put APPLE_IAP_KEY_ID            # App Store Connect → Users and Access → Integrations → In-App Purchase
   npx wrangler secret put APPLE_IAP_ISSUER_ID
   npx wrangler secret put APPLE_IAP_PRIVATE_KEY       # that key's .p8 PEM (a different key from Sign in with Apple)
   npx wrangler secret put GOOGLE_PLAY_SERVICE_ACCOUNT # the service account's JSON key file, whole
   npm run deploy
   ```

   `LEGACY_CUTOFF` (phase D) belongs with these, as a **secret** rather than a
   `wrangler.jsonc` var: the contract harness starts the Worker from that file
   and pins the entitlement shapes through the Android legacy claim, which the
   cutoff would turn into a 403 and make `npm run contracts:check` fail.

Sign in with the account matching your seed data's `USER_EMAIL` and it
claims the imported history automatically. Other accounts get a fresh,
empty logbook.

## Native apps

The shipped iOS and Android apps are first-party native clients — **SwiftUI**
in [`apps/ios/`](apps/ios/) and **Jetpack Compose** in
[`apps/android/`](apps/android/) — which replaced the web-view shells that used
to wrap `public/`, so that background GPS recording and CarPlay stop fighting a
web view. The backend and the web app (`public/`) were unchanged by that work.

**There are three clients, and "add it everywhere" is not the default.** The
web app is the feature frontier and keeps the desk-bound long tail (`.vbo` and
other logger-file import, year in review, the setup notebook and its lap-time
correlation); the native apps own the on-track path — recording, the logbook you
check between sessions, the garage you check before an event, CarPlay, and
**video** import, which belongs on the device the footage is already on. The
split is deliberate and is recorded per feature in
[`docs/specs/native/README.md`](docs/specs/native/README.md); the work breakdown
is the `NS-*` specs beside it.

The iOS client now carries the whole logbook natively — dashboard, event detail,
event form, track page, settings and the garage (vehicles, consumables, wear and
measurements), plus the read-only page a `trackevolution.app/share/<slug>` link
opens — on top of the lap recorder, the offline cache and write queue, and the
charts. **Video telemetry import is native too**: a PDR or GoPro clip picked from
Files or Photos is parsed on the phone, laps and all, without the video being
copied or uploaded. The **two-lap telemetry compare** is native as well — the
track page's "Compare two laps" opens the same delta-and-channels comparison the
web renders, on the same `CompareLaps` maths pinned by
`contracts/logic/compare-laps.json`, and so are the **sector splits and
theoretical best** in the channel-graphs panel (`Sectors`, pinned by
`contracts/logic/sectors.json`). The setup notebook, the setup-vs-lap-times
diff, year in review, the two-event overlay and `.vbo` import stay web-only by
design.

The Android client now has the logbook too — dashboard, event detail, event form,
track page, settings and the garage (vehicles, consumables, wear and
measurements), plus the read-only page a `trackevolution.app/share/<slug>` link
opens — on top of the lap recorder, the offline cache and write queue, and the
charts, including the two-lap telemetry compare. The same desk-bound features
are web-only as on iOS. Video import is native on Android as well: the event page's
**Import video…** opens the system file picker or the photo picker (or a clip is
shared in from Files or Photos), the same PDR/GoPro parsers run on the phone against
the same `contracts/logic/video-parsers.json` fixture the iOS port is pinned to, and
the review — line picker, laps, channels, save — is the recorder's own screen.

Both recorders show **live lap timing** while you drive: a lap counter, last
and best lap, and a predictive delta to the session's best. The recorder
doesn't know the start/finish line during a session (that's picked at review
time), so timing anchors its own gate at the first fix at track pace —
in practice the pit exit, which is on the racing line and gets re-crossed
every lap. Live times are unofficial (the saved laps still come from the
review line pick); the logic is `public/js/record/live-timing.js`, ported to
both apps and pinned by `contracts/logic/live-timing.json`.

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
cd apps/android && ./gradlew :app:testDebugUnitTest    # Robolectric; still no emulator
```

The Android project is two modules, and the split is the point: `:core` is pure
Kotlin/JVM, so its tests run in seconds with no SDK and no emulator, while
`:app` is the Compose shell around it. Building `:app` needs an Android SDK —
either `ANDROID_HOME` in the environment or an `sdk.dir` line in a local
`apps/android/local.properties` (gitignored; Android Studio writes it for you).
`:core:test` deliberately still works without one.

The Android app also carries an **Android Auto** surface — one screen with a
Start/Stop control over the same recorder — but it is built into **debug builds
only** and does not ship. Google Play rejected it: Android Auto has no category
for a driving-task app, so it was declared under Points of Interest, and the car
app quality review judged it against that category (criterion `PF-1`, meaningful
functionality relevant to driving). A lap timer has no point-of-interest
functionality, and no other supported category fits either, so this is not a
wording fix.

That matters beyond the car screen: while the Android Auto form factor is opted
in, the review fires on any submission carrying a car-compatible artifact, and a
failure in the production track rejects the **whole** submission — blocking
ordinary phone updates. So the release build carries none of it, and
`./gradlew :app:checkReleaseHasNoCarApp` fails the build if a car declaration
reappears under `src/main`. Starting a recording from the car is instead the
recording notification's Stop action plus the driving-sized recording screen on
the phone. (iOS is unaffected — Apple granted the CarPlay driving-task
entitlement, which has no Android equivalent.)

`:app`'s own tests are Robolectric rather than instrumentation, so they need the
SDK but no emulator. They exist for one thing the `:core` tests cannot claim:
the offline write queue is exercised against **real SQLite**, closing and
reopening the database file, because the queue holds recorded lap sessions that
exist nowhere else until they replay.

`:core` holds the recorder core, the lap geometry, the domain models, the API
client, the offline cache and write queue, the chart maths and the recording
journal; `:app` holds the design system, sign-in, the lap recorder's foreground
service, and the screens. Things worth knowing before touching either:

- **Sign-in runs in a Chrome Custom Tab**, never a WebView — Google blocks OAuth
  in embedded web views, which is why the server grew a PKCE native-app flow.
  A debug build can point itself at a local `wrangler dev` from the small server
  line under the sign-in buttons; `http://10.0.2.2:8787` is offered as a preset
  because 10.0.2.2 is the emulator's alias for the host, and the server's
  `DEV_MODE` bypass answers there, giving one-tap local sign-in with no Google
  round trip. That control and the cleartext-traffic exception it needs exist in
  debug builds only.
- **The recorder is a foreground service, and the service — not the activity —
  owns the recording.** That is what lets it keep taking fixes with the screen
  off and after the app is swiped out of recents. The old web-view shell had to
  fall back to a legacy bridge to stop Android halting its background location
  after five minutes; a foreground service has no such limit and no such
  workaround.
  Every accepted fix is appended to a journal on disk as it arrives
  (`RecordingJournal` in `:core`, so it unit-tests on the JVM), so a force-stop
  loses nothing rather than the ~10 s the WebView recorder could, and the next
  launch offers the recording back. Stopping hands it to a review screen: tap
  the driven trace where the start/finish line is, check the laps that fall out,
  pick the event, save. Nothing there is required for the recording to continue,
  and back never stops one. A debug build also keeps a "TE Recorder" launcher
  icon for driving the service directly; feed either with
  `adb emu geo fix <lon> <lat>` on an emulator.
- **Pro is sold through Play Billing** (the server side is under
  [Subscriptions](#subscriptions-track-evolution-pro) below). The purchase
  flow is `billing/` in `:app`; `:core` holds only the entitlement model and
  the tier predicates, and its no-Android-dependency check keeps the store SDK
  out. Testing it needs the **internal track**, not a local build: Play only
  vends products to an app it installed, so add your Google account as a
  **licence tester** (Play Console → *Settings → License testing*), install the
  build from the internal-testing opt-in link, and subscribe from Settings →
  *Subscription* — licence testers are charged nothing, and test subscriptions
  renew on a minutes-long clock, so a cancel or lapse can be watched land in
  Settings within the hour. Point the app at the hosted server, not
  `wrangler dev`: the token is verified against the Play Developer API with
  `GOOGLE_PLAY_SERVICE_ACCOUNT`, which a dev server doesn't carry (it answers
  `503 billing not configured`, and the purchase then stays *unacknowledged*
  until a server does accept it — deliberately, since Play refunds an
  unacknowledged subscription after three days rather than leaving a paying
  user on Free). This build is also the **transitional release** for
  grandfathering: it sends `X-TE-Client: android/<versionCode>` on every
  request and claims the legacy grant once per install on launch, which shows
  in Settings as *Pro · lifetime*. The tier gates themselves stay off until
  phase D.
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
- **So is a chart gallery.** A third debug launcher, "TE Charts", draws the
  progress chart, trackmap and lap overlay in both themes, plus the line picker
  on a 20,000-fix trace. Charts are drawn rather than laid out, so no unit test
  can tell you a trace came out mirrored or a ramp backwards — and that trace is
  also the performance case, since a stored lap is capped at 300 points and only
  a raw recording is that long.

iOS specifics — the generated-but-committed Xcode project, Swift 6 concurrency,
the recorder, the offline queue and the screens — are in
[`apps/ios/README.md`](apps/ios/README.md).

## CarPlay (iOS)

The iOS app ships a CarPlay **driving task** scene ([`apps/ios/App/CarPlay/`](apps/ios/App/CarPlay/))
that remote-controls the lap recorder — one Start/Stop button plus a status line
on the car screen, so you can start recording from the grid without touching the
phone. There is no bridge layer: the scene drives the same recorder the phone UI
does, reached through `AppServices`.

Starting attaches to the event whose dates cover today; with no matching event
(or offline, or signed out) it records anyway — recording is entirely on-device —
and the dashboard shows a banner for the event-less recording. Create the event
whenever you like and the recording is adopted the moment you open that event's
record screen, feeding the usual review/line-picker/save flow. Stopping keeps the
recording checkpointed on the phone until it's saved or discarded; the dashboard
banner carries a Discard button for exactly that, so a recording you don't want
doesn't need an event created just to reach one.

The attachment rule is deliberately conservative — it never guesses past today —
and is pinned across clients by `contracts/logic/remote-attach.json`.

CarPlay apps require an Apple-granted entitlement.
**`com.apple.developer.carplay-driving-task` has been granted** and is checked in
at `apps/ios/App/TrackEvolution.entitlements`. Two consequences worth knowing:

- **Removing the key doesn't break anything visibly.** The build still succeeds,
  the phone app is unaffected, and the CarPlay scene simply never attaches — so
  the feature disappears with nothing failing. CI asserts the key is present, and
  lints the entitlements file, for exactly that reason.
- **A device build that fails complaining about this key means a stale
  provisioning profile**, not a wrong key: refresh it (Xcode → Settings →
  Accounts → Download Manual Profiles). Signing fails for entitlements a profile
  doesn't carry, so a profile created before the grant won't do.

**Testing it in the Simulator:** run on an iPhone simulator, then open **I/O →
External Displays → CarPlay** in the Simulator app. Tap the app icon on the
CarPlay home screen; use **Features → Location → Freeway Drive** for GPS fixes
fast enough to arm the recorder. Real head units (and Apple's CarPlay Simulator
from Additional Tools for Xcode, which runs a signed device build) need the
granted entitlement and a matching profile.

**Android has no equivalent, and won't.** See the Android Auto note above: the
car surface exists but is debug-only, because Android has no category for a
driving-task app and the Play car review rejects it under Points of Interest.

## Release checklist

- **iOS Universal Links:** set the real `<Team ID>.app.trackevolution` in
  `wrangler.jsonc`'s `IOS_APP_ID` (served at
  `/.well-known/apple-app-site-association`) and redeploy the Worker, so links
  to `/share/*` open the app.
- **Android App Links:** `public/.well-known/assetlinks.json` carries the
  SHA-256 of the **Play app-signing** key (Play Console → *Test and release →
  App integrity → App signing key certificate*). Confirm with
  `adb shell pm get-app-links app.trackevolution`, which should report
  `verified` — a locally-signed build never will, since the fingerprint is
  Play's. If the signing key is ever reset, update this file and **redeploy the
  Worker**; it is served from `public/`, so it doesn't need an app update.
- **Android target API level — a recurring annual deadline.** Play enforces it
  at *upload*: the target must stay within a year of the latest Android release,
  so from 31 Aug 2026 an update targeting below API 36 (Android 16) is refused
  outright. Raise `targetSdk` (and `compileSdk` with it — the check is on the
  target, so moving `compileSdk` alone changes nothing) in
  `apps/android/app/build.gradle.kts`, then read Android's behaviour-changes page
  for what the new target now gates. Expect this again around Aug 2027.
- **Android Auto form factor must stay opted out** in Play Console → *Advanced
  settings → Form factors*. A car artifact in the production track fails review
  and rejects the **whole** submission, blocking ordinary phone updates.
  `./gradlew :app:checkReleaseHasNoCarApp` guards the build side; nothing can
  guard the Console side.
- **Store listings:** sell the logbook features; the tip link is hidden on iOS
  builds (Apple 3.1.1) and external links open in the system browser.
- **App version:** Xcode Cloud manages the build number (`CFBundleVersion`), but
  the marketing version is ours — `MARKETING_VERSION` in
  [`apps/ios/project.yml`](apps/ios/project.yml), followed by
  `apps/ios/generate.sh`. Once a version has been approved on the App Store its
  train closes, and further uploads are rejected at *Prepare Build for App Store
  Connect* with ITMS-90186 ("train version is closed") / ITMS-90062 ("must
  contain a higher version") — so bump it before the first upload of a new
  release. On Android the equivalents are `versionCode` / `versionName` in
  `apps/android/app/build.gradle.kts`.

### Play Store test track

The **Play Store test track** workflow
([`.github/workflows/android-release.yml`](.github/workflows/android-release.yml))
builds the native Android client (`apps/android`), signs it with the upload key
and pushes the `.aab` to Play. It fires two ways: **automatically on every merge
to `main` that touches the Android client** (same path filter as `android.yml`),
which uploads to the **internal** track, and manually from the Actions tab via
`workflow_dispatch`. Dispatch inputs: the track (`internal`, `alpha` or `beta` —
production is deliberately absent, since that rollout is the staged,
percentage-gated Console operation), optional `versionCode` / `versionName`
overrides, and a dry run that builds and signs but uploads nothing, attaching
the bundle to the run instead.

It needs five repository secrets:

| Secret | What it is |
| --- | --- |
| `PLAY_UPLOAD_KEYSTORE_BASE64` | the upload keystore, as `base64 -w0 upload.jks` |
| `PLAY_UPLOAD_KEYSTORE_PASSWORD` | its store password |
| `PLAY_UPLOAD_KEY_ALIAS` | the key alias inside it |
| `PLAY_UPLOAD_KEY_PASSWORD` | that key's password |
| `PLAY_SERVICE_ACCOUNT_JSON` | a Google Cloud service-account JSON, granted *Release manager* on the app under Play Console → Users and permissions |

The keystore **must be the existing upload key**, or Play rejects the build as a
different app; a lost upload key is a Play support process with a lead time, not
a workaround. Locally the release variant builds *unsigned* rather than falling
back to the debug key, so an artifact signed with anything else can't be
produced by accident, and the workflow verifies the signature before uploading.
Play requires a `versionCode` strictly higher than anything it has ever
received for `app.trackevolution` — including a rejected submission, which
burns its code anyway. The workflow therefore derives the `versionCode` from
the commit count of the ref it builds (strictly monotonic on `main`, and
already far past every burned code), so the automatic per-merge uploads never
collide; the dispatch input overrides it for the odd case, such as building an
older ref whose count sits below a code `main` has already burned.
`versionName` comes from `apps/android/app/build.gradle.kts` unless the
dispatch input overrides it, and the `versionCode` checked in there is only
what local builds get — it is not kept in step with Play.
If the upload step fails with *"A change was made to the application outside
of this Edit"*, the build is fine: Play refuses to commit an edit when the app
changed under it, typically because someone was saving in the Play Console
while the workflow ran. The edit is discarded, so its version code is not
burned; re-run the job.

Two things no build can check, both from NS-27: **Android Auto must be opted out
in the Play Console** — the code side is guarded by
`./gradlew :app:checkReleaseHasNoCarApp`, which the workflow runs before
anything else, but the Console opt-in is manual, and a car review failure
rejects the *entire* submission, ordinary phone updates included — and the
recorder must survive a real track day before the rollout goes past 10%.

The release build is **minified and shrunk by R8** (`isMinifyEnabled` /
`isShrinkResources` in `apps/android/app/build.gradle.kts`). Google Play scores
every app's obfuscation and code/resource shrinking and warns that a category
under 25% can affect the listing's visibility and publishing — an unminified
bundle scored 1% on obfuscation and drew that notice — so this is a store
requirement, not a size optimization. Its consequence is the mapping file:
release stack traces are obfuscated, so the workflow refuses to upload a bundle
with no `mapping.txt`, sends the mapping to Play alongside the bundle (crashes
and ANRs deobfuscate in the Console) and attaches it to the run for sideloaded
test builds. Play shows a second warning on every bundle — *"contains native
code, and you've not uploaded debug symbols"* — that is **not actionable**: the
only native code is AndroidX's (`graphics-path`, DataStore's shared counter),
shipped in its AARs already stripped, so AGP's `ndk.debugSymbolLevel` produces
no symbol file to upload. It is a warning, not a rejection; leave it.
Keep rules live in `apps/android/app/proguard-rules.pro`; the
libraries in use ship their own, so that file stays small, and a class R8 can't
find fails the build with the missing rules listed in
`app/build/outputs/mapping/release/missing_rules.txt`. To reproduce the
shippable artifact locally (unsigned):

```sh
cd apps/android && ./gradlew :app:bundleRelease
```

The iOS side has no equivalent: those builds go through Xcode Cloud, which
archives and uploads to TestFlight itself.

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
source, plus RPM, lateral G, throttle, brake and steering angle for PDR
(whichever channels the recording carries; a channel the file lacks simply
draws no graph) — resampled onto a uniform
driven-distance grid (20 m) so laps overlay corner-for-corner. On the event
page the session's lap list doubles as the chip picker for the expandable
**channel graphs** below it: all laps as a dim context envelope, up to three
laps highlighted at a time via the chips (best lap pre-selected), with a
shared distance axis and hover readouts. With two or more laps highlighted, a
**delta chart** renders above the channels: cumulative time gained/lost vs.
the fastest of the selection, by distance — elapsed time is integrated from
each lap's speed samples and scaled so it lands exactly on the timed lap, so
the trace shows *where* on track the difference lives (`lapTimeSeries` /
`deltaSeries` in `public/js/channel-graphs.js`, pinned for ports by
`contracts/logic/lap-delta.json`). The same elapsed-time series yields
**sector splits and a theoretical best lap** without any setup: each lap is
cut into three equal slices of its own driven distance (so every lap's splits
add up to exactly its lap time), the panel tabulates the highlighted laps'
sectors with the session's best in each sector marked and the gap otherwise,
and the best sectors across the session sum to the theoretical best — shown
beside the actual best in the session's stats line when it's quicker, so the
gap quantifies what consistency was worth (`public/js/sectors.js`, pinned for
the native ports by `contracts/logic/sectors.json`).
Everything is derived at import time in the browser (recordings are never
uploaded), sanitized server-side (`sanitizeChannels`), and stored as JSON on
the session row; the public share page never includes it.

Any two stored laps at a track can also be compared **across sessions and
events**: the track page's **Compare two laps** view (`#/track/:id/lap-compare`)
pairs any two laps with channel data — defaulting to the best lap of your most
recent event vs. your all-time best — and shows a head-to-head table (lap time,
top/min/avg speed, max RPM, max lateral G, full-throttle and braking shares),
the pair's sector splits with their combined theoretical best,
the delta chart, and the channel overlays on one distance grid, resampling when
two sessions stored different grid spacings and warning when the driven lengths
diverge enough to suggest a different layout or start line (the pure logic is
`public/js/compare-laps.js`, pinned for the native ports by
`contracts/logic/compare-laps.json`).

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
  RPM, accelerations, throttle/brake pedal position, steering angle — from
  which the import reports **top speed, max RPM and max lateral G**. (An earlier parser version read only full records,
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
- **One gap worth knowing about:** an event created offline **at a track with no
  history** has no card on the dashboard until it syncs. The front page lists
  upcoming events and tracks, the queued write patches the cached `/events` list
  but not `/tracks` (a track invented offline has no id the server would agree
  with), and an event dated today isn't "upcoming" — so it is unreachable from
  the front page in the meantime. It is not lost: the write is queued and
  replays, and a lap recording started in that window still attaches to it
  (`pickRecordingEvent` reads the in-memory event list, not the dashboard).
  Creating the event at a track you've driven before avoids the gap entirely.
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

## Subscriptions (Track Evolution Pro)

Track Evolution is freemium: the **logbook is free** (tracks, events, sessions,
lap times, best laps, progress charts, sharing, leaderboards, the vehicle list),
and **Pro** is the analysis — the GPS lap recorder, telemetry import and channel
data, garage consumables, the setup notebook and year in review. Pro is
**$1.99/month or $19.99/year**, sold through the App Store and Google Play; the
web app shows the tier and points at the phone apps to subscribe. Anyone who
bought the $1 app before subscriptions is **Pro for life**. The full tier table,
and the reasoning, is `docs/specs/native/NS-32-subscriptions.md`.

The entitlement is **owned by the server**. One account spans three clients and
Apple can't restore a Play purchase, so the Worker is the only thing that
decides tier: `users.entitled_until` plus a `subscriptions` table (migration
`0017`), exposed as `entitlement { tier, source, expires_at, auto_renew }` on
`GET /api/me`. It rides along in the same D1 statement as the session lookup, so
a Pro gate costs no extra round trip.

**How a purchase becomes an entitlement**

| Route | Who calls it | What it does |
|---|---|---|
| `POST /api/billing/apple` `{ jws, renewal_jws? }` | the iOS app, for every verified transaction | Verifies StoreKit 2's JWS *locally* — x5c chain to the pinned Apple Root CA G3, ES256 signature, bundle id, the WWDR and receipt-signing extension OIDs — and upserts the row by `originalTransactionId`. No network beyond the POST itself. |
| `POST /api/billing/google` `{ purchase_token, product_id }` | the Android app | Reads the purchase from the Play Developer API (`purchases.subscriptionsv2.get`) with the service account and upserts by `purchaseToken`. **The app acknowledges the purchase only after this returns 200** — Play refunds unacknowledged subscriptions after three days. |
| `POST /api/billing/apple/legacy` `{ jws }` | iOS, once, on launch | The `AppTransaction` JWS proves the app was bought before subscriptions; writes a permanent `legacy` row. |
| `POST /api/billing/google/legacy` (header `X-TE-Client: android/<versionCode>`) | the Android transitional release, once per install | Play can't tell a client whether the app was bought, so the claim is trusted until `LEGACY_CUTOFF` (an env var, set to the flip date). Unset ⇒ every claim succeeds. |
| `POST /billing/apple/notifications` | App Store Server Notifications V2 | Public, outside `/api`. Signature-verified like a purchase; re-derives the row's state from the signed transaction + renewal info inside. Unknown types are acked and logged. |
| `POST /billing/google/rtdn` | Real-Time Developer Notifications, as a Pub/Sub **push** subscription | Public. Verifies the push's OIDC bearer (Google's JWKS; `aud` = this URL; `email` = the service account) before decoding anything, then re-reads the token from the API — RTDN says *something* changed, the API says *what*. |
| cron `17 9 * * *` | Cloudflare | Re-verifies every Apple/Google row expiring in the next 48 h or expired in the last 7 days against its store, so a missed webhook costs a day, not a customer. |

Every billing route answers `{ ok, entitlement }` so the client can update at
once. The same purchase posted from a second device updates the row; posted
from a *second account* it is a **409** and nothing moves. A revoked or refunded
purchase drops Pro immediately; an expiry gets **three days of slack** on top of
the store's own grace period, so webhook lag never reads as a lapse.

**A lapse never destroys laps.** No `POST`/`PUT`/`DELETE` on events, sessions,
laps or tracks checks entitlement, ever — the offline layer drops rejected
writes, and a recording made under Pro and replayed after a lapse would be
deleted. The recorder and importer gate *at start*, on the phone, against the
cached entitlement; the server gates the Pro *reads* (garage consumables, setup
sheets) and strips one field (`sessions.channels`) from session payloads. None
of those gates are wired yet (phase A ships dark); phase D turns them on.

**Store setup checklist** (phase B/C/D; nothing here is needed to deploy the
server):

- *App Store Connect:* one subscription group "Track Evolution Pro" with
  `app.trackevolution.pro.monthly` and `.yearly`; an In-App Purchase key (the
  `APPLE_IAP_*` secrets); Server Notifications V2 URLs for sandbox **and**
  production both set to `https://trackevolution.app/billing/apple/notifications`;
  privacy-policy and terms links in the metadata; Small Business Program
  enrolment.
- *Play Console:* one subscription with monthly and yearly base plans; a
  service account with *View financial data* and *Manage orders and
  subscriptions* (its JSON key is `GOOGLE_PLAY_SERVICE_ACCOUNT`); an RTDN
  Pub/Sub topic with a **push** subscription to
  `https://trackevolution.app/billing/google/rtdn` that authenticates as that
  same service account (or set `GOOGLE_RTDN_EMAIL` to the one it uses). Android
  Auto stays opted out.
- Optional: `APPLE_FIRST_SUBSCRIPTION_BUILD` makes the server also check that a
  legacy claim's `originalApplicationVersion` predates the first **free** build,
  on top of the app's own check (`Entitlement.APPLE_FIRST_SUBSCRIPTION_BUILD` in
  the iOS Kit, the same `compareVersions` rule). Both stay unset through phases
  B and C, when the app is still a paid download and every install legitimately
  claims; phase D sets both to the first free build's number — which is **Xcode
  Cloud's** build number, not `CURRENT_PROJECT_VERSION`, so it can only be read
  off that archive once it exists.

Local testing needs no store: `test/api/billing.test.ts` signs payloads with a
synthetic certificate chain (`test/fixtures/billing/`, rebuilt by `build.sh`)
that the Worker trusts only under `DEV_MODE` via `APPLE_IAP_TEST_ROOT_PEM`, and
mocks the Apple and Google APIs in `vitest.workers.config.mts`.

## Sharing & leaderboards

- **Share links** (`/share/<slug>`, claimed in the header's share button) serve
  the SPA shell **with per-slug Open Graph meta** injected by the Worker
  (`sharePage` in `src/routes/share.ts`; `/share/*` is in `run_worker_first`),
  so a link pasted into iMessage/Slack previews with the driver's name, event
  count and headline bests instead of the generic app card. Only data the
  public share payload already exposes is used.
- **Per-track leaderboards** are strictly **opt-in** (Settings → Leaderboards,
  or the track page's join button; `users.leaderboard_opt_in`). Opting in
  shares exactly two things with other signed-in users, per track: your display
  name and your best lap (with its event date). Tracks are matched across
  users by `tracks.catalog_id`, so leaderboards exist only for tracks the
  seeded catalog knows, and never mix layouts. The endpoint
  (`GET /api/tracks/:id/leaderboard`) computes each user's best with the same
  `MIN(manual best, best logged lap)` rule as everywhere else.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
