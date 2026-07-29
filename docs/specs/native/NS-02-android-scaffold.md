# NS-02 — Android project scaffold

**Phase:** 0 · **Platform:** Android · **Depends on:** — · **Estimate:** 2–3 days

## Goal

Create the `apps/android/` Gradle project that every other Android spec builds
inside. Nothing user-facing.

Read `docs/specs/native/NS-01-ios-scaffold.md` for the shared monorepo layout —
it is the same tree, and only one of the two scaffold specs needs to create the
top-level `apps/` directory and `.gitignore` entries.

## Scope

**In scope:** Gradle project, module structure, min/target SDK, applicationId,
manifest baseline, permissions declared (not requested), a launching "hello" app.

**Out of scope:** any UI, networking, auth, or recorder code. Design tokens are
NS-07. CI is NS-10. Runtime permission *requests* belong to NS-16.

## Requirements

1. **Gradle project at `apps/android/`**, Kotlin DSL (`build.gradle.kts`), version
   catalog in `gradle/libs.versions.toml`. Jetpack Compose with the Compose
   Compiler Gradle plugin (Kotlin 2.x).
2. **`applicationId` and `namespace` = `app.trackevolution`** — identical to the
   Capacitor app (`mobile/android/app/build.gradle`). Load-bearing: it makes this
   an in-place Play Store update preserving ratings, install base, and the App
   Links association in `public/.well-known/assetlinks.json`.
   **The release build must be signed with the existing upload key** or the update
   will be rejected — flag this to the repo owner rather than generating a new key.
3. **`minSdk = 26`, `targetSdk` = current.** minSdk 26 keeps notification channels
   and modern location APIs available without compat gymnastics.
4. **Module structure** — pure logic separated so it tests on the JVM without an
   emulator:
   - `:core` — models, API client, recorder core, lap geometry, offline store.
     A **pure Kotlin/JVM module with no Android dependencies**, so its tests run
     as fast unit tests.
   - `:app` — Compose UI, services, platform integration.
   - Later specs may add `:auto` for Android Auto (NS-20).
5. **Manifest baseline** — declare, do not request:
   - `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`
   - `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`
   - `POST_NOTIFICATIONS`
   - `INTERNET`
   - An intent filter for the `trackevolution://auth` callback (NS-09).
   - An App Links intent filter for `https://trackevolution.app/share/*`,
     `android:autoVerify="true"`.
6. **Do not set anything resembling `useLegacyBridge`.** That flag exists in
   `mobile/capacitor.config.json` solely because Capacitor's WebView halts
   background location after 5 minutes. It has no native counterpart, and the
   5-minute halt is one of the defects this rewrite exists to remove.
7. **`.gitignore`** — `apps/android/build/`, `*/build/`, `.gradle/`, `local.properties`.
8. **App icon / splash** from `mobile/resources/`. Splash background `#0a0a0b`.
9. **Gradle wrapper committed** so CI needs no local Gradle install.

## Acceptance criteria

- [ ] `./gradlew :app:assembleDebug` succeeds from a clean checkout.
- [ ] `./gradlew :core:test` runs (zero tests is fine) and passes on the JVM — no emulator.
- [ ] App launches on an emulator to a placeholder screen with the correct icon.
- [ ] `applicationId` is exactly `app.trackevolution`.
- [ ] `:core` has no `android.*` import and no Android Gradle plugin applied.
- [ ] `npm test` and `npm run typecheck` still pass; `git diff --stat src/ public/` is empty.

## Verification

```sh
cd apps/android && ./gradlew :app:assembleDebug :core:test
cd ../.. && npm test && npm run typecheck
git diff --stat origin/main -- src/ public/   # must be empty
```

## Notes

- Read `mobile/android/` for the manifest permissions and asset sources. Note that
  today the background-geolocation permissions merge in from the Capacitor
  plugin's own manifest; here they are declared explicitly and visibly.
- **Known defect to carry forward as a fix, not a copy:** `POST_NOTIFICATIONS` is
  currently merged into the manifest but never requested at runtime, so on
  Android 13+ the recording notification is invisible. Declare it here; NS-16
  requests it properly.
