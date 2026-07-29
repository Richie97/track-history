# NS-17 — Recording UI + review/save flow (iOS)

**Phase:** 1 · **Platform:** iOS · **Depends on:** NS-15, NS-13, NS-08 · **Estimate:** 5–7 days

## Goal

The screens around the recorder: start/stop, live status, the start/finish line
picker, lap review, and saving the result as a session. This is what turns
NS-15's fix stream into rows in the logbook.

## Reference

`public/js/record/ui.js` (319 lines) owns the lifecycle today, and hands its
result to `reviewResults` in `public/js/import/ui.js` (345 lines) — the *identical*
flow an imported telemetry file goes through. Read both, plus `viewRecord` in
`public/app.js` (line 1480).

## Requirements

1. **Recording is app-global, not screen-local.** In the web app the module state
   deliberately survives navigation. Natively: an observable recorder object owned
   above the view tree, so navigating away, backgrounding, or launching from
   CarPlay never interrupts it. A recording in progress must be visible from
   anywhere in the app — a persistent status bar or banner.
2. **Start.** From an event's record screen (attached to that event) or with no
   event at all. Event-less recording matters: **CarPlay can start a recording
   before the event exists** (NS-19). The dashboard shows a banner for an
   unattached recording, and the first event whose record screen it is opened from
   adopts it — `bindRecorder` sets `eventId` + label and re-checkpoints. Reproduce
   that adoption behavior; `test/unit/record-remote.test.js` covers the rules.
3. **Live status:** elapsed time, fix count, current speed, GPS accuracy, and a
   clear indicator when fixes have stopped arriving. If accuracy degrades badly or
   the stream stalls, say so — silent failure during a session is the worst
   outcome.
4. **Stop → review.** Stopping does **not** discard: the recording stays
   checkpointed until explicitly saved or discarded. Recovery on next launch if
   the app died.
5. **The line picker.** A live recording has no lap markers (`needsLine: true`),
   so the user picks the start/finish line on a map of the driven trace:
   - Render the projected trace (`projectTrace`, NS-13) fitted to the viewport.
   - Tap a point → `buildGate` → `deriveLaps` → show the resulting lap list live,
     so a bad pick is obvious immediately.
   - Handle `buildGate` returning `nil` (stationary pick) with a clear message.
   - "No laps cross the picked line — try a different spot" when the pick yields
     nothing, matching the web app's wording.
   - Panning/zooming the map is a genuine improvement over the web version; the
     touch target for a line pick is small.
6. **Review and save.** `POST /events/:id/sessions` with:
   ```
   { label?, notes?, laps: [Int], trace?, channels? }
   ```
   - `laps` is an array of **integer milliseconds** (`sanitizeLaps` server-side).
   - `trace` is the best lap's downsampled polyline from `bestLapTrace` (NS-13),
     validated server-side by `sanitizeTrace`.
   - `channels` — **decide explicitly whether native recordings store per-lap
     speed channels at parity with web.** If yes, `js/import/channels.js` needs
     porting (a follow-up spec) and the shape must satisfy `sanitizeChannels` in
     `src/lib/validate.ts`. If no, send `nil` and note the gap in the PR. Do not
     send a half-formed shape — the server will reject it with `400 invalid channels`.
   - Laps derived from GPS are `estimated` and render with a `~` prefix. Preserve
     that in the review list.
7. **Discard** requires confirmation and clears the checkpoint.
8. **Offline-first.** Saving must work with no network — the whole point is a
   phone in a paddock. `POST /events/:id/sessions` is on the `QUEUEABLE` whitelist
   in `public/js/offline.js`, so it queues and replays. Depends on NS-21; until
   that lands, at minimum do not lose the recording on a failed save.
9. **Haptics** on personal-best (`platform.hapticPB` today) and on start/stop
   confirmation — with gloves on, in a loud car, haptics are the only reliable
   feedback channel.
10. **Screen-off is the normal case.** Nothing in this UI may be required for the
    recording to continue. Do not tie timers, updates, or checkpointing to view
    lifecycle.

## Acceptance criteria

- [ ] A recording survives navigating away, backgrounding, locking, and returning.
- [ ] An in-progress recording is visible from every screen.
- [ ] Event-less recording works and is adopted by the first event it is opened from.
- [ ] Stopping keeps the recording until saved or discarded; app death mid-review recovers it.
- [ ] Line picking produces laps matching what the **web app** produces for the same trace and pick (use the NS-13 cross-language fixture).
- [ ] Stationary pick and no-crossing pick both give clear guidance, not a dead end.
- [ ] Saved session appears with correct lap times, `~` on estimated laps, and the best-lap trace rendered.
- [ ] Saving offline queues and replays on reconnect (or, pre-NS-21, fails without data loss).
- [ ] `git diff --stat public/ src/` is empty.

## Verification

Record a real session (or Freeway Drive in the simulator), pick a line, save, and
confirm the session on https://trackevolution.app matches. Then repeat the same
trace through the web app's import flow and diff the lap times.

## Notes

- The raw trace never leaves the device unless the user saves. Preserve that.
- Telemetry **file** import is not part of this app — see `README.md` in this
  directory. This spec reuses only the review/line-picker *interaction*, which the
  web app happens to share between recording and import.
