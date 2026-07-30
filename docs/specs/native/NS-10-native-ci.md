# NS-10 — Native CI

**Phase:** 0 · **Platform:** Shared · **Depends on:** NS-01, NS-02 · **Estimate:** 2 days

## Goal

Build and test both native apps in CI, without making every web/backend PR pay
for a macOS runner.

## Current state

`.github/workflows/ci.yml` is a single job: Node 22, `npm ci`,
`npm run typecheck`, `npm test`. It runs on pushes to `main` and all PRs.
`.github/workflows/pages.yml` deploys `site/` on pushes touching `site/**`.

Xcode Cloud currently builds the Capacitor iOS app via
`mobile/ios/App/ci_scripts/ci_post_clone.sh`. That script is tied to the
Capacitor project and is retired with it (NS-27) — do not extend it.

## Requirements

1. **Keep `ci.yml` as-is for web/backend.** It is fast and must stay that way.
   Add path filters so it does not run for native-only changes, but be careful:
   `src/` and `contracts/` changes *must* still run it.
2. **New `.github/workflows/ios.yml`** — `macos-latest`, triggered on
   `apps/ios/**`, `contracts/**`, and the workflow file itself:
   - `xcodebuild test -scheme TrackEvolutionKit` (unit tests, no simulator UI)
   - `xcodebuild build -scheme TrackEvolution -destination 'generic/platform=iOS Simulator'`
   - Cache SPM dependencies.
   - **Must build without the CarPlay entitlement**, which Apple has not granted.
     If the build ever requires it, that is a regression — the app ships inert
     without it (NS-19).
3. **New `.github/workflows/android.yml`** — `ubuntu-latest`, triggered on
   `apps/android/**`, `contracts/**`, and the workflow file:
   - `./gradlew :core:test` (JVM, fast, no emulator)
   - `./gradlew :app:assembleDebug`
   - Cache Gradle.
   - **No emulator tests in the default PR run** — they are slow and flaky. If
     instrumentation tests appear later, gate them to a nightly or label-triggered
     job.
4. **Contract staleness.** NS-03 adds a regeneration check to `ci.yml`. Both native
   workflows must trigger on `contracts/**` so a golden change is proven against
   the decoders in the same PR.
5. **No signing secrets in PR builds.** Simulator/debug builds are unsigned.
   Release signing is NS-27's problem and must not be a prerequisite for CI green.
6. **Required checks.** Once stable, mark all three workflows required for merge
   to `main`. Until then, run them non-blocking so a half-finished scaffold does
   not wedge unrelated work.
7. **Concurrency groups** per workflow + ref, cancelling in-progress runs — macOS
   minutes are the expensive resource here.

## Acceptance criteria

- [ ] A PR touching only `public/` runs `ci.yml` and neither native workflow.
- [ ] A PR touching only `apps/ios/` runs `ios.yml` only.
- [ ] A PR touching `contracts/` runs all three.
- [ ] A PR touching `src/` runs `ci.yml` (and the contract check catches shape drift).
- [ ] iOS build succeeds with no CarPlay entitlement present.
- [ ] Android `:core:test` runs on the JVM in under a minute.
- [ ] No workflow requires a signing secret to pass.
- [ ] Superseded in-progress runs are cancelled.

## Verification

Open four throwaway PRs — one touching only `public/`, one only `apps/ios/`, one
only `apps/android/`, one touching `contracts/` — and confirm the triggered job
set matches the table above. Delete them afterwards.

## Notes

- Path filters are a footgun with required checks: a required check that never
  runs blocks the merge. Use `paths` on the trigger plus a skip-job that reports
  success, or make the natives non-required until Phase 2. Pick one deliberately
  and write down which.
- macOS runners are billed at a heavy multiplier. Concurrency cancellation and
  tight path filters are the cost control.
