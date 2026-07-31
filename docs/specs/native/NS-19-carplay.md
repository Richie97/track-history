# NS-19 — CarPlay driving-task scene (iOS)

**Phase:** 1 · **Platform:** iOS · **Depends on:** NS-15 · **Estimate:** 3–4 days

## Goal

Start and stop a lap recording from the car's head unit, talking **directly** to
the native recorder — no JavaScript bridge.

## What this replaces

The Capacitor app reaches CarPlay through a chain of workarounds:

- `mobile/ios/App/App/CarPlaySceneDelegate.swift` — the scene
- `mobile/ios/App/App/CarPlayBridgePlugin.swift` (64 lines) — marshals commands
  into JS as `Capacitor.Plugins.CarPlayBridge`
- `public/js/record/remote.js` — the JS side, registering `platform.recorderRemote`
- `mobile/ios/App/App/PhoneSceneDelegate.swift` (60 lines) — exists **only**
  because declaring a CarPlay scene moved the whole app onto the UIKit scene
  lifecycle, after which Capacitor's `AppDelegate` stopped receiving URL opens and
  universal links
- a rule that every in-app browser must use `presentationStyle: "popover"`, because
  Capacitor's fullscreen path builds a scene-less `UIWindow` that never becomes
  visible under scenes

**All five disappear.** A SwiftUI app is scene-based from birth, so adding a
CarPlay scene costs nothing and breaks nothing. Delete them in NS-27.

## Requirements

1. **A `CPTemplateApplicationScene`** declared in the scene manifest alongside the
   phone window scene, with a `CPInterfaceController`-driven
   `CPInformationTemplate` carrying a Start/Stop button — mirroring today's
   single-template design. Keep it that simple: this is a driving-task app, and
   Apple's review bar for driver distraction is unforgiving.
2. **Talk to the recorder directly.** The CarPlay scene calls the same recorder
   object the phone UI uses (NS-15). No bridge, no serialization, no JS.
3. **Port the event-attachment rule from `public/js/record/remote.js` exactly.**
   This is the subtle part, and `test/unit/record-remote.test.js` is its spec:
   - `start()` attaches to the event whose `start_date` + `days` **covers today**.
     Overlapping events tie-break to the one that started most recently.
   - It **never guesses further.** A recording that lands in last month's event is
     worse than one that waits, unattached, for its event to be created at review
     time.
   - Fetching the event list is **best effort only.** Signed out, offline, or no
     event today must all still record. The GPS trace is the irreplaceable part;
     the event is not. Wrap the fetch so any failure yields `eventId: nil` and the
     recording still starts.
   - Day arithmetic must be **date-only and DST-safe**. `remote.js` does it in UTC
     precisely so a DST transition cannot skip or repeat a calendar day. "Today" is
     the phone's local calendar date — track time is phone time.
   - Port `localTodayIso` and `pickRecordingEvent` with tests.
4. **State mirrors both ways.** The car screen reflects whatever the phone does
   and vice versa — start on the phone, and the head unit shows Stop. This is
   `platform.onRecorderState` today; natively it is just observing the same object.
5. **Show enough to be useful, not enough to distract:** recording state, elapsed
   time, attached event name (or "No event — will attach later"), and a GPS-fix
   indicator. Report failures plainly — a `{ ok: false, reason: "gps" }` today
   should read as "No GPS signal" on the head unit.
6. **The entitlement is granted, so it is checked in.**
   *(Amended: this requirement originally read "not checked in, and must not be
   added", because `com.apple.developer.carplay-driving-task` is Apple-granted and
   the key breaks signing for profiles that don't carry it. Apple has since granted
   it — verified by a signed device build embedding the key under team
   `L3NS86NMXZ` — so the rule is inverted.)*
   The key lives in `apps/ios/App/TrackEvolution.entitlements`. Dropping it does
   **not** fail a build: the scene just never attaches and CarPlay vanishes
   silently, which no test catches. CI therefore asserts the key is present and
   lints every entitlements file.
   `site/docs/lap-recording.html` still waits — the docs site must not advertise a
   feature until a CarPlay-enabled build actually ships (NS-27).

## Acceptance criteria

- [ ] Start/Stop from the CarPlay screen drives a real recording.
- [ ] Starting on the phone updates the car screen and vice versa.
- [ ] With an event covering today, the recording attaches to it; with two overlapping, to the most recently started.
- [ ] With **no** event today, recording still starts, unattached.
- [ ] **Signed out**, recording still starts.
- [ ] **Airplane mode**, recording still starts.
- [ ] No GPS → a clear "No GPS signal" on the head unit, not a silent no-op.
- [ ] `pickRecordingEvent` and `localTodayIso` ported with passing tests from `test/unit/record-remote.test.js`, including a DST-transition case.
- [ ] The app builds, runs, and passes CI with **no CarPlay entitlement present**.
- [ ] Connecting/disconnecting CarPlay mid-recording does not interrupt it.
- [ ] `git diff --stat public/ src/` is empty.

## Verification

Works before Apple's grant (README lines 214–224): temporarily add the
entitlement key to the **debug** entitlements (do not commit), run on an iPhone
simulator, then Simulator → **I/O → External Displays → CarPlay**. Use
**Features → Location → Freeway Drive** for fixes fast enough to arm the recorder.

Revert the entitlement before building to a device. Real head units and Apple's
CarPlay Simulator need the granted entitlement.

## Notes

- Do not add screens. Every extra template is another review risk and another
  thing to read at 70 mph.
- The event-attachment logic is the one piece of real judgment here. If you find
  yourself adding a "closest event" or "most likely event" heuristic, stop — the
  existing rule is deliberately conservative and was chosen over exactly that.
