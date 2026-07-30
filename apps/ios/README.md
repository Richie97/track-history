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
    Info.plist                 hand-maintained (GENERATE_INFOPLIST_FILE is off)
    TrackEvolution.entitlements
    Assets.xcassets/
  Packages/TrackEvolutionKit/  local SPM package — all pure logic
    Sources/TrackEvolutionKit/
      Models/                  Codable models + LapTime formatting
      API/                     APIClient, APIError, request bodies
      Recorder/                lap geometry, recorder core
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

Updates use `Patch<Value>` rather than plain optionals, because the server only
writes columns whose keys are *present* in the body: `.unchanged` omits the key,
`.set(nil)` sends an explicit null and clears the column.

## Ported logic keeps its JS name — and its JS output

Anything ported from `public/js/` keeps the original's function and constant
names, so the two can be diffed by eye, and it brings that file's test cases with
it. So far: `Geo` ↔ `public/js/import/geo.js`, and `Recording`/`RecorderCore` ↔
`public/js/record/core.js` (`SCREAMING_SNAKE` constants included — unusual for
Swift, deliberate here).

Agreement is enforced, not assumed. `npm run contracts:logic` runs the **web**
implementation and commits what it produced, and the Swift tests assert this port
reproduces it:

- `contracts/logic/geo-laps.json` — lap times identical to the millisecond,
  geometry to within 1e-9. Breaking the crossing-time interpolation fails it.
- `contracts/logic/recorder.json` — the literal
  `localStorage["recording.pending"]` string a web recording checkpoints to.
  Swift deserializes it and must agree on the trim window, both auto-stop
  decisions, the parsed duration, and the laps a line pick yields.

`JSMath` exists for the same reason: the JS rounds with `Math.round(v * f) / f`,
which is half-up **toward +infinity**, while Swift's `rounded()` is
half-away-from-zero. That rounding is part of the checkpoint format, and
latitude, longitude and speed all cross zero. `apps/android/core`'s `JsMath` is
its twin — keep the two in step.

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

Adding a Swift file under `App/` or `Sources/` needs no regeneration — sources
are picked up by directory. Adding a *directory*, target, build setting, or
capability does.

## Load-bearing details

- **Bundle identifier `app.trackevolution`** — identical to the Capacitor app,
  deliberately: the native build ships as an in-place App Store update that keeps
  ratings, the install base, and the Universal Links association served by
  `src/routes/wellKnown.ts`. Do not change it.
- **Deployment target iOS 17.0**, **Swift 6 language mode with complete
  concurrency checking**. The recorder is concurrent by nature; this is enforced
  from the scaffold up rather than retrofitted.
- **The CarPlay entitlement is deliberately absent.**
  `com.apple.developer.carplay-driving-task` is Apple-granted and signing fails
  without the grant, so everything compiles and ships inert without it — NS-19
  adds it. Same policy as the Capacitor app (see the root README).
- **`Info.plist` location strings are App Review-approved copy** carried over
  verbatim from `mobile/ios/App/App/Info.plist`. Reword them only with a reason.
- The old Capacitor project stays in `mobile/` until NS-27. Read it for plist
  strings and asset sources, but not for structure: its `ViewController.swift`,
  `PhoneSceneDelegate.swift` and `CarPlayBridgePlugin.swift` exist purely to work
  around Capacitor's scene handling and have no counterpart here. A
  SwiftUI-lifecycle app is scene-based from birth.
