# NS-15 — Background location + durable fix store (iOS)

**Phase:** 1 · **Platform:** iOS · **Depends on:** NS-11 · **Estimate:** 5–7 days

## Goal

Feed `RecorderCore` from CoreLocation with the screen off and the app
backgrounded, and persist every fix durably as it arrives. **This is the single
most important spec in the programme** — it is the reason for the rewrite.

## What we are replacing

Today the recorder runs inside a Capacitor WebView via
`@capacitor-community/background-geolocation`, and pays for it:

- Fixes arrive on the JS thread and stop when the OS suspends the WebView.
- `public/js/record/ui.js` checkpoints roughly every 10 s **driven by fix
  arrival**, because `setInterval` throttles with the screen off. Worst case is
  ~10 s of lost track time.
- The whole `recording.pending` recovery path exists because the WebView dying
  mid-session is expected, not exceptional.

A native app holding a location background mode is far less likely to be
suspended, and can write to disk on every fix. The recovery path stays — that is
correct engineering — but it stops being a workaround for an unreliable host.

## Requirements

1. **`CLLocationManager` configured for track use:**
   - `allowsBackgroundLocationUpdates = true`
   - `pausesLocationUpdatesAutomatically = false` — **critical.** iOS will
     otherwise pause updates when it thinks you have stopped, which happens in
     pit lane and silently ends the recording.
   - `activityType = .automotiveNavigation`
   - `desiredAccuracy = kCLLocationAccuracyBestForNavigation`
   - `distanceFilter = kCLDistanceFilterNone`
   - `showsBackgroundLocationIndicator = true` — be honest with the user that
     GPS is live.
2. **Permissions.** Request *when in use* first, then escalate to *always* only
   when the user starts a recording, with an in-app explanation before the system
   prompt. Handle every outcome: denied, restricted, reduced accuracy
   (`.reducedAccuracy` — offer `requestTemporaryFullAccuracyAuthorization`), and
   "allow once". A recording started without adequate authorization must fail
   loudly and immediately, not silently produce an empty trace.
3. **Feed `RecorderCore.addFix`** with `{timeMs, lat, lon, speed, accuracy}` —
   the same shape `platform.bgLocation`'s `onFix` delivers today
   (`public/js/platform.js`).
   - Use `location.timestamp` (the fix's own time), **not** `Date.now()` at
     delivery. Batched deliveries would otherwise all collapse to one instant and
     be rejected by `addFix`'s monotonic-time check.
   - Pass CoreLocation's `speed` through when `>= 0`; it reports `-1` for
     invalid, which must become `nil`, not a bogus zero.
   - Pass `horizontalAccuracy` as `accuracy`; negative means invalid.
4. **Durable fix store — per fix, not per interval.** Append each accepted fix to
   SQLite (GRDB, shared with NS-21's store) inside the location callback. Worst-case
   loss on app death goes from ~10 s to zero.
   - Keep the `RECORDING_V` JSON checkpoint format as the **interchange** format
     for resume and for handing to the review flow, but stop using it as the
     durability mechanism.
   - The in-progress recording must be recoverable on next launch, with the same
     "here is a recording you did not save" prompt the web app shows.
5. **Auto-stop.** Evaluate `shouldAutoStop` on each fix. Both triggers matter: the
   4-hour hard cap, and 15 minutes stationary **once the car has been driven above
   `DRIVEN_MPS`** — the grid-wait exemption.
6. **Lifecycle correctness:**
   - Survive backgrounding, screen lock, and a phone call.
   - Survive an incoming CarPlay connect/disconnect (NS-19).
   - Handle `CLError.denied` and location services being switched off mid-recording
     by stopping cleanly and preserving what was captured.
   - Under Swift 6 strict concurrency, the delegate callbacks cross into the
     recorder's actor — get the isolation right rather than sprinkling
     `@unchecked Sendable`.
7. **Live Activity / Dynamic Island** showing elapsed time and fix count, with a
   stop control. This is new capability the WebView could never offer; treat it as
   in scope but land it after the core recorder is proven.
8. **Battery.** `BestForNavigation` at full rate is expensive. Measure a 90-minute
   session and record the drain in the PR. If it is unacceptable, raise it — do
   **not** quietly lower the accuracy, because lap timing depends on fix density.

## Acceptance criteria

- [ ] Fixes keep arriving with the app backgrounded and the screen locked for a continuous 60+ minutes.
- [ ] Force-killing the app mid-recording loses **zero** fixes; the recording is offered for recovery on next launch.
- [ ] `pausesLocationUpdatesAutomatically` is `false` and a 10-minute stationary period mid-recording does not end it.
- [ ] Invalid CoreLocation speed (`-1`) becomes `nil`, not `0`.
- [ ] Fix timestamps come from the fix, and a batched delivery is not rejected as non-monotonic.
- [ ] Denied / reduced-accuracy / allow-once are each handled with a clear message.
- [ ] Grid-wait: 20 min stationary before moving does not auto-stop. Forgot-to-stop: 15 min stationary after driving does.
- [ ] Battery drain over a 90-minute session is measured and reported.
- [ ] `git diff --stat public/ src/` is empty.

## Verification

Simulator gets you correctness, not confidence. Both are required.

```
Simulator: Features → Location → Freeway Drive, app backgrounded.
Device:    a real session, or a drive of at least 30 minutes with the phone
           locked and in a pocket.
```

- Compare a native recording against a simultaneous web-app recording on a second
  phone at the same track: lap times should agree within ~0.3 s.
- Use Instruments' Location and Energy templates for the battery figure.

## Notes

- Do **not** use significant-location-change or region monitoring. They are
  power-efficient and completely unsuitable — lap timing needs 10 Hz-ish fixes.
- The raw trace **never leaves the device** unless the user saves the session.
  That is an existing privacy property of the feature and must be preserved;
  no telemetry, no crash-reporter attachment of traces.
- `public/js/record/ui.js` is the behavioral reference for the lifecycle
  (checkpoint cadence, recovery prompt, stop-then-save-or-discard). Read it, then
  build the native version properly rather than transliterating its workarounds.
