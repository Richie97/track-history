# Native stack rewrite — specifications

Work breakdown for replacing the Capacitor shells in `mobile/` with first-party
native apps: **SwiftUI (iOS)** and **Jetpack Compose (Android)**.

## Fixed decisions

These are settled. A spec that appears to require changing one of them is a spec
that needs rewriting, not a decision to revisit.

| | |
|---|---|
| Client stack | SwiftUI (iOS) + Jetpack Compose (Android) — two first-party native apps |
| Backend | **Unchanged.** Cloudflare Workers + Hono + D1, same `/api` and `/auth` |
| Web app (`public/`) | **Unchanged.** Stays as-is, maintained in parallel as a third platform |
| `mobile/` (Capacitor) | Retired at the end, replaced by the native projects |
| Priorities | 1. Background GPS + CarPlay reliability  2. Native feel/performance |

**`src/` must not change.** `npm test` and `npm run typecheck` stay green with
zero backend diffs throughout. NS-03 adds test-side output only. If a spec seems
to need a backend change, stop and raise it.

## The product split

The three clients are deliberately **not** at parity:

- **Native apps own the on-track critical path** — recording, the logbook you
  check between sessions, CarPlay. Fast, offline, reliable with the screen off.
  **Android Auto is the one thing this list promised and cannot deliver:** it was
  built (NS-20) and Google Play rejected it, because Android Auto has no category
  a driving task fits and the POI category it was declared under demands POI
  functionality a lap timer has none of. Apple granted the equivalent CarPlay
  entitlement, Google has no equivalent to grant, and that asymmetry is now a
  permanent feature of the split rather than a gap to close.
- **The web app owns the desk-bound long tail** — `.vbo` and other logger-file
  import, year in review, the setup notebook and its lap-time correlation. Big
  screen, file drag-and-drop, ships instantly.
- **The web app stays the feature frontier.** New ideas land there first and
  graduate to native once proven.

Consequence: **the telemetry parsers are, with one exception, never ported.** That
is the design, not a gap. `js/import/geo.js` *is* ported (NS-13/NS-14) because the
live recorder needs start/finish line crossing to time laps.

The exception is **video** — `public/pdr.js`, `js/import/gpmf.js`, `channels.js`
and `pdr-laps.js`, ported by NS-30 (iOS) and NS-32 (Android). The split was right about the shape of import
and wrong about that one input: a `.vbo` reaches a laptop on an SD card, but a
GoPro clip arrives in Photos over Wi-Fi and a PDR clip lands in Files off a USB
stick, both on the phone and usually before the laptop is opened. `vbo.js` stays
web-only, and so does everything else on the deferred list. See NS-30 for the
argument in full.

### Post-rewrite feature decisions

Features added after the rewrite shipped, and where they landed:

- **Live lap timing / predictive delta** (2026-08) — **native, both record
  screens.** The recorder is native-only, so its readout is too. The logic is
  `public/js/record/live-timing.js` (a reference module beside `core.js` and
  `remote.js` — the web app doesn't load it), ported as `LiveTiming` to the
  Kit and `:core` and pinned per-fix by `contracts/logic/live-timing.json`.
  The CarPlay and Android Auto templates deliberately do **not** show the
  delta yet: the phone mounted in view is the display, and the car templates
  stay one-glance Start/Stop.
- **Lap delta chart** (2026-08) — **all three.** Rides on the channel-graphs
  panel; the math (`lapTimeSeries`/`deltaSeries` in
  `public/js/channel-graphs.js`) is pinned by `contracts/logic/lap-delta.json`,
  and both chart stacks carry the port (`ChannelGraphs` in the Kit and in
  `:core`, drawn by each platform's `LapChannelChart`) — the delta renders
  above the channels once two laps are highlighted, with the reference lap as
  the zero line.
- **Sector splits + theoretical best lap**
  ([#146](https://github.com/Richie97/track-history/issues/146), 2026-09) —
  **all three.** Rides on the channel-graphs panel like the delta chart: each
  lap is split into thirds of its own driven distance off the same
  elapsed-time series, the highlighted laps' splits are tabulated with the
  session's best per sector marked, and the best sectors sum to a theoretical
  best shown in the session's stats line. The pure half is
  `public/js/sectors.js`, ported as `Sectors` to the Kit and `:core` and
  pinned by `contracts/logic/sectors.json`; the compare-laps screens reuse
  the panel, so the pair's sectors come for free. Built on all three at once
  because the paddock is where "where did the time go" gets asked.
- **Gear ribbon + shift points**
  ([#187](https://github.com/Richie97/track-history/issues/187), 2026-09,
  the first ticket of epic [#193](https://github.com/Richie97/track-history/issues/193))
  — **web first, all three intended.** Rides on the channel-graphs panel: a
  stepped band per highlighted lap under the RPM trace (gear 0 a gap, runs
  where the laps disagree outlined) and a per-gear upshift-rpm table with
  factual notes. The pure half is `public/js/gears.js`, pinned by
  `contracts/logic/gears.json` so the Kit and `:core` ports assert against
  the web output when they land; the ticket asks for all three and the
  native panels are the follow-up.
- **Panel tabs + limit marks**
  ([#188](https://github.com/Richie97/track-history/issues/188), 2026-09) —
  **web first, all three intended.** The epic's rule was that the panel gets
  an information architecture before its second chart, so the web panel now
  has one question per tab — Time / Inputs / Grip, with Car reserved for the
  scalars — and #188 rides on it: `wheelSlip` and the ABS/TC/VSC `flags`
  become marks on the best-lap track map (placed by driven-distance
  fraction, since the stored trace is the best lap only), shaded bands on
  the brake / throttle / steering traces for each highlighted lap, and a
  places-count line in the session stats. Colour is by kind, not severity,
  with shape and fill as the second encoding. The pure half is
  `public/js/limits.js`, pinned by `contracts/logic/limits.json`; every
  client already draws the track map and the panel, so the ports are the
  follow-up — and the native panels will want the same tabs before they
  take a second chart.
- **Per-track leaderboards** (2026-08) — **all three.** Strictly opt-in
  (`users.leaderboard_opt_in`); `GET /tracks/:id/leaderboard` is in the golden
  contract, and every client renders the track page's leaderboard section and
  the Settings opt-in with the same privacy copy. The opt-in write stays off
  the offline queue everywhere — publishing your name shouldn't replay
  silently later. Since [NS-33](NS-33-leaderboard-device-timed-laps.md)
  (2026-09) the ranking covers **device-timed laps only** — those with a
  matching entry in the session's `channels` blob, recorded as the
  trigger-maintained `laps.device_timed` — so a typed time or an event's
  manual best never reaches a leaderboard. Server-side and retroactive; the
  response shape didn't change, and every client's leaderboard section says
  the rule and explains a row slower than the logbook's own best.
- **Share-page OG meta** (2026-08) — **server-side**, no client work: the
  Worker injects per-slug tags into the SPA shell for `/share/:slug`.
- **Subscriptions** (2026-09, [NS-32](NS-32-subscriptions.md)) — **all three,
  server-owned.** The $1 up-front purchase becomes Track Evolution Pro at
  $1.99/month or $19.99/year, sold through StoreKit 2 and Play Billing and
  verified by the Worker, which is the only thing that decides tier. Freemium,
  not a hard paywall: **Free is the logbook, Pro is the analysis** (recorder,
  telemetry import and channel data, garage consumables, setup notebook, year
  in review) — the tier table in NS-32 is where every later feature gets its
  row before merging. Existing buyers are Pro for life. **No write route ever
  checks entitlement**, so a lapse can't make the offline queue drop a
  recording. This is the deliberate exception to the rewrite's *`src/` must not
  change* rule: the rewrite is closed, and this is a product change that lands
  in `src/` first. The gates went live in phase D: `requireEntitlement` on the
  garage consumables and the setups routes, `stripProFields` on the one field
  (`sessions.channels`), and the client gates on the recorder and the importer.
  The web-only Pro features — the two-event overlay, year in review, the setup
  notebook — gate on the client through `public/js/entitlement.js`, whose
  predicates both ports carry under the same names even where no native screen
  reads them.

## Specs

### Phase 0 — Foundations

| ID | Spec | Platform | Depends on |
|---|---|---|---|
| NS-01 | [Monorepo layout + iOS project scaffold](NS-01-ios-scaffold.md) | iOS | — |
| NS-02 | [Android project scaffold](NS-02-android-scaffold.md) | Android | — |
| NS-03 | [Golden-JSON API contract harness](NS-03-contract-harness.md) | Shared | — |
| NS-04 | [Domain models + API client — iOS](NS-04-ios-api-client.md) | iOS | NS-01, NS-03 |
| NS-05 | [Domain models + API client — Android](NS-05-android-api-client.md) | Android | NS-02, NS-03 |
| NS-06 | [Design system tokens — iOS](NS-06-ios-design-system.md) | iOS | NS-01 |
| NS-07 | [Design system tokens — Android](NS-07-android-design-system.md) | Android | NS-02 |
| NS-08 | [Auth — iOS](NS-08-ios-auth.md) | iOS | NS-04 |
| NS-09 | [Auth — Android](NS-09-android-auth.md) | Android | NS-05 |
| NS-10 | [Native CI](NS-10-native-ci.md) | Shared | NS-01, NS-02 |

### Phase 1 — The recorder

| ID | Spec | Platform | Depends on |
|---|---|---|---|
| NS-11 | [RecorderCore port — iOS](NS-11-ios-recorder-core.md) | iOS | NS-01 |
| NS-12 | [RecorderCore port — Android](NS-12-android-recorder-core.md) | Android | NS-02 |
| NS-13 | [Lap geometry port — iOS](NS-13-ios-lap-geometry.md) | iOS | NS-01 |
| NS-14 | [Lap geometry port — Android](NS-14-android-lap-geometry.md) | Android | NS-02 |
| NS-15 | [Background location + durable fix store — iOS](NS-15-ios-location-service.md) | iOS | NS-11 |
| NS-16 | [Foreground location service — Android](NS-16-android-location-service.md) | Android | NS-12 |
| NS-17 | [Recording UI + review/save — iOS](NS-17-ios-recording-ui.md) | iOS | NS-15, NS-13, NS-08 |
| NS-18 | [Recording UI + review/save — Android](NS-18-android-recording-ui.md) | Android | NS-16, NS-14, NS-09 |
| NS-19 | [CarPlay driving-task scene](NS-19-carplay.md) | iOS | NS-15 |
| NS-20 | [Android Auto](NS-20-android-auto.md) — **built, rejected by Play; debug-only** | Android | NS-16 |

### Phase 2 — Logbook + offline

| ID | Spec | Platform | Depends on |
|---|---|---|---|
| NS-21 | [Offline cache + write queue — iOS](NS-21-ios-offline.md) | iOS | NS-04 |
| NS-22 | [Offline cache + write queue — Android](NS-22-android-offline.md) | Android | NS-05 |
| NS-23 | [Charts + trackmap — iOS](NS-23-ios-charts.md) | iOS | NS-06 |
| NS-24 | [Charts + trackmap — Android](NS-24-android-charts.md) | Android | NS-07 |
| NS-25 | [Core screens — iOS](NS-25-ios-screens.md) | iOS | NS-21, NS-23, NS-08 |
| NS-26 | [Core screens — Android](NS-26-android-screens.md) | Android | NS-22, NS-24, NS-09 |

### Phase 3 — Ship

| ID | Spec | Platform | Depends on |
|---|---|---|---|
| NS-27 | [Store rollout + Capacitor retirement](NS-27-rollout.md) | Shared | NS-25, NS-26 |
| NS-28 | [Documentation update](NS-28-docs.md) | Shared | NS-27 |

### Graduated from the deferred list

| ID | Spec | Platform | Depends on |
|---|---|---|---|
| NS-29 | [Garage — iOS](NS-29-ios-garage.md) | iOS | NS-25 |
| NS-30 | [Video telemetry import — iOS](NS-30-ios-video-import.md) | iOS | NS-13, NS-17, NS-23, NS-25 |
| NS-31 | [Garage — Android](NS-31-android-garage.md) | Android | NS-26 |
| NS-32 | [Video telemetry import — Android](NS-32-android-video-import.md) | Android | NS-14, NS-18, NS-24, NS-26, NS-30 |

### Post-rewrite product changes

Not part of the rewrite programme, and the one place the *`src/` must not
change* rule does not apply — see the spec for why.

| ID | Spec | Platform | Depends on |
|---|---|---|---|
| NS-32 | [Subscriptions (Track Evolution Pro)](NS-32-subscriptions.md) | Shared | NS-25, NS-26, NS-27 |
| NS-33 | [Leaderboards rank only device-timed laps](NS-33-leaderboard-device-timed-laps.md) | Shared | Leaderboards, NS-30, NS-32 |

## Deferred — not in this programme

Available on web throughout, ported to native later or never: the setup notebook,
the setup-vs-lap-times diff, year in review, the **two-event** compare view
(`viewCompare`), and **`.vbo` telemetry file import**.

Three things were on this list and came off it, all for the reason the split
predicts — the work happens where the web app isn't:

- **The garage** (vehicles, parts, wear, measurements) — NS-29 on iOS, NS-31 on
  Android. Deciding whether the pads will last the weekend is something you do
  *at* the car, and that argument was never iOS-specific — it was simply written
  down while iOS was the client being built. Its **analysis** half — the setup
  notebook and the setup-vs-lap-times diff — stays deferred on both platforms,
  and that division is deliberate rather than a stopping point someone ran out of
  time at.
- **Video import** (GoPro and Corvette PDR) — NS-30 on iOS, NS-32 on Android. The
  footage is already on the phone that shot or received it, and the argument was
  never platform-specific. `.vbo` import, which really does arrive on an SD card at
  a desk, stays deferred.
- **The two-lap telemetry compare**
  ([#165](https://github.com/Richie97/track-history/issues/165)) — pick any two
  laps with stored channels at a track and see the delta and channel overlays.
  Built on all three clients at once: the charts it needs (NS-23/NS-24) already
  exist natively, reviewing yesterday's lap against your best happens in the
  paddock, and the reads come through the offline cache. Its pure half is
  `public/js/compare-laps.js`, ported as `CompareLaps` to the Kit and `:core`
  and pinned by `contracts/logic/compare-laps.json`. The *two-event* overlay
  (`viewCompare`) stays web-only — it is a season-review tool, not a paddock one.

## Conventions for every spec

- Lap times are integer milliseconds everywhere; format/parse `m:ss.fff`.
- API errors are `{ error: string }` with a meaningful status; surface that string.
- Ported logic keeps the **same function names and constants** as its JS original
  so the two can be diffed by eye.
- Every ported pure function ports its JS test cases with it, same inputs, same
  expectations.
- Per `AGENTS.md`, documentation changes ship in the same change as the code.

## Tracking: every spec has a GitHub issue

Each `NS-*` spec has an issue whose title matches its heading, under the epic
[#63](https://github.com/Richie97/track-history/issues/63). Find one with:

```sh
gh issue list --search "NS-13" --state all
```

**A PR that lands a spec closes its issue, and that is part of finishing the
work** — not a follow-up. Put the keyword in the PR body so merging does it:

```
Closes #76
```

The discipline is in the other half. A PR that implements a spec **partially**
uses `Refs #78` instead, leaves the issue open, and comments on it saying exactly
what is outstanding. Never close an issue whose acceptance criteria aren't all
met — the checklist in each spec is the definition of done, and a ticket closed
early is worse than no ticket, because the gap stops being visible. If a criterion
turns out to be wrong, change the spec deliberately and say so; don't quietly
drop it.

One PR may close several issues (Phase 0 specs are small and land together);
list one `Closes` line per issue.
