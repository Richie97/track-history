# TrackEvolution — iOS (native)

The first-party SwiftUI client that replaces the Capacitor shell in `mobile/`.
Work is broken down in [`docs/specs/native/`](../../docs/specs/native/); this
directory is the home of every `NS-*` spec marked **iOS**.

## Layout

```
apps/ios/
  project.yml                  XcodeGen source of truth for the project
  generate.sh                  regenerates TrackEvolution.xcodeproj
  Schemes/                     hand-written shared schemes copied in by generate.sh
  TrackEvolution.xcodeproj      generated, but COMMITTED (see below)
  App/                         app target — SwiftUI views, scenes, platform services
    Import/                    video telemetry import: pickers, file byte source
    Info.plist                 hand-maintained (GENERATE_INFOPLIST_FILE is off)
    TrackEvolution.entitlements
    Assets.xcassets/
  Packages/TrackEvolutionKit/  local SPM package — all pure logic
    Sources/TrackEvolutionKit/
      Models/                  Codable models + LapTime formatting
      API/                     APIClient, APIError, request bodies
      Recorder/                lap geometry, recorder core
      Telemetry/               PDR + GoPro parsers, per-lap channels, lap recovery
    Tests/TrackEvolutionKitTests/
```

**`TrackEvolutionKit` must not import UIKit or SwiftUI.** It builds for macOS as
well as iOS, which is what lets `swift test` run the whole suite in seconds with
no simulator — the fast loop for the ported logic (models + API client, recorder
core, lap geometry, offline store). Anything that needs a UI framework or a
system service belongs in the app target.

## Build and test

```sh
# fast loop — pure logic, no simulator
cd apps/ios/Packages/TrackEvolutionKit && swift test

# the app
cd apps/ios
xcodebuild -project TrackEvolution.xcodeproj -scheme TrackEvolution \
  -destination 'generic/platform=iOS Simulator' build
xcodebuild test -project TrackEvolution.xcodeproj -scheme TrackEvolutionKit \
  -destination 'platform=iOS Simulator,name=iPhone 17'

# or just open it
open TrackEvolution.xcodeproj
```

## Design system

`public/style.css` is the source of truth. If the app's tokens change, the port is
updated to match — never the other way round.

Colors are **generated**, not transcribed:

```sh
node apps/ios/Tools/generate-tokens.mjs
```

reads the stylesheet's dark and light token blocks and writes
`App/Assets.xcassets/Colors/*.colorset` (Any = light, Dark = dark, since the web
app defaults to dark and follows the device) plus `ColorTokens.generated.swift`.
It fails if a token exists in one theme and not the other. Both outputs are
committed. Use the tokens through the asset symbols Xcode generates —
`Color(.bgPage)`, `Color(.textMuted)` — and never a literal hex.

The light and dark values are genuinely different hues in places, not lightness
flips: `accentInk` is lime on dark and dark olive on light, and the chart series
colors change entirely. Don't collapse them.

Hand-written, in `App/DesignSystem/`:

- `Typography.swift` — the type scale mapped onto Dynamic Type. Every style
  declares the system text style it scales with, and tracking (an `em` value in
  CSS) is applied in points against the *scaled* size. `.teStyle(.h1)` on any
  view. Lap times use `.lapTime`, which is monospaced with tabular figures so a
  column of times aligns on the decimal.
- `Shape.swift` — radii, spacing, the standard animation curve, and `TECard`. The
  app's depth is deliberately flat: hairline border plus one surface step, never
  stacked shadows. `teShadowPop()` is for popovers only.
- `ThemePreference.swift` — the system/light/dark override, persisted, mirroring
  the web app's `data-theme`.
- `BrandMark.swift` — the app mark: the Speedshift double-bar on a lime disc, the
  port of `ssBars`/`appLogoHtml` in `public/app.js` (same viewBox, same two
  rotated rects, and the same rule that the bars are `accentContrast` because dark
  ink is what sits on the lime fill). A `Shape` rather than a bundled image, so it
  scales and follows the tokens in both appearances with no asset to drift from.
- `TokenGallery.swift` — `#if DEBUG` only. Every swatch, the type scale and the
  radii, which is how this port gets reviewed:

```sh
xcrun simctl launch <device> app.trackevolution -tokenGallery
xcrun simctl ui <device> appearance light          # and dark
xcrun simctl ui <device> content_size accessibility-extra-extra-extra-large
```

**Geist is not bundled yet.** The web loads Geist and Geist Mono from Google
Fonts and this repo holds no font binaries, so `Typography` falls back to SF Pro
/ SF Mono and says so in the gallery. Dropping `Geist-*.otf` and `GeistMono-*.otf`
into `App/Fonts/`, adding them to `UIAppFonts` in `Info.plist`, and re-running
`generate.sh` switches it over with no other change.

## The API contract is a test, not a convention

`GoldenContractTests` decodes every entry in `contracts/golden/manifest.json`
into its model, then **re-encodes it and compares the two JSON trees**. That
second half is what makes the test useful: a field the server sends and the model
doesn't have shows up as a missing key rather than a silently dropped value, and
an endpoint with no model at all fails outright.

The goldens are read from the repo (located by walking up from the test file),
never copied into the package — a copy would rot exactly when it mattered. If a
backend change is deliberate, run `npm run contracts:generate` and update the
models in the same change.

Nullability is the part that bites, and it is pinned by `ModelTests`:
`consistency` is nil below 3 laps (never 0), `bestMs` is nil when there's neither
a manual best nor any laps, `hours` is never nil. See `withComputed` in
`src/lib/stats.ts` for the rules.

Numeric *width* bites too, and the goldens can't catch it on their own — they only
contain whole numbers. `Event.days` is a `Double`, because the column is `days REAL`
and the web form's input steps by 0.5: a Saturday plus a Sunday morning is `1.5`.
Modelled as an `Int` it doesn't round, it **throws**, failing the decode of the whole
events list for anyone who has ever logged a half day. `ModelTests` pins it off the
wire rather than through a golden for exactly that reason. When adding a model field,
check the migration's column type, not just the captured sample.

Updates use `Patch<Value>` rather than plain optionals, because the server only
writes columns whose keys are *present* in the body: `.unchanged` omits the key,
`.set(nil)` sends an explicit null and clears the column.

## Sign-in

The flow is the server's, unchanged (`src/routes/auth.ts`): generate a PKCE
verifier, open `/auth/login?client=app&code_challenge=…` **in the system browser**
(Google forbids OAuth in an embedded web view — this is why the flow is shaped
this way), catch the `trackevolution://auth?code=` redirect, and `POST
/auth/exchange` the code plus verifier for a bearer token.

Three server behaviors the client has to respect, each of which produces a
confusing error otherwise:

- The challenge is `base64url(SHA-256(verifier))` **unpadded** — wrong encoding
  gives `401 PKCE verification failed`. `PKCE` is pinned against RFC 7636's
  worked example.
- The one-time code lives **60 seconds**. Exchange it immediately.
- The code is **burned on first use, before verification**, so a failed exchange
  can't be retried — recovery is restarting the flow, and the error message says
  so.

The token lives in the Keychain as `kSecAttrAccessibleAfterFirstUnlock`, not
`WhenUnlocked`: the recorder runs with the phone locked and a saved session has to
reach the server from there. It is deliberately *not* `...ThisDeviceOnly`, so a
restored phone stays signed in — the token is a revocable session, not a password.

The Apple button is drawn only when `GET /auth/providers` advertises it (a
deployment without the `APPLE_*` secrets doesn't), and it's Apple's own
`ASAuthorizationAppleIDButton` — App Review rejects approximations — wired to our
web flow rather than `ASAuthorizationController`.

Its appearance is not a free choice. The guidelines allow three styles (black,
white, white-with-outline) and no custom colors for the mark or the title, so what
the app controls is *which* one:

- **Black on light, white on dark**, picked from `colorScheme`. The same inversion
  `.btn.apple` already does on the web through `--text-strong`/`--surface-card`. It
  was pinned to `.white`, which put a white button on the near-white `bgPage` and
  was near-invisible in light mode. The style is **init-only** — no property
  changes it — so the view carries `.id(colorScheme)` and is rebuilt when the theme
  flips; without that the button keeps its launch-time appearance.
- **Corner radius** is the one dimension they explicitly allow you to match to your
  own buttons ("you can use a corner radius value that matches the other buttons in
  your UI"), hence `TERadius.md`, the same radius `TEButtonStyle` draws.
- **Height scales with Dynamic Type.** The button renders its own label and doesn't
  follow Dynamic Type on its own, so a fixed height leaves it visibly slighter than
  the Google button at large text sizes — and Sign in with Apple must not be the
  less prominent option. Scaling the frame scales the label with it.

Both buttons are capped at 260pt wide, mirroring `.login-buttons` in
`public/style.css`: full-bleed buttons read as a form to fill in rather than a
choice to make. The cap is a `@ScaledMetric`, so it grows rather than clipping
"Continue with Google" at accessibility sizes.

Two things about that fetch are load-bearing, both learned from the button going
missing on a real phone:

- **It is never awaited at launch.** `restore()` used to gate the auth decision on
  it, so a cold start on a weak connection sat on the launch spinner for the full
  URLSession timeout and *then* showed a Google-only sign-in screen. Nothing at
  launch needs the answer — `SignInScreen` asks for itself when it appears, which
  also covers signing out mid-session (`signOut()` doesn't re-ask).
- **The answer is remembered per server** (`AuthProvidersStore`), so a failed fetch
  leaves the last known answer standing instead of silently downgrading to
  Google-only. It only ever stores what a server advertised and never invents a
  provider, so a self-hosted instance without the secrets still draws Google alone,
  and `wrangler dev` doesn't inherit the hosted app's answer.

`SignInUITests.testSignInScreenDoesNotWaitOnTheProvidersFetch` pins the first by
pointing the app at a black-hole address; it needs no dev server, so it runs in CI.

Pointing the app at a dev server needs no test hook, because `UserDefaults` reads
launch arguments:

```sh
npm run dev   # at the repo root, with .dev.vars
xcrun simctl launch <device> app.trackevolution -server.url http://localhost:8787
```

The dev bypass signs in as `DEV_USER_EMAIL` from `.dev.vars`, which **must match
`USER_EMAIL` in the seed data** or the app signs into a real but empty account —
the seeded logbook belongs to the other address, and every screen looks broken in
the same way an empty logbook does.

Not done: the tap-through sign-in on a device.

## The screens

`App/Screens/` is the logbook (NS-25). One `@Observable` model per screen owns its
data and its writes; the views are layout. Nothing calls the network directly —
every read and write goes through `APIClient`, which *is* the offline layer, so
there is no separate offline path to forget to test.

| Screen | Web reference |
|---|---|
| `DashboardScreen` | `viewDashboard` |
| `EventScreen` + `EventModel` | `viewEvent` |
| `EventFormScreen` | `viewEventForm` |
| `TrackScreen` | `viewTrack` |
| `SettingsScreen` | `viewSettings` |
| `SharedLogbookScreen` | the public `/share/<slug>` page |

`App/Navigation/Router.swift` holds the typed `NavigationStack` path. Deep links are
parsed by `DeepLink` in the Kit — pure, so the routing table is unit-tested rather
than tapped through. Two things it settles:

- `trackevolution://auth?code=…` is **not** a route. `ASWebAuthenticationSession`
  consumes it, and treating it as navigation would race the sign-in flow for a
  one-time code that is burned on first use.
- `/share/<slug>` — the only pattern the association file advertises
  (`src/routes/wellKnown.ts`) — opens `SharedLogbookScreen`. Without it, tapping
  someone's shared link opens the app showing *your* logbook, which is worse than
  not handling the link.

A link that arrives while signed out is held and applied after sign-in, so tapping
a share link, signing in, and landing on that logbook is one flow.

**The garage** — vehicles, consumables, wear and measurements — is native
(`App/Screens/VehicleScreen.swift`, NS-29). Three things about it are load-bearing:

- **The wear math is not ported.** `GET /api/garage` arrives with each part's
  estimate already computed by `src/lib/wear.ts`, and the Kit only decides how to
  *say* it (`Garage.swift`). The thresholds and phrasing that it does own are
  pinned against the web implementation by `contracts/logic/garage-status.json`.
- **It needs a live server.** Garage writes are deliberately absent from the
  offline queue: retiring a part rewrites the wear of everything around it, and a
  "refresh" is two rows in one request whose successor id the client can't invent.
  Reads still come from the cache, so the garage is *readable* in the paddock.
- The dashboard fetches `/garage` independently of the rest and swallows its
  failure — an empty garage or a failed fetch must not take the logbook down.

**Deliberate absences.** The per-day setup notebook, the setup-vs-lap-times diff,
year in review, compare, and telemetry file import are web-only
(`docs/specs/native/README.md`). They are absent, not stubbed.

**Absent for want of an endpoint, not by choice:** editing a lap in place and
reordering sessions. There is no `PUT /laps/:id` and no sort endpoint, and `src/`
is out of scope here — so a mistyped lap is deleted and retyped, which is what the
web app offers too.

Two web behaviors are deliberately *not* ported, because they are workarounds for
things the platform gives away: `pull-refresh.js` (a hand-built approximation of
`.refreshable`) and the per-row Delete buttons the web app needs for want of a
swipe gesture.

## The lap overlay

`App/Charts/LapChannelChart.swift` is the port of `public/js/channel-graphs.js`
(NS-23): every lap of an imported session on one driven-distance axis, up to three
highlighted at once in the `--chart-line` / `-b` / `-c` slots with the rest a dim
envelope, the fastest lap pre-selected, and lap chips that double as the legend so a
lap is never identified by color alone. Tapping a chart parks a read-out on the
nearest grid point — on *every* chart at once, since they share the axis.

The maths lives in the Kit (`ChannelGraphs`): the lap↔channel matching, the highlight
slots, the axis window. `matchLapsToChannels` keeps its JS name and its JS test cases,
and `contracts/logic/channels.json` pins it against the reference implementation.

The data (`sessions.channels`) only ever comes from the **web** telemetry importer, so
the panel has no data source on a phone-recorded session and the event page then
offers no way in. To see it without importing a file first:

```sh
xcrun simctl launch <device> app.trackevolution -channelGraphs   # synthetic data
```

`UITests/ChannelGraphsUITests` covers the real thing. It is the one screen test that
can't create what it asserts on through the UI, so it seeds a session over the dev
API (the same `DEV_MODE` door `DevServerSignIn` uses) and deletes the event again.

Three things about Swift Charts are load-bearing here, all found by the app wedging
rather than by any assertion failing:

- **Suppress accessibility per mark** (`.accessibilityHidden(true)` on the `LineMark`).
  Charts publishes an element for every mark; a few hundred per lap makes the
  hierarchy so large that any snapshot of it — which VoiceOver and every UI test take
  — never returns. Hiding the *chart* does not prune them. The chart's summary goes on
  the container instead, which is what a chart should say anyway.
- **Keep the builder homogeneous**: one `ForEach` of `LineMark`s and nothing else. A
  `RuleMark` or an `if` beside it makes the content type a nested tuple over those
  same few hundred marks. The read-out's rule is a two-point line in the same data.
- **Not in a `List` row.** A chart this size inside one never settles — the row is
  measured over and over and the app stops idling. Hence the sheet, which also gives
  three stacked charts the height they want on a phone.

## Screens are tested against a real server

`UITests/CoreScreensUITests` walks all five screens against `npm run dev`,
`UITests/GarageUITests` walks a consumable from install to measurement, and
`DevServerSignIn` is the shared way in. `UITests/OfflineWritesUITests` then does the
same CRUD with **no reachable server** — the app is relaunched pointed at a dead port,
which is what a lost connection looks like to `URLSession` — and checks that the
cached logbook still reads, that a queued write is on screen immediately, that the
sync banner says so, and that all of it survives a relaunch. They skip when no dev
server answers, so `xcodebuild test` and CI stay green.

```sh
npm run dev
xcodebuild test -project apps/ios/TrackEvolution.xcodeproj -scheme TrackEvolution \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:TrackEvolutionUITests/CoreScreensUITests
```

**Connect the simulator's hardware keyboard** (Simulator → I/O → Keyboard →
Connect Hardware Keyboard, or `defaults write com.apple.iphonesimulator
ConnectHardwareKeyboard -bool true`). With the software keyboard, `typeText` can
take the app down through an XPC fault in the keyboard's own service — it surfaces
as "Lost connection to the application", with no crash log and no stack, and it
fails tests that have nothing to do with whatever you just changed.

**Pin the destination by id (`-destination 'id=<udid>'`) when you're chasing a
failure.** `name=iPhone 17` also matches "iPhone 17 Pro", so the device you
prepared and the device the test ran on can be different ones — which reads as
maddening nondeterminism.

**Two checkouts of this repo can't both use port 8787.** The second `wrangler dev`
takes 8788, and by default both apps' UI tests still sign into 8787 — so one
checkout's tests write to the other's logbook. Point them at the right one with
`TEST_RUNNER_TE_DEV_SERVER` in xcodebuild's **environment**:

```sh
TEST_RUNNER_TE_DEV_SERVER=http://localhost:8788 xcodebuild test …
```

Passing it as a trailing `KEY=VALUE` argument does nothing — xcodebuild reads that
as a build-setting override, and the tests quietly keep using the default.

**Don't pass `CODE_SIGNING_ALLOWED=NO` when running UI tests.** It's right for the CI
*build* (no signing secret is a prerequisite for green), but an unsigned build has no
keychain-access-group entitlement, so every Keychain call fails with `-34018`
(`errSecMissingEntitlement`). Sign-in still appears to work — the token is cached in
memory for the life of the process — and then silently doesn't survive a relaunch,
which looks exactly like an auth bug in the app.

Each attaches a screenshot **on success**, not only on failure: the progress chart,
the sparklines and the trackmap are drawn in a `Canvas`, so a render that goes wrong
fails no assertion. That is how the x-axis bug was caught — Swift Charts anchors an
automatic numeric domain at zero, so an axis of Unix timestamps started in *1970*
and squeezed a season's progress into a vertical line. Export them with:

```sh
xcrun xcresulttool export attachments --path <result>.xcresult --output-path <dir>
```

Tests that create data delete it again. The dev logbook is shared between them, and
leftovers silently rewrite the dashboard's totals and which event is next. Two tests
do read the example seed, for history no UI can create in a test: a past event's
progress chart, and an upcoming event for the hero slot.

## The recorder

`App/Recording/` is the reason for the rewrite. Three pieces:

- `LocationService` — `CLLocationManager` configured for a track day. The settings
  are the point: `pausesLocationUpdatesAutomatically = false` above all, because
  left on, iOS pauses updates when it decides you've stopped, which happens in pit
  lane and silently ends a recording. Deliberately *not* iOS 17's
  `CLLocationUpdate.liveUpdates()`, which doesn't expose those knobs.
  `CLLocation` becomes a `RawFix` value before crossing to the main actor, so
  nothing non-`Sendable` does — and the fix's **own** timestamp is used, or a
  batched delivery would collapse to one instant and be rejected as
  non-monotonic.
- `FixJournal` — every accepted fix appended to disk as it arrives, one JSON line
  each, so a force-quit costs nothing. (The web app checkpoints the whole
  recording every ~10 s, driven by fix arrival because `setInterval` throttles
  with the screen off.) **NS-15 asks for SQLite via GRDB shared with NS-21's
  store; this is an append-only journal instead** — no dependency, and a better
  fit for a write-per-fix path whose only query is "read it all back". Swap the
  implementation behind this type if NS-21 wants one database.
- `RecordingController` — the app-global lifecycle, owned by the scene so
  navigating away can't end a recording. Evaluates `shouldAutoStop` per fix,
  recovers an unsaved recording at launch, and can adopt an event-less recording
  into an event after the fact (`attach(eventId:)`), which is what CarPlay needs.
- `RecordingBanner` — a recording is visible from every screen, because navigating
  away deliberately doesn't stop it.
- `LinePickerView` + `ReviewScreen` — stopping leads to review, never straight to a
  save: a GPS recording has no lap markers, so the user taps the trace to place the
  start/finish line and the lap list recomputes on every tap. The fitting and
  hit-testing maths live in the Kit (`TraceMap`) where they're unit-tested; the
  view only draws. **`channels` is sent as nil** — per-lap speed channels would
  need `js/import/channels.js` ported, and a half-formed shape is rejected by
  `sanitizeChannels` with a 400. `trace` *is* sent: the best lap's polyline from
  `Geo.bestLapTrace`.

Nothing is destroyed on the way through. A stopped recording stays checkpointed
until it is saved or explicitly discarded (with a confirmation), and a **failed
save keeps it** — the whole point is a phone in a paddock. Saving now goes through
NS-21's write queue, so a save with no signal is queued rather than merely retryable.

## CarPlay

`App/CarPlay/` is NS-19: start and stop a recording from the head unit, talking
**directly** to the recorder — no bridge, no serialization, no JS.

That directness is the whole point of the rewrite here. The Capacitor app reached
CarPlay through five workarounds — a scene delegate, a `CarPlayBridgePlugin` marshalling
commands into JS, `public/js/record/remote.js`, a `PhoneSceneDelegate` that existed
*only* because declaring a CarPlay scene moved the app onto the scene lifecycle and
broke URL handling, and a rule that every in-app browser must be a popover. A
SwiftUI app is scene-based from birth, so none of them have a counterpart. NS-27
deletes them.

Three pieces:

- **`AppServices`** — the app's long-lived objects as shared references. A
  `CPTemplateApplicationScene` is built by UIKit, outside the SwiftUI view tree, so it
  has no `@Environment` to read; this is how the car screen drives *the same*
  recorder the phone does rather than a copy kept in step. `TrackEvolutionApp` seeds
  its `@State` from here.
- **`RemoteRecorder`** — start/stop for a caller with no screen. The event list fetch
  is **best effort only**: signed out, offline, or no event today must all still
  record, because the GPS trace is the irreplaceable part and an unattached recording
  is adopted later by the first event whose record screen it's opened from. The only
  refusal is `gps`, which reads as "No GPS signal" on the head unit rather than a
  silent no-op.
- **`CarPlaySceneDelegate`** — one `CPInformationTemplate`, one Start/Stop button.
  Deliberately that small: this is a driving-task app and Apple's review bar for
  driver distraction is unforgiving. It re-renders on a 1-second timer rather than via
  `withObservationTracking`, because the elapsed readout needs a tick anyway — so
  polling gives state mirroring (start on the phone, the head unit shows Stop) for
  free instead of two mechanisms each doing half the job.

**The event-attachment rule is the only real judgment in it**, and it lives in the Kit
as `RemoteRecording` — ported from `remote.js`, keeping its names. It attaches to an
event whose day range covers today and **never guesses further**, because the costs are
asymmetric: an unattached recording is offered on the dashboard and adopted at review
time, while a misattached one silently corrupts a logbook entry. Overlaps tie-break to
the most recently started event. Day arithmetic is date-only in UTC so a DST transition
can't skip or repeat a calendar day.

It is pinned twice: unit tests ported from `test/unit/record-remote.test.js` (with the
DST cases), and `contracts/logic/remote-attach.json` — 22 cases of the **web**
implementation's actual output, so a change to `remote.js` fails the Swift suite rather
than letting the phone and the head unit disagree about which event a drive belongs to.

One deliberate divergence: `remote.js` sets `location.hash` on start, to land the phone
UI where the recording is reachable. Natively that's unnecessary — `RecordingBanner` is
a `safeAreaInset` on every screen — and moving someone's screen while they drive is
worse than not doing it.

**Fractional days truncate.** A 1.5-day event covers only its start date, because the
JS passes `days - 1` to `Date.UTC`, which floors it. That is mirrored rather than
improved on, since the two clients must agree; fixing it means changing `remote.js`
first. See `fractionalDaysTruncateJustAsTheyDoOnTheWeb`.

### Testing it in the Simulator

```sh
# the CarPlay display; the app must be signed with the granted entitlement
xcrun simctl io <device> enumerate | grep -A3 CarPlay     # confirm the screen exists
xcrun simctl io <device> screenshot --display CarPlay shot.png
```

Enable the display with Simulator → **I/O → External Displays → CarPlay**, then tap the
app icon on the CarPlay home screen — the template only appears once the app is opened
*there*, so a screenshot before that shows the CarPlay springboard, not a bug. Use
**Features → Location → Freeway Drive** (or `xcrun simctl location … start`) for fixes
fast enough to arm the recorder.

## A chart may not eat the page's scroll

`ProgressChart` reads out a point on **tap**, not on drag, and that is not a style
choice.

Every chart in the app sits inside a vertical scroller — the track page's `ScrollView`,
the event page's `List`. A `DragGesture` on the plot takes the touch that would have
started a scroll, so the page refuses to move whenever a finger lands on the chart. On
the event page the chart is a band across the middle of the screen, so the whole page
reads as frozen. Nothing fails: every button works, every other test passes.

`simultaneousGesture` with a dominant-axis guard, and
`LongPressGesture.sequenced(before:)`, were both tried and neither handed the touch back
to the scroller; removing the gesture entirely restored scrolling instantly, which is
what identified it. A tap doesn't compete with a scroll at all.

The cost is scrubbing along the line, which was nice and is not worth a page you can't
scroll. `GestureUITests` pins both halves — that the page scrolls when the swipe starts
on the chart, and that the edge-swipe back gesture still works over the chart and over
the lap list.

## The offline queue outlives the process

`OfflineStore.status.pending` is in-memory, and everything that moves the queue is
gated on it: `flushQueue` returns early at zero, the sync banner says nothing, and a
fresh queueable write is sent **directly** instead of queueing behind what's already
waiting. So the count is read back from the database in `init` — the queue survives a
relaunch and the count has to survive with it.

Without that read the failure is silent and total: writes made in the paddock sit in
SQLite forever, the app stops mentioning them, and they reach the server — if ever —
out of order. It is pinned by `aQueueSurvivesTheProcessThatMadeIt`, which reopens a
store on the same file, and end to end by `OfflineWritesUITests`.

Driving it from the simulator without tapping:

```sh
xcrun simctl privacy <device> grant location-always app.trackevolution
xcrun simctl location <device> start --speed=25 --interval=0.5 <lat,lon> <lat,lon> …
xcrun simctl launch <device> app.trackevolution -recorder -autoRecord
# the journal, readable from the host:
open "$(xcrun simctl get_app_container <device> app.trackevolution data)/Library/Application Support/Recorder"
```

Or the whole thing end to end — record, pick a line, save — as a UI test
(`RecordAndSaveUITests`, ~100 s because the recording has to exceed a minute of
driving before `toParsed` will time it):

```sh
npm run dev
xcrun simctl location <device> start --speed=25 --interval=0.5 <a closed loop…>
xcodebuild test -project apps/ios/TrackEvolution.xcodeproj -scheme TrackEvolution \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:TrackEvolutionUITests/RecordAndSaveUITests
```

It attaches a screenshot of the review screen on success, not just on failure: the
trace and gate are drawn in a `Canvas`, so a broken render wouldn't fail any
assertion. Export it with
`xcrun xcresulttool export attachments --path <result>.xcresult --output-path <dir>`.

The `-resetAuth` and `-resetRecording` launch arguments (DEBUG only) exist for
these tests: the Keychain token and an unsaved recording both survive a reinstall
by design, which would otherwise make a recording test pass by starting in the
state it was meant to reach. `-pendingRecording` is the inverse — it seeds a
stopped, unsaved recording so the dashboard's banner (and its Discard button) can
be tested without driving one, and it is checked before `-resetRecording` so it
wins when the shared sign-in helper passes both.

Still outstanding from NS-15: the Live Activity / Dynamic Island (the spec
sequences it after the core recorder), the 60-minute screen-locked device run, and
the 90-minute battery measurement — none of which the simulator can answer.

## Ported logic keeps its JS name — and its JS output

Anything ported from `public/js/` keeps the original's function and constant
names, so the two can be diffed by eye, and it brings that file's test cases with
it. So far: `Geo` ↔ `public/js/import/geo.js`, `Recording`/`RecorderCore` ↔
`public/js/record/core.js` (`SCREAMING_SNAKE` constants included — unusual for
Swift, deliberate here), `LapStats` ↔ `public/js/lap-stats.js`, `EventDates` ↔
the date helpers in `public/app.js` plus `fmtDate` from `public/js/format.js`, and
the whole of `Telemetry/` ↔ the video parsers (`public/pdr.js`,
`js/import/gpmf.js`, `channels.js`, `pdr-laps.js`).

`LapStats.cleanLaps` and `OfflineMirrors.cleanLaps` are different functions with the
same name, from different JS files (`lap-stats.js`'s 107% filter, and `offline.js`'s
mirror of `sanitizeLaps`). Both keep their original's name, which is why they live in
separate namespaces.

`EventDates` keeps the JS's **two different clocks**, and the split is load-bearing:
`todayISO` is UTC because `toISOString()` is, while a date the user picked is
formatted in *their* calendar because `<input type="date">` submits it that way. At
10pm in New York those disagree by a day, which is one evening's events landing on
the wrong date.

Agreement is enforced, not assumed. `npm run contracts:logic` runs the **web**
implementation and commits what it produced, and the Swift tests assert this port
reproduces it:

- `contracts/logic/geo-laps.json` — lap times identical to the millisecond,
  geometry to within 1e-9. Breaking the crossing-time interpolation fails it.
- `contracts/logic/recorder.json` — the literal
  `localStorage["recording.pending"]` string a web recording checkpoints to.
  Swift deserializes it and must agree on the trim window, both auto-stop
  decisions, the parsed duration, and the laps a line pick yields.
- `contracts/logic/video-parsers.json` plus the **binary** MP4s in
  `contracts/logic/video/` — the only fixture here whose input isn't JSON, because
  the question is what a decoder makes of a byte stream. Swift parses the same
  bytes and must reproduce lap times to the millisecond with their `estimated`
  flags, coordinates to 1e-9, the session metrics, and every per-lap channel array
  element for element.

`JSMath` exists for the same reason: the JS rounds with `Math.round(v * f) / f`,
which is half-up **toward +infinity**, while Swift's `rounded()` is
half-away-from-zero. That rounding is part of the checkpoint format, and
latitude, longitude and speed all cross zero. `apps/android/core`'s `JsMath` is
its twin — keep the two in step.

## Video import reads the file where it sits

`App/Import/` and the Kit's `Telemetry/` are NS-30: pick a PDR or GoPro clip and
get lap times out of it, on the device the footage is already on.

**The video is never copied and never uploaded.** Both parsers read the MP4 index
plus the telemetry track's own samples — a few MB for PDR, tens for a long GoPro
`gpmd` track — against an essence one to two orders of magnitude larger they never
touch. A temp copy of a 4 GB clip takes minutes and may not fit in the sandbox at
all, so anything that materialises the file first is the wrong design here. That
rules out the obvious SwiftUI reach: `PhotosPicker`'s `loadTransferable`
materialises a full temp copy before handing anything back. The two no-copy paths
are

- `.fileImporter` → security-scoped `URL` → `FileHandle` (the primary path, no
  permission needed), and
- `PHPickerConfiguration(photoLibrary: .shared())` → `assetIdentifier` → `PHAsset`
  → `requestAVAsset` → `AVURLAsset.url`, which needs a photo-library read
  authorization and an `NSPhotoLibraryUsageDescription`. That prompt is the price
  of not copying, and it is worth paying.

`requestAVAsset` runs with `isNetworkAccessAllowed = false` on purpose: an
iCloud-only clip would otherwise download in full behind a spinner, which is the
one thing to avoid on track-day cellular. It and the not-`AVURLAsset` case (edited
and slow-motion clips are an `AVComposition`, and carry no telemetry track anyway)
each get a stated outcome rather than a hang.

Everything downstream is shared with the recorder. `ReviewScreen` takes a
`ParsedTelemetry` — the shape every parser and `ParsedRecording` produce — so the
line picker, the lap list and the save are one code path. A side effect worth
knowing: because `TelemetryChannels.buildLapChannels` now exists natively, a
*recorded* session stores per-lap channel data too, which it couldn't before.

Two testing notes. The parsers take a `TelemetryByteSource` and import no UIKit,
SwiftUI, Photos or AVFoundation, so `swift test` exercises them on macOS against
bytes in memory. And `UITests/VideoImportUITests` reaches the import through the
debug-only `-importFixture <clip>` launch argument rather than the system pickers,
which are separate processes whose automation would make the suite flaky about
something other than this feature — everything after the pick is the production
path.

## One value, two screens: the prep checklist template

The list a new event's checklist starts from is editable in Settings and used on
the event page, and those are different screens. `AuthController` owns it —
`checklistTemplate`, `hasCustomChecklistTemplate`, `setChecklistTemplate` — so
both read one value; a Settings editor holding its own copy would look right on
its own screen while the event page kept offering the built-in default.

`EventDates.DEFAULT_CHECKLIST` is the fallback for a user who has never edited it,
and it is a port of `public/js/checklist.js` pinned to it by
`contracts/logic/checklist.json`. It is only a list of strings, but it is *product
copy carried in two clients*: the phone quietly offering a different default from
the laptop is the kind of drift nobody files a bug about.

Editing the template never rewrites a checklist already on an event. Those are a
copy taken when the list was started, and rewriting one would untick items the
driver had already dealt with — `ChecklistTemplateUITests` asserts exactly that.

## The project file is generated *and* committed

`TrackEvolution.xcodeproj` is produced from `project.yml` by
[XcodeGen](https://github.com/yonaskolb/XcodeGen), and the result is committed so
a clean checkout — and CI — builds with nothing but Xcode installed.

Consequence: **don't change project settings in Xcode's inspector.** Edit
`project.yml` (or `Schemes/*.xcscheme`) and re-run:

```sh
brew install xcodegen   # once
apps/ios/generate.sh
```

**A new Swift file under `App/` needs a regenerate too.** XcodeGen resolves the
file list when it runs, so until `generate.sh` picks a new file up it's invisible
to the app target — the symptom is `cannot find 'X' in scope` for a type that
plainly exists. Files under `Packages/` are the exception: SwiftPM globs its own
sources at build time, so the Kit needs nothing. Adding a target, build setting or
capability always means editing `project.yml` and regenerating.

## Load-bearing details

- **Bundle identifier `app.trackevolution`** — identical to the Capacitor app,
  deliberately: the native build ships as an in-place App Store update that keeps
  ratings, the install base, and the Universal Links association served by
  `src/routes/wellKnown.ts`. Do not change it.
- **Deployment target iOS 17.0**, **Swift 6 language mode with complete
  concurrency checking**. The recorder is concurrent by nature; this is enforced
  from the scaffold up rather than retrofitted.
- **The CarPlay entitlement is present and load-bearing.**
  Apple has granted `com.apple.developer.carplay-driving-task`, so NS-19 checks it
  into `App/TrackEvolution.entitlements`. Removing it doesn't break the build — the
  scene just never attaches and CarPlay silently disappears, which no test catches
  because the phone app is unaffected. CI asserts the key is present, and lints the
  entitlements files, for that reason.
  If a device build fails complaining about this key, the provisioning profile
  predates the grant: Xcode → Settings → Accounts → Download Manual Profiles.
- **`Info.plist` location strings are App Review-approved copy** carried over
  verbatim from `mobile/ios/App/App/Info.plist`. Reword them only with a reason.
- The old Capacitor project stays in `mobile/` until NS-27. Read it for plist
  strings and asset sources, but not for structure: its `ViewController.swift`,
  `PhoneSceneDelegate.swift` and `CarPlayBridgePlugin.swift` exist purely to work
  around Capacitor's scene handling and have no counterpart here. A
  SwiftUI-lifecycle app is scene-based from birth.
