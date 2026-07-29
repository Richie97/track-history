# NS-21 — Offline cache + write queue (iOS)

**Phase:** 2 · **Platform:** iOS · **Depends on:** NS-04 · **Estimate:** 7–10 days

## Goal

Port `public/js/offline.js` (629 lines) to Swift: a durable cache of GET `/api`
responses plus a persistent queue of writes made offline, replayed in order on
reconnect.

This is not a nice-to-have. A track-day paddock has no usable signal, and the app
is used *there*.

## Reference

`public/js/offline.js` and its tests in `test/unit/offline.test.js`, plus
`public/js/prefetch.js` (45 lines) for cache warming. Read the header comment in
`offline.js` before starting — it explains the design in full.

## Requirements

1. **GRDB, not SwiftData.** A cache-plus-write-queue with explicit ordering,
   temp-id rewriting, and cross-row patching wants real SQL and transactional
   control. SwiftData's object graph fights this pattern.
   - **One database for cache and queue.** A queued write and its optimistic cache
     patch commit in a *single transaction*. The web app cannot do this cleanly
     across IndexedDB stores — take the win.
2. **Network-first GETs with cache fallback**, keyed by path, exactly as `api.js`
   does today. A cached response is served when the network fails, not when it is
   merely slow.
3. **The queueable whitelist.** Only these mutations queue offline — everything
   else fails normally. Copy `QUEUEABLE` from `offline.js` verbatim:
   ```
   POST   /events                       (creates)
   PUT    /events/:id
   DELETE /events/:id
   POST   /events/:id/sessions          (creates)
   PUT    /events/:id/setups/:day
   DELETE /events/:id/setups/:day
   PUT    /sessions/:id
   DELETE /sessions/:id
   POST   /sessions/:id/laps
   DELETE /laps/:id
   PUT    /tracks/:id
   ```
   **Vehicle and garage-part writes deliberately require a live server** and must
   fail offline. Do not "improve" this.
4. **Optimistic patching.** A queued mutation patches the cached responses it
   affects so the UI shows the change immediately and consistently across views —
   the dashboard, the event page, and the track page must all agree.
5. **Temp ids.** A create made offline gets `tmp-N`. On replay, the real id comes
   back and every reference to the temp id — queued items and cached rows — is
   remapped. The app must also remap any navigation state pointing at `tmp-N`
   (`app.js` remaps the `#/event/tmp-N` hash today).
6. **Cancelling, not queueing, a delete of an unsynced row.** Deleting something
   that exists only as a queued create drops that create *and everything created
   under it* — sessions of a temp event, laps of a temp session — rather than
   queueing a DELETE the server could never resolve. `dropQueuedFor` in
   `offline.js` walks this transitively; port that walk.
7. **Replay is strictly ordered** and stops on the first failure. Conflict policy
   is **last-write-wins**. A write the server *rejects* (4xx) is dropped and
   surfaced to the user — `#sync-banner` on the web, a persistent banner natively.
   Do not retry a rejected write forever.
8. **Mirrored backend logic — the dangerous part.** `offline.js` deliberately
   reimplements two server behaviors so offline reads look right:
   - `recomputeDetail` ↔ `withComputed` (`src/lib/stats.ts`), including the
     `hours` rule from `src/lib/wear.ts`
   - `cleanLaps` ↔ `sanitizeLaps` (`src/lib/validate.ts`)

   This port makes that **three** mirrors of two behaviors. Put them in one clearly
   named file, reference the server source in a comment, and test them against the
   same fixtures the JS tests use. When one changes, all three change.
9. **Prefetch.** After a dashboard load, warm every event detail, re-fetching only
   rows whose `updated_at` differs from the cached copy (`updated_at` is
   trigger-maintained, migration 0011). Do this off the main actor and do not let
   it block UI.
10. **Sign-out clears cache and queue.** A shared device must not retain the
    previous user's logbook.

## Acceptance criteria

- [ ] Every `test/unit/offline.test.js` case has a passing Swift equivalent.
- [ ] Airplane mode: create event → session → laps → reconnect → all replay in order with correct ids.
- [ ] Deleting an unsynced event cancels its queued create and all descendants; nothing is sent.
- [ ] A server-rejected write is dropped once and surfaced in a banner, not retried indefinitely.
- [ ] Optimistic patches make dashboard, event, and track views agree before sync.
- [ ] `recomputeDetail` produces the same `best_ms`, `consistency`, and `hours` as the server for the NS-03 golden fixtures — including `consistency == nil` below 3 laps.
- [ ] Prefetch re-fetches only stale rows, verified by request count.
- [ ] Sign-out leaves no cached rows and no queued writes.
- [ ] Queue survives app termination and device restart.
- [ ] `git diff --stat public/ src/` is empty.

## Verification

```sh
npx vitest run test/unit/offline.test.js
xcodebuild test -project apps/ios/TrackEvolution.xcodeproj -scheme TrackEvolutionKit
```

Then, on a device: airplane mode, perform the full create/edit/delete sequence,
re-enable networking, and diff the resulting server state against the same
sequence performed on the web app.

## Notes

- The mirroring in (8) is the highest-risk debt in this programme. If you find a
  divergence between the JS mirror and the server, fix the **server-matching**
  behavior and report it — the web app probably has the same bug.
- Do not add a sync engine, CRDTs, or a conflict UI. Last-write-wins is the chosen
  policy for a single-user logbook and is adequate.
