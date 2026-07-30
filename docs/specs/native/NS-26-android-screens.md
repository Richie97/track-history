# NS-26 — Core screens (Android)

**Phase:** 2 · **Platform:** Android · **Depends on:** NS-22, NS-24, NS-09 · **Estimate:** 3–4 weeks

## Goal

The logbook in Compose: dashboard, event detail, event form, track page, settings.

**Read `NS-25-ios-screens.md` in full.** It carries the screen inventory, the
deferred-feature list and how to handle their absence, the track-name warning, the
offline requirement, and the privacy/terms obligation. None of that is repeated
here.

## Android-specific requirements

1. **Navigation Compose** with type-safe routes. App Links (`/share/*`) and
   `trackevolution://` deep links resolve into the back stack correctly from cold
   start.
2. **System back is a first-class gesture.** Predictive back where it applies.
   Back from a detail screen returns to the list with scroll position preserved;
   back at the root minimizes rather than exiting to a blank screen.
   - Today the Capacitor app approximates this through the App plugin's
     `backButton` listener in `mobile/overrides/native.js`. Do not port that
     approximation — use real navigation.
3. **State survives configuration change and process death.** Rotation, theme
   change, and font-scale change must not lose form input or scroll position.
   Test with "Don't keep activities" enabled.
4. **Material idioms where they fit** — swipe-to-dismiss, long-press context
   menus, `PullToRefreshBox`, snackbars for undo — but the visual language is
   NS-07's tokens, not stock Material. **Flat depth: hairline plus one surface
   step, no elevation shadows.**
5. **Edge-to-edge** with correct insets; the app draws behind system bars.
6. **Share sheet** via `Intent.ACTION_SEND` for share links.
7. **Every list and detail view reads through the offline layer** (NS-22) — no
   direct `ApiClient` calls from composables.

## Acceptance criteria

- [ ] All five screens implemented; deep links and App Links resolve from cold start.
- [ ] Event, session, and lap CRUD all work **offline** and replay correctly.
- [ ] Dashboard shows the unattached-recording banner; adoption works end to end.
- [ ] System back behaves correctly at every level, including at the root.
- [ ] Rotation and process death preserve form input and scroll position.
- [ ] Track name entry preserves layout suffixes and case.
- [ ] Catalog suggestions appear in the event form.
- [ ] Privacy and terms reachable from Settings.
- [ ] Share slug set / copied / disabled.
- [ ] Lap times format identically to the web and iOS apps, including `~`.
- [ ] Garage/setup/year-review absence handled cleanly — no dead links.
- [ ] Largest system font scale usable on every screen; edge-to-edge insets correct.
- [ ] `git diff --stat public/ src/` is empty.

## Verification

Compare every screen against https://trackevolution.app and the iOS app with the
same account. Repeat the full CRUD sequence in airplane mode and confirm server
state after reconnect.

```sh
adb shell am kill app.trackevolution        # process death
adb shell settings put global always_finish_activities 1
```

## Notes

- Read `public/app.js` for **behavior and copy**, not structure.
- Reuse existing user-facing wording where it is good.
