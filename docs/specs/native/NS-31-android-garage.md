# NS-31 — Garage (Android)

**Phase:** 2 · **Platform:** Android · **Depends on:** NS-26 · **Estimate:** 1 week

## Goal

The garage on Android: what's fitted to the car, how much life is left in it, and
the reminder that it's due — where the car is.

**Read `NS-29-ios-garage.md` in full.** It carries the scope table, the
server-computed-wear rule, the offline-write rule, and the screen inventory. None
of that is repeated here, and none of it changes.

## Why this spec exists

NS-29 brought the garage off the deferred list for iOS, on the argument that
deciding whether the pads will last the weekend is something you do *at the car*
with a phone. That argument was never iOS-specific — it just got written down
while iOS was the client being built.

`docs/specs/native/README.md` and `ApiClient.kt` both said the garage was
deferred on Android, so NS-26 would have had to either omit it or link out to the
web app. This spec is the deliberate alternative, written rather than folded
silently into NS-26: that ticket's acceptance criteria are about the logbook, and
a spec quietly grown mid-flight is a spec nobody can check.

Its **analysis** half — the setup notebook and the setup-vs-lap-times diff —
stays deferred on both platforms. That division is unchanged.

## Android-specific requirements

1. **The wear math is not ported, on this platform either.** `GET /api/garage`
   arrives with every part's estimate already computed by `src/lib/wear.ts`.
   Reimplementing it here would make a *fifth* copy of that arithmetic (server,
   web mirror, iOS presentation, offline mirror, this) and it would be wrong in
   the paddock, where the client has stale events and the server does not.
2. **The presentation logic is ported and pinned.** `partStatus`, `fmtRemaining`,
   `fmtHours` and `fmtCost` from `public/js/garage.js` go into `:core` under the
   same names, asserted against the existing `contracts/logic/garage-status.json`
   — the same fixture iOS uses, so the two ports are checked against the web
   implementation rather than against each other. A threshold an hour out still
   looks plausible on screen, which is exactly why it is pinned rather than
   eyeballed.
3. **Garage writes stay off the offline queue.** Already true and already tested
   (`GarageApiTest`); it must stay that way. Reads still come through the cache,
   so the garage is readable offline and not writable, and a failed write shows
   the server's own message.
4. **`GET /api/garage` fails independently.** The dashboard fetches it separately
   from the logbook and swallows its failure. The garage is a section, not the
   screen, and an empty or failing garage must not cost the user their events.
5. **`trackevolution://vehicle/:id` and the web app's `#/vehicle/:id` resolve.**
   `DeepLink.Vehicle` already parses and its own comment says NS-26 decides what
   it shows; NS-26 sends it to the dashboard as a no-dead-link fallback. This
   spec is what makes it land on the car.
6. **Compose idioms, NS-07 tokens.** The wear bar is drawn, not a Material
   `LinearProgressIndicator` recoloured — flat depth, hairline plus one surface
   step, no elevation. A bar is the one element here that must read at a glance
   in daylight, so contrast against `bgSubtle` matters more than it does
   elsewhere.
7. **A part with no basis for an estimate says so.** No expected life and fewer
   than two measurements means no projection — it must not render an empty bar,
   which reads as "new" rather than "unknown". This is the first case in the
   pinned fixture for a reason.

## Acceptance criteria

- [ ] `partStatus`/`fmtRemaining`/`fmtHours`/`fmtCost` in `:core` match
      `contracts/logic/garage-status.json` case for case, boundaries included.
- [ ] Wear math is not reimplemented anywhere in the client.
- [ ] Vehicle page: accrued hours/days/events/spend, a card per consumable in
      service with its wear bar and one-line story, measurement logging and
      deletion, add/edit/retire/refresh/delete, the retired list with cost per
      hour, and the track-hours ledger linking back to its events.
- [ ] Dashboard carries the collapsed maintenance strip and a card per vehicle.
- [ ] A dashboard whose `/garage` call fails still renders the logbook.
- [ ] Settings owns the vehicle list — add, make default, edit, delete.
- [ ] The event form's Car field stays **free text** with suggestions, never a
      picker: a car that isn't in the garage has to keep working (NS-25).
- [ ] Garage writes remain absent from the queueable whitelist and fail offline
      with the server's own message.
- [ ] A part with no estimate says so rather than showing an empty bar.
- [ ] `#/vehicle/:id` deep-links from cold start; an unparseable id falls back to
      the dashboard rather than a blank screen.
- [ ] Largest system font scale usable on the vehicle page; both themes checked.
- [ ] `git diff --stat public/ src/` is empty.

## Verification

Compare a vehicle side by side with https://trackevolution.app and the iOS app on
the same account — same parts, same statuses, same remaining-life wording.

```sh
cd apps/android && ./gradlew :core:test :app:testDebugUnitTest
adb shell am start -W -a android.intent.action.VIEW -d "trackevolution://vehicle/1" app.trackevolution
```

Then add a vehicle, add a part, log a measurement, refresh it, and delete what
you created — the dev logbook is shared, so a test that leaves rows behind makes
the next one harder to read.

## Notes

- NS-29's closing note says the parts worth carrying over are the *data*
  decisions rather than its SwiftUI bug list: server-computed wear, writes that
  need a live server, and a garage section that fails independently of the screen
  it sits on. All three are requirements above.
- When this ships, `site/docs/garage.html` and the feature grid should say the
  garage is on Android — but not before, per the standing policy that the docs
  site never advertises unshipped features. NS-28 owns that.
