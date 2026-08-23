# NS-20 — Android Auto

> **Outcome: shipped, then rejected by Google Play. The car surface is now
> debug-only and does not reach users.**
>
> Requirement 8 asked for the category to be confirmed suitable *before*
> building the UI. It was not — POI was declared as the least-bad fit on the
> reasoning that the category is only reviewed at the Play Console opt-in
> (NS-27). The opt-in happened, the review fired, and version code 1 was
> **rejected** under car app quality `PF-1`: the app provided no meaningful
> functionality in its declared category relevant to driving. Correct — a lap
> timer is not a point-of-interest app. Google's review tooling still labels the
> POI bucket "Parking and Charging Functionality" (the pre-Car-App-Library-1.3
> category names), which is why the rejection reads as a parking app.
>
> **This is not fixable within the spec.** No supported category permits a
> driving task; NAVIGATION would fail the same criterion. Android has no
> equivalent of the CarPlay driving-task entitlement Apple granted for NS-19.
>
> **What shipped instead** is this spec's own documented fallback, which already
> existed: the recording notification's Stop action (`RecordingNotification`)
> plus the driving-sized `RecordScreen` on the phone.
>
> **What the code does now.** Everything car lives in the `debug` source set —
> `app/src/debug/kotlin/.../auto/`, `app/src/debug/res/xml/automotive_app_desc.xml`,
> the manifest block in `app/src/debug/AndroidManifest.xml`, the `androidx.car.app`
> dependencies as `debugImplementation`, and `AutoRecordingTest` in
> `src/testDebug`. It still builds, still tests, and still runs on the Desktop
> Head Unit; a release APK simply does not contain it.
>
> **Why not merely unregistered.** The review fires on any submission carrying a
> car-compatible artifact while the Android Auto form factor is opted in, and a
> failure in the *production* track rejects the entire submission — freezing
> ordinary phone updates. `:app:checkReleaseHasNoCarApp` guards it, because CI
> only ever builds the debug variant and would not otherwise notice a `<service>`
> block moved back into `src/main`.
>
> Re-promoting this needs a Play category that permits a driving task to exist
> first. That is a policy change to watch for, not work to schedule.

**Phase:** 1 · **Platform:** Android · **Depends on:** NS-16 · **Estimate:** 4–5 days

## Goal

Start and stop a lap recording from the car's head unit on Android Auto.

**This does not exist today in any form.** The Capacitor app has CarPlay only, so
this is net-new capability rather than a port — which also means there is no
existing behavior to preserve, only a counterpart to match.

**Read `NS-19-carplay.md` first.** The event-attachment rule, the best-effort
network policy, and the "never guess further" principle are identical and are the
substance of this spec. They are not repeated here.

## Requirements

1. **A `CarAppService` + `Session` + `Screen`** using `androidx.car.app`, in a
   separate `:auto` module. Register in the manifest with the
   `androidx.car.app.category.` category appropriate to a driving task — verify
   against current Play policy, since Android Auto app categories are more tightly
   policed than CarPlay's and an unsupported category is a rejection.
2. **One screen, one control.** A `PaneTemplate` or `MessageTemplate` with a
   Start/Stop action, recording state, elapsed time, attached event name (or
   "No event — will attach later"), and a GPS indicator. Nothing more — Android
   Auto's distraction guidelines cap template complexity and will reject extras.
3. **Talk to the recorder directly** — the same foreground service from NS-16. No
   bridge layer.
4. **Port the event-attachment rule** from `public/js/record/remote.js`, sharing
   the `pickRecordingEvent` / `localTodayIso` implementation with NS-12's `:core`
   module so the phone and the car cannot diverge. Date-only, DST-safe, UTC
   arithmetic; "today" is the phone's local calendar date.
5. **Best effort only.** Signed out, offline, or no event today must all still
   record. Any failure fetching events yields `eventId = null` and the recording
   starts anyway.
6. **State mirrors both ways** between phone UI and head unit.
7. **Connect/disconnect mid-recording must not interrupt it.** The recording lives
   in the foreground service; the car screen is a view onto it.
8. **Play Store distribution.** Android Auto apps need a declared category and pass
   a separate review. Confirm the driving-task category actually permits this app
   **before** building the UI — if it does not, raise it immediately; that is a
   scope question, not an implementation detail.

## Acceptance criteria

- [ ] Start/Stop from the head unit drives a real recording.
- [ ] Phone and car screens mirror each other's state.
- [ ] Event covering today attaches; overlapping events tie-break to most recently started.
- [ ] No event today → records unattached.
- [ ] Signed out → records. Airplane mode → records.
- [ ] No GPS → clear message, not a silent no-op.
- [ ] `pickRecordingEvent` / `localTodayIso` shared with `:core` and covered by the tests ported from `test/unit/record-remote.test.js`, including a DST case.
- [ ] Connect/disconnect mid-recording does not interrupt.
- [ ] Verified on the Desktop Head Unit **and** a real head unit or phone-screen Android Auto. *(Never completed, and now moot for shipping — debug builds run on the DHU, but nothing reaches a user.)*
- [x] ~~Play policy category confirmed suitable~~ — **confirmed unsuitable.** Reviewed and rejected under `PF-1`; see the banner above.
- [ ] `git diff --stat public/ src/` is empty.

## Verification

```sh
# Desktop Head Unit, from the Android SDK
adb forward tcp:5277 tcp:5277 && ./desktop-head-unit
```

Enable developer mode in the Android Auto app on the phone first. Test a full
cycle: start from the head unit, drive with emulator GPX playback, stop from the
phone, confirm the car screen updates.

## Notes

- The event-attachment rule is conservative on purpose. Do not add a
  "nearest event" heuristic.
- If Play policy blocks this app from Android Auto, the fallback is the
  notification's Stop action (NS-16) plus a large-touch-target recording screen —
  raise it rather than shipping something that fails review.
- When this ships, `site/docs/lap-recording.html` and the `site/index.html` feature
  grid should say so (NS-28) — but not before, per the existing policy that the
  docs site never advertises unshipped features.
