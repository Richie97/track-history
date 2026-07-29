# NS-25 — Core screens (iOS)

**Phase:** 2 · **Platform:** iOS · **Depends on:** NS-21, NS-23, NS-08 · **Estimate:** 3–4 weeks

## Goal

The logbook itself: dashboard, event detail, event form, track page, settings.
Everything a user touches between sessions.

## Scope

**In scope**, mirroring the hash routes in `public/app.js`:

| Screen | Web reference | Route |
|---|---|---|
| Dashboard | `viewDashboard` (line 652) | `#/` |
| Event detail | `viewEvent` (1088) | `#/event/:id` |
| Event form (new/edit) | `viewEventForm` (1556) | `#/new`, `#/event/:id/edit` |
| Track page | `viewTrack` (833) | `#/track/:id` |
| Settings | `viewSettings` (1676) | `#/settings` |

**Out of scope — deferred, stays web-only** (see `README.md` in this directory):
garage / vehicle pages (`viewVehicle`), the per-day setup notebook, the
setup-vs-lap-times diff, year in review (`viewYear`), compare (`viewCompare`),
and all telemetry file import. The recorder screen is NS-17.

**Consequence to handle deliberately:** the dashboard currently carries a
maintenance-due strip and garage cards fed by `GET /api/garage`. Those are part
of the deferred garage feature. Either omit them cleanly or show a read-only
summary that links out to the web app — **decide, and say which in the PR.** Do
not half-build the garage.

## Requirements

1. **Navigation.** `NavigationStack` with a typed path. Deep links
   (`/share/<slug>`, and any in-app links) must resolve into the stack correctly
   from cold start.
2. **Dashboard**: upcoming and past events, per-track bests, aggregate totals, and
   the **unattached-recording banner** from NS-17 (a CarPlay-started recording
   waiting for an event to adopt it). Pull-to-refresh — `public/js/pull-refresh.js`
   is a hand-built approximation of what `.refreshable` gives natively for free.
3. **Event detail**: sessions with their laps, per-session stats (best-N average,
   pace slope, warmup — port `public/js/lap-stats.js`, 44 lines, with
   `test/unit/lap-stats.test.js`), the progress chart, the best-lap trackmap, and
   the record panel entry point.
   - Lap and session CRUD: add/edit/delete laps, edit session label and notes,
     reorder, delete session.
   - **Every one of these is on the `QUEUEABLE` whitelist** and must work offline.
4. **Event form**: track name with suggestions from `GET /api/catalog`, dates,
   days, club, run group, car, conditions, temp, notes, checklist, manual best
   time, and the optional `track_hours` override.
   - `events.car` is free text but is auto-matched to a garage vehicle by name
     server-side. Do not add a vehicle picker — that is garage UI, deferred.
   - Track names carry the layout ("Virginia International Raceway (Full)" vs
     "(Patriot)") and are matched case-insensitively server-side. Do not
     normalize, trim aggressively, or title-case user input — you will merge two
     distinct layouts.
5. **Track page**: per-track event history, best-time progression chart, and the
   goal time. The **setup-vs-lap-times table is deferred** — omit it.
6. **Settings**: theme override (NS-06), sign-out (NS-08), account info from
   `GET /api/me`, share-slug management (`PUT`/`DELETE /api/share`), and links to
   the privacy policy and terms.
   - **The privacy and terms links are required on every platform** — the web app
     links them from Settings and from the footer on signed-out and share pages.
     A native app with no footer must carry them in Settings.
   - Vehicle/garage management is deferred; link out to the web app.
7. **Time formatting** via the `LapTime` helpers from NS-04 (`m:ss.fff`). Estimated
   laps render with a `~` prefix.
8. **Native feel is the point.** Swipe-to-delete, context menus, `.refreshable`,
   proper keyboard avoidance and input accessory views, share sheet for share
   links, and real navigation transitions. The web app fakes several of these;
   do not port the fakes.
9. **Every list and detail view reads through the offline layer** (NS-21) — no
   direct `APIClient` calls from views.

## Acceptance criteria

- [ ] All five screens implemented and reachable; deep links resolve from cold start.
- [ ] Event, session, and lap CRUD all work **offline** and replay correctly.
- [ ] Dashboard shows the unattached-recording banner and adoption works end to end.
- [ ] Track name entry preserves layout suffixes and case; two layouts of one circuit stay separate.
- [ ] Catalog suggestions appear in the event form.
- [ ] Privacy and terms are reachable from Settings.
- [ ] Share slug can be set, copied via the share sheet, and disabled.
- [ ] Lap times format identically to the web app, including `~` on estimated laps.
- [ ] Garage/setup/year-review absence is handled cleanly — no dead links, no empty shells.
- [ ] Largest Dynamic Type size is usable on every screen.
- [ ] `git diff --stat public/ src/` is empty.

## Verification

Sign in as a real account with existing data and compare every screen against
https://trackevolution.app side by side. Then repeat the full CRUD sequence in
airplane mode and confirm the server state after reconnect matches.

## Notes

- `public/app.js` builds HTML with template strings and re-renders whole views,
  so element handles go stale — a constraint that does not exist here. Read it for
  **behavior and copy**, not structure.
- Reuse the existing user-facing wording where it is good; it has been through
  real use.
