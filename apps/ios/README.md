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
