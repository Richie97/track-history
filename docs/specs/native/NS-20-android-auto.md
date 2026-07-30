# NS-20 — Android Auto

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
- [ ] Verified on the Desktop Head Unit **and** a real head unit or phone-screen Android Auto.
- [ ] Play policy category confirmed suitable, documented in the PR.
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
