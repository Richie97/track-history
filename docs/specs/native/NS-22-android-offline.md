# NS-22 — Offline cache + write queue (Android)

**Phase:** 2 · **Platform:** Android · **Depends on:** NS-05 · **Estimate:** 7–10 days

## Goal

Port `public/js/offline.js` to Kotlin: a durable cache of GET `/api` responses
plus a persistent queue of offline writes, replayed in order on reconnect.

**Read `NS-21-ios-offline.md` in full.** It carries the queueable whitelist, the
temp-id rules, the transitive delete-cancellation walk, the replay and conflict
policy, and the warning about mirrored backend logic. None of that is repeated
here — **the two clients must behave identically**, and both must match the web
app.

## Android-specific requirements

1. **Room**, with cache and queue in **one database** so a queued write and its
   optimistic cache patch commit in a single transaction.
2. **Where the logic lives.** The queue/cache *logic* belongs in `:core` (pure
   Kotlin, JVM-testable) with Room as a swappable persistence interface — mirroring
   how `offline.js` uses an in-memory backend under Node so it stays unit-testable.
   Do not bury the replay algorithm in a DAO.
3. **`WorkManager` for replay.** Enqueue a unique `CoroutineWorker` with a
   `NetworkType.CONNECTED` constraint so replay survives process death and fires on
   reconnect without the app being open. Use `ExistingWorkPolicy.APPEND_OR_REPLACE`
   carefully — **ordering is part of the contract** and concurrent workers must not
   interleave writes.
4. **Connectivity** via `ConnectivityManager.NetworkCallback`, not polling. Treat
   "has a network" as a hint only — actual replay success is the signal, since
   captive portals and dead paddock Wi-Fi both report connected.
5. **Process death is routine.** The queue is the source of truth; nothing may live
   only in a ViewModel.
6. **Sign-out clears cache and queue.**

## Acceptance criteria

- [ ] Every `test/unit/offline.test.js` case has a passing Kotlin equivalent.
- [ ] Airplane mode: create event → session → laps → reconnect → all replay in order with correct ids.
- [ ] Deleting an unsynced event cancels its queued create and all descendants.
- [ ] A server-rejected write is dropped once and surfaced in a banner.
- [ ] Optimistic patches keep dashboard, event, and track views consistent pre-sync.
- [ ] `recomputeDetail` matches the server for the NS-03 golden fixtures, including `consistency == null` below 3 laps.
- [ ] Replay resumes correctly after process death mid-queue.
- [ ] Two rapid connectivity flaps do not double-send a queued write.
- [ ] Prefetch re-fetches only rows whose `updated_at` changed.
- [ ] Sign-out leaves no cached rows and no queued writes.
- [ ] Queue survives app termination and device restart.
- [ ] `./gradlew :core:test` covers the replay logic without an emulator.
- [ ] `git diff --stat public/ src/` is empty.

## Verification

```sh
npx vitest run test/unit/offline.test.js
cd apps/android && ./gradlew :core:test
adb shell am kill app.trackevolution    # mid-replay process death
adb shell svc wifi disable && adb shell svc data disable
```

Perform the full offline create/edit/delete sequence on a device, restore
connectivity, and diff the resulting server state against the same sequence run
on the web app and on iOS.

## Notes

- The mirrored `withComputed` / `sanitizeLaps` logic is the highest-risk debt here.
  A divergence found during this port should be reported — the web app likely
  shares it.
- No sync engine, no CRDTs, no conflict UI. Last-write-wins is the chosen policy.
