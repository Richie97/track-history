# NS-01 — Monorepo layout + iOS project scaffold

**Phase:** 0 · **Platform:** iOS · **Depends on:** — · **Estimate:** 2–3 days

## Goal

Create the `apps/ios/` Xcode project that every other iOS spec builds inside, and
establish the monorepo layout the three clients share. Nothing user-facing —
this is the empty room the furniture goes into.

## Why a monorepo

The API contract, design tokens, and recorder constants must move in lockstep
across web, iOS, and Android. Separate repos guarantee drift. CI is path-filtered
(NS-10) so web/backend PRs don't pay for native builds.

## Target layout

```
/                      Worker + web app — UNCHANGED
  src/  public/  migrations/  seed/  site/  test/
  apps/ios/            NEW — this spec
  apps/android/        NEW — NS-02
  contracts/golden/    NEW — NS-03
  docs/specs/native/   these specs
  mobile/              untouched until NS-27
```

## Scope

**In scope:** Xcode project, module structure, minimum deployment target, bundle
identifier, entitlements/Info.plist baseline, a launching "hello" app, `.gitignore`
additions, local build instructions.

**Out of scope:** any UI, networking, auth, or recorder code. Design tokens are
NS-06. CI is NS-10.

## Requirements

1. **Xcode project at `apps/ios/TrackEvolution.xcodeproj`** (or a
   `Package.swift`-driven workspace — your call, but a plain `.xcodeproj` with
   local SPM package dependencies is the low-friction default). SwiftUI lifecycle,
   `@main App` struct — **not** a UIKit `AppDelegate` app.
2. **Bundle identifier `app.trackevolution`** — identical to the Capacitor app
   (`mobile/capacitor.config.json`, `mobile/ios/App/App.xcodeproj/project.pbxproj`).
   This is load-bearing: it makes the native build an in-place App Store update
   that keeps ratings, install base, and the existing Universal Links association
   served by `src/routes/wellKnown.ts`. Do not change it.
3. **Deployment target: iOS 17.0.** Buys `CLLocationUpdate.liveUpdates()`,
   modern Swift Charts, and Observation. Do not go lower without raising it as a
   blocker.
4. **Swift 6 language mode**, strict concurrency enabled. The recorder is
   inherently concurrent (background location callbacks + UI); getting this right
   at scaffold time is far cheaper than retrofitting.
5. **Module structure** — separate targets so pure logic stays testable without a
   simulator:
   - `TrackEvolutionKit` (framework/SPM target) — models, API client, recorder
     core, lap geometry, offline store. **No UIKit/SwiftUI imports.**
   - `TrackEvolution` (app target) — SwiftUI views, scenes, platform services.
   - `TrackEvolutionKitTests` — unit tests against the Kit, no simulator UI.
6. **Info.plist baseline** carried over from `mobile/ios/App/App/Info.plist`:
   - `NSLocationWhenInUseUsageDescription` and
     `NSLocationAlwaysAndWhenInUseUsageDescription` (reuse the existing strings —
     they are already App Review-approved copy).
   - `UIBackgroundModes: [location]`.
   - `CFBundleURLTypes` registering the `trackevolution` scheme (used by the auth
     callback, NS-08).
   - Associated Domains entitlement for `applinks:trackevolution.app` (Universal
     Links for `/share/*`).
7. ~~**Do not add the CarPlay entitlement.**~~ *(Superseded: Apple granted
   `com.apple.developer.carplay-driving-task`, and NS-19 checked it in. It was
   correctly kept out at scaffold time, when signing would have failed without the
   grant.)*
8. **`.gitignore`** — add `apps/ios/build/`, `apps/ios/DerivedData/`,
   `*.xcuserdatad`, and SPM `.build/`. Do not ignore `Package.resolved`.
9. **App icon and launch screen** from `mobile/resources/` (1024px source already
   exists). Splash background `#0a0a0b`, matching the current app.

## Acceptance criteria

- [ ] `xcodebuild -project apps/ios/TrackEvolution.xcodeproj -scheme TrackEvolution -destination 'generic/platform=iOS Simulator' build` succeeds from a clean checkout.
- [ ] `xcodebuild test -scheme TrackEvolutionKit` runs (zero tests is fine) and passes.
- [ ] App launches in the simulator to a placeholder view, correct icon, dark launch background.
- [ ] Bundle identifier is exactly `app.trackevolution`.
- [ ] `TrackEvolutionKit` has no UIKit/SwiftUI import anywhere.
- [ ] `npm test` and `npm run typecheck` still pass; `git diff --stat src/ public/` is empty.

## Verification

```sh
xcodebuild -project apps/ios/TrackEvolution.xcodeproj -scheme TrackEvolution \
  -destination 'platform=iOS Simulator,name=iPhone 15' build test
npm test && npm run typecheck
git diff --stat origin/main -- src/ public/   # must be empty
```

## Notes

- The existing `mobile/ios/` project is a Capacitor app. Read it for the Info.plist
  strings, entitlements, and asset sources — but **do not** copy its structure.
  Its `ViewController.swift`, `PhoneSceneDelegate.swift`, and
  `CarPlayBridgePlugin.swift` exist purely to work around Capacitor's scene
  handling and have no counterpart here.
- A SwiftUI-lifecycle app is scene-based from birth, which is exactly why the
  CarPlay scene (NS-19) will cost nothing to add later.
