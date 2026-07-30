# NS-27 — Store rollout + Capacitor retirement

**Phase:** 3 · **Platform:** Shared · **Depends on:** NS-25, NS-26 · **Estimate:** 2–3 weeks

## Goal

Ship both native apps as **in-place updates** to the existing store listings, then
delete `mobile/`.

## Why in-place

`app.trackevolution` is the bundle id / applicationId on both platforms today.
Keeping it preserves ratings, review history, install base, and — the operational
one — the existing deep-link associations:

- iOS Universal Links via `/.well-known/apple-app-site-association`, served by
  `src/routes/wellKnown.ts`
- Android App Links via `public/.well-known/assetlinks.json`

A new bundle id means new listings, lost reviews, and re-doing both associations.
Do not change it.

## Requirements

1. **Signing continuity.**
   - Android **must** be signed with the existing upload key, or Play rejects the
     update. Confirm before the first release build. If the key is unavailable,
     stop and raise it — Play App Signing key reset is a support process with a
     lead time, not a workaround.
   - Verify the SHA-256 fingerprint in `public/.well-known/assetlinks.json`
     matches the signing key. If it does not, App Links silently stop verifying.
   - iOS needs the same team and bundle id; the Associated Domains entitlement
     must be on the new provisioning profile.
2. **Data migration is nearly free — but not entirely.** Everything durable lives
   server-side. The only device-local state is:
   - the recorder checkpoint (`recording.pending` in Capacitor Preferences)
   - the offline write queue (IndexedDB)

   **Ship one final Capacitor release** that flushes the offline queue on launch
   and warns if a pending recording exists, so nothing is stranded. Then the native
   app can start clean.
   - Edge case: a user updating mid-recording loses it. The window is small (max 4
     hours) but real — the final Capacitor release should say so plainly.
3. **Staged rollout.** TestFlight / Play internal → closed beta → 10% → 50% → 100%.
   **Do not go past 10% until the recorder has survived at least one real track
   day** on each platform. This is the whole reason for the rewrite; a regression
   here is worse than shipping late.
4. **Keep the Capacitor build as the rollback path** until 100% is stable. Do not
   delete `mobile/` until then.
5. **CarPlay entitlement.** If Apple has granted
   `com.apple.developer.carplay-driving-task` by now, enable it per README lines
   194–213 and add CarPlay to the release notes. If not, ship without it — the app
   works inert (NS-19).
6. **Android Auto** needs its own Play review against the declared category
   (NS-20). Budget for a rejection round.
7. **Then, and only then, retire `mobile/`:**
   - Delete `mobile/` entirely, including `CarPlayBridgePlugin.swift`,
     `PhoneSceneDelegate.swift`, `ViewController.swift`, and
     `scripts/sync-www.mjs`.
   - Delete `test/unit/mobile-sync.test.js`, which pins the sync transform.
   - Delete `src/lib/cors.ts` and its registration — it exists **only** for
     Capacitor WebView origins, and native HTTP clients do not send `Origin`.
     **This is the one permitted `src/` change in the entire programme**, and it
     is a deletion of now-dead code. Verify no test depends on it, and confirm the
     web app is unaffected (it is same-origin).
   - Remove the `<!-- native:strip-start/end -->` markers from
     `public/index.html` if nothing else consumes them, and drop the
     mobile-related npm scripts.
   - Retire the Xcode Cloud config at `mobile/ios/App/ci_scripts/ci_post_clone.sh`.
8. **The web app keeps its PWA install path.** Users who prefer the browser lose
   nothing, and it remains the only place telemetry file import exists.

## Acceptance criteria

- [ ] Both apps ship as in-place updates under `app.trackevolution`, ratings and install base intact.
- [ ] Universal Links and App Links verify against the shipped signing keys — proven with `adb shell pm get-app-links` and a real iOS device.
- [ ] The final Capacitor release flushes the offline queue and warns about pending recordings.
- [ ] A user upgrading from Capacitor lands on the same account with all data present.
- [ ] Recorder validated at a real track day on both platforms before exceeding 10%.
- [ ] `mobile/` deleted only after 100% rollout is stable.
- [ ] After deletion, `npm test` and `npm run typecheck` pass, and the web app is unaffected.
- [ ] `git diff src/` contains **only** the `cors.ts` deletion.

## Verification

```sh
adb shell pm get-app-links app.trackevolution     # must report verified
npm test && npm run typecheck                      # after mobile/ deletion
```

Install the current Capacitor build from the store, create data, update in place
to the native build, and confirm same account, same data, working deep links.

## Notes

- Rolling back a staged Play release is possible; rolling back an App Store
  release is not — you can only expedite a fix. Weight the iOS gate accordingly.
- Do not delete `mobile/` in the same PR as the rollout. Separate PRs, separate
  risk.
