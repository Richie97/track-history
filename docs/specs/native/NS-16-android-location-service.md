# NS-16 — Foreground location service + durable fix store (Android)

**Phase:** 1 · **Platform:** Android · **Depends on:** NS-12 · **Estimate:** 5–7 days

## Goal

Feed `RecorderCore` from a foreground service with the screen off, persist every
fix as it arrives, and **fix two defects the Capacitor app currently ships**.

**Read `NS-15-ios-location-service.md`** for the shared rationale, the durability
argument, and the acceptance bar. This spec covers the Android specifics.

## The two defects this closes

1. **The 5-minute halt.** `mobile/capacitor.config.json` sets
   `android.useLegacyBridge: true` because without it Android stops delivering
   background location after five minutes. That is a Capacitor WebView bridge
   problem. A proper foreground service has no such limit — and **`useLegacyBridge`
   must not appear anywhere in the native app.**
2. **The invisible notification.** `POST_NOTIFICATIONS` is merged into the
   Capacitor manifest but **never requested at runtime**, so on Android 13+ the
   recording notification is silently hidden. The user gets no indication a
   recording is running. This spec requests it properly.

## Requirements

1. **A foreground `Service`** with `foregroundServiceType="location"`, started via
   `startForegroundService` and promoted with `startForeground` **within 5 seconds**
   or the system kills it (`ForegroundServiceDidNotStartInTimeException`).
   - The service, not the Activity, owns the recording. The UI binds to observe.
   - Return `START_STICKY`? **No** — a restarted service with no recording state
     is worse than none. Handle restart explicitly by recovering the persisted
     recording, or return `START_NOT_STICKY` and rely on the recovery prompt.
2. **`FusedLocationProviderClient`** with a `LocationRequest` at
   `Priority.PRIORITY_HIGH_ACCURACY`, interval ~100–250 ms,
   `minUpdateIntervalMillis` matching, and **`setWaitForAccurateLocation(true)`**.
   - If fused delivery proves lossy at track speeds on some devices, falling back
     to `LocationManager.requestLocationUpdates` with the GPS provider is
     acceptable — measure before switching.
3. **Notification channel + notification.** Low importance, ongoing, not
   dismissible, showing elapsed time and lap/fix count, with a **Stop** action.
   Reuse the existing channel name string
   (`capacitor_background_geolocation_notification_channel_name` is the Capacitor
   one — define our own, but keep user-facing wording consistent).
4. **Runtime permissions, properly:**
   - `ACCESS_FINE_LOCATION` first, with rationale.
   - `ACCESS_BACKGROUND_LOCATION` as a **separate, later request** — Android
     requires the two-step "while using" → "allow all the time" escalation and
     rejects a combined request. Send the user to Settings when the system stops
     showing the dialog.
   - **`POST_NOTIFICATIONS` on API 33+**, requested before the first recording.
     Without it the foreground notification is invisible — the defect above.
   - Handle "approximate location only" (the user toggled precise off): refuse to
     record and explain why, rather than producing a useless trace.
5. **Battery optimization.** Detect when the app is battery-optimized and offer
   `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. On aggressive OEM skins
   (Xiaomi, Huawei, OnePlus, Samsung) foreground services still get killed —
   detect the vendor and surface a targeted "allow background activity" hint.
   Assume nothing about OEM behavior; test on at least one non-Pixel device.
6. **Feed `RecorderCore.addFix`** with `{timeMs, lat, lon, speed, accuracy}`:
   - `timeMs` from `location.time` (the fix's own time), not wall clock at delivery.
   - `speed` only when `location.hasSpeed()`, else `null`.
   - `accuracy` from `location.accuracy` when `hasAccuracy()`, else `null`.
7. **Durable fix store — per fix.** Append each accepted fix to Room (shared with
   NS-22's store) inside the callback. Keep the `RECORDING_V` JSON format as the
   interchange format for resume and for the review flow, not as the durability
   mechanism. Recover an unsaved recording on next launch with a prompt.
8. **Auto-stop** evaluated per fix — the 4-hour cap and the 15-minute
   stationary-once-driven rule, including the grid-wait exemption.
9. **Lifecycle:** survive screen lock, app swipe-away from recents, a phone call,
   and an Android Auto connect/disconnect (NS-20). Stop cleanly if location is
   switched off mid-recording, preserving what was captured.

## Acceptance criteria

- [ ] Fixes keep arriving for a continuous **60+ minutes** with the screen off — explicitly verified **past the 5-minute mark** that `useLegacyBridge` exists to work around today.
- [ ] `useLegacyBridge` appears nowhere in the repo's native Android code.
- [ ] The recording notification is **visible on an Android 13+ device**, because the permission was requested.
- [ ] Swiping the app from recents does not stop the recording.
- [ ] Force-stop mid-recording loses **zero** fixes; recovery is offered on next launch.
- [ ] Fine-location, background-location, and notification permissions each requested at the right time with rationale; approximate-only is refused with an explanation.
- [ ] Invalid speed/accuracy become `null`, not `0`.
- [ ] Grid-wait does not auto-stop; forgot-to-stop does.
- [ ] Verified on a Pixel **and** at least one OEM-skinned device.
- [ ] Battery drain over a 90-minute session measured and reported.
- [ ] `git diff --stat public/ src/` is empty.

## Verification

```sh
adb shell dumpsys location            # confirm the request is registered
adb shell am kill app.trackevolution  # recovery path
adb shell cmd notification list       # notification actually posted
```

- Emulator: extended controls → GPX/KML playback of a real track lap.
- Device: a real session, or 30+ minutes driving with the screen off.
- Compare against a simultaneous web-app recording — lap times within ~0.3 s.

## Notes

- Do **not** use geofencing or passive location. Lap timing needs dense fixes.
- The raw trace **never leaves the device** unless the user saves the session.
  No telemetry, no crash-reporter attachment.
- `public/js/record/ui.js` is the behavioral reference for the lifecycle. Read it,
  then build the native version properly — do not transliterate its workarounds.
