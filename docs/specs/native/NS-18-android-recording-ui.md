# NS-18 — Recording UI + review/save flow (Android)

**Phase:** 1 · **Platform:** Android · **Depends on:** NS-16, NS-14, NS-09 · **Estimate:** 5–7 days

## Goal

The Compose screens around the recorder: start/stop, live status, start/finish
line picker, lap review, and saving as a session.

**Read `NS-17-ios-recording-ui.md` in full.** It documents the app-global
recording rule, event-less recording and adoption, the line-picker interaction,
the save payload, and the offline requirement. None of that is repeated here —
the two apps must behave identically.

## Android-specific requirements

1. **The service owns the recording, the UI observes it.** From NS-16 the
   recording lives in a foreground `Service`. Compose screens bind and collect
   state; they must never be the source of truth. Configuration changes (rotation,
   dark-mode toggle, font-scale change) must not perturb a recording.
2. **Process death is routine on Android.** The UI must reconstruct entirely from
   the service + persisted state. Test with "Don't keep activities" enabled in
   developer options — that is the honest test of this requirement.
3. **The notification is the primary control surface** while driving. Its Stop
   action must work with the app process not in the foreground, and tapping the
   notification must deep-link to the live recording screen, not the dashboard.
4. **Back navigation** must not stop a recording. The system back gesture from the
   record screen navigates away; the recording continues, with the global status
   banner visible.
5. **Line picker on Compose `Canvas`** — draw the projected trace, hit-test taps
   against the nearest trace point, support pan and zoom. Same feedback loop as
   iOS: tap → gate → laps shown immediately.
6. **Save** via `POST /events/:id/sessions` with `{label?, notes?, laps: [Int], trace?, channels?}`.
   Lap times are integer milliseconds. Make the same explicit decision about
   `channels` as NS-17 — send `null` rather than a shape `sanitizeChannels` will
   reject with `400`.
7. **Haptics** on start/stop and personal-best.
8. **Nothing in this UI may be required for recording to continue.**

## Acceptance criteria

- [ ] Recording survives navigation, backgrounding, rotation, and process death ("Don't keep activities" on).
- [ ] In-progress recording visible from every screen.
- [ ] Notification Stop works with the app not foregrounded; tapping it deep-links to the record screen.
- [ ] System back does not stop a recording.
- [ ] Event-less recording works and is adopted by the first event it is opened from.
- [ ] Line picking produces laps matching the **web app and the iOS app** for the same trace and pick (NS-13/NS-14 shared fixture).
- [ ] Stationary and no-crossing picks give clear guidance.
- [ ] Saved session shows correct lap times, `~` on estimated laps, best-lap trace rendered.
- [ ] Saving offline queues and replays (or, pre-NS-22, fails without data loss).
- [ ] `git diff --stat public/ src/` is empty.

## Verification

Record with emulator GPX playback of a real lap, pick a line, save, and confirm
the session on https://trackevolution.app. Diff the lap times against the same
trace run through the web import flow and through the iOS app.

```sh
adb shell am kill app.trackevolution   # process death mid-review
```

## Notes

- The raw trace never leaves the device unless the user saves.
- Telemetry **file** import is not part of this app.
