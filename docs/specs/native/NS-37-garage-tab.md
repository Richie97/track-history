# NS-37 — The Garage tab

**Phase:** post-rewrite · **Platform:** Shared (web, iOS, Android; no server change) · **Depends on:** NS-29 / NS-31 (the native garage), NS-32 (tier), NS-34 (large screens), the car catalog (#221 / #222), track-day costs (#147) · **Estimate:** 7–9 days across three PRs, one per client, web first

## Goal

The garage becomes the other half of the app rather than a section at the
bottom of the dashboard. On both phones the signed-in shell is **two tabs** —
**Events** (today's dashboard: the next event, the recorder, the tracks) and
**Garage** (the cars, and for Pro what they need and what they cost). The web
gets the same split as two top-bar links. Every account can open the Garage,
add a car from a **+ Add car** tile, and see that car's logbook; maintenance
and cost tracking stay Pro, and a free account sees them *locked* in place
rather than not at all.

```
┌──────────────────────────────┐
│ Garage                    ⋯  │
│ ┌──────────┐ ┌──────────┐    │
│ │ C8 Z51   │ │ Miata ND │    │
│ │ Default  │ │          │    │
│ │ 14 days  │ │ 3 days   │    │
│ │ last VIR │ │ last NCM │    │
│ │ ● pads   │ │          │    │   ← Pro: worst part's status
│ └──────────┘ └──────────┘    │
│ ┌──────────┐                 │
│ │  + Add   │                 │
│ │   car    │                 │
│ └──────────┘                 │
├──────────────────────────────┤
│   ⚑ Events       🚗 Garage ②  │   ← badge: parts due (Pro)
└──────────────────────────────┘
```

## Why

**Today a free account never sees the garage.** The dashboard's garage cards
and maintenance strip are built from `GET /api/garage`, which is Pro
(`requireEntitlement`), and the 402 is swallowed on purpose so a garage failure
cannot take the dashboard down. For a free account that means the section is
simply absent; their cars exist only as a list in Settings → Vehicles, and
tapping one opens a page that is a paywall from top to bottom. So the garage
has no front door for the users it is meant to convert, and for Pro users it is
a strip under the tracks.

The tier line needed for a free garage already exists on the server — the
vehicle list is free (`GET /vehicles`, NS-32's table), and everything a free
car page would show beyond it is the driver's own logbook, which is free. This
spec is a **client** change on all three clients and no change to `src/`.

## Fixed decisions

| | |
|---|---|
| Shell | **Two tabs on both phones**, *Events* then *Garage*, at every width. Settings stays in the account menu, not a third tab. The web gets **two top-bar links** (`#/` and `#/garage`), since a tab bar on a web page is a mobile imitation. |
| Tier | **Free:** the Garage tab, the car tiles, **+ Add car**, the car form (catalog pick, wheelbase, steering ratio, target hot psi, default), and each car's logbook summary (track days, events, last and next event, best lap per track in this car). **Pro:** hours, parts, wear, measurements, refresh, the maintenance strip and the tab badge, the measured steering ratio, and **every cost roll-up**. |
| Costs | **Entry stays free** — the four line items on the event form, and the event page's own total of them, which is the driver's typing added up. **Totals across events are Pro**: per car (already, via `/garage`), per track (the track page's *"$N spent"*, which is free today and becomes Pro), per season (year in review, already Pro). A write route never checks entitlement, so gating the form was never on the table; this is the line that leaves free events carrying cost data a Pro upgrade can roll up later. |
| Where the free car data comes from | **The client**, from `/vehicles` and the already-cached `/events` — no new endpoint, no response-shape change, works offline. Rows match on `events.vehicle_id` (auto-matched by name server-side). Past events only, on the totals' rule. |
| Hours are Pro | A free tile does **not** show hours. `eventHours` lives in `src/lib/wear.ts` and arrives computed on `/garage`; computing it on the client for free tiles would make a fifth copy of the wear math, which NS-29 / NS-31 refused for good reason. |
| Locked, not missing | Every Pro section of the Garage renders **in place and locked** for a free account (`proPanelHtml` / `ProUpsellCard` / `LoadState.Paywall`), never skipped — the same rule Wrapped's locked cards follow. The car page stops being a paywall as a whole. |
| Settings → Vehicles | **Removed on all three clients**, replaced by one row linking to the Garage. A car is managed in one place. |
| New Pro decision | Cost roll-ups get their own predicate, **`canViewSpend`**, in `public/js/entitlement.js` first, then both ports, then `contracts/logic/entitlement.json` — per AGENTS.md, even though neither phone shows a roll-up yet (costs are web-first). It is a **client-only** gate: the line items are free data on `/events`, and a roll-up is a convenience over them, not a protected field. |
| Web-only stays web-only | Width and tabs reopen nothing: the setup notebook, year in review and cost *entry* stay where the README puts them. |

## Requirements

### 1. Shared pure logic (ticket 1, web; ported in 2 and 3)

In `public/js/garage.js`, beside the catalog helpers, ported to the Kit and
`:core` as the same names on `Garage`:

- **`vehicleLogbook(vehicleId, events, today)`** →
  `{ track_days, events, last_event, next_event, bests }`.
  `track_days` sums `days` over past events (`start_date <= today`, UTC, the
  `userTotals` rule); `events` counts them; `last_event` / `next_event` are
  `{ id, track_id, track_name, start_date }` or `null`; `bests` is one row per
  track `{ track_id, track_name, best_ms, event_id, start_date }` using each
  event's computed `best_ms` (the `withComputed` rule, so a manual best counts),
  ordered by most recent event at that track, tracks with no time dropped.
- **`vehicleTileLine(logbook)`** → the tile's one line: *"14 track days · last
  at VIR (Full)"*, *"1 track day · last at NCM"*, *"Next: Road Atlanta, 12 Oct"*
  when the car has only an upcoming event, *"No track days yet"*. Pinned
  because three clients write it.

In `public/js/entitlement.js`: **`canViewSpend(entitlement)`**, answering what
`isPro` does today, named for the decision.

Fixtures: `contracts/logic/garage-logbook.json` (new) and the
`entitlement.json` row. The logbook fixture's events are chosen for the ways a
port goes wrong: a multi-day event (days, not events), an event dated today
(past, per the rule), an event with a manual best faster than its laps, an
event for another vehicle, one with `vehicle_id: null` whose `car` text matches
the name (must **not** count — the server did the matching), and two tracks
whose most recent events tie on date (order by event id).

### 2. Web (ticket 1)

- **Top bar:** *Events* and *Garage* links after the brand, the current one
  marked `aria-current="page"`; *Garage* carries the due-parts count for Pro
  (`garageAlerts`, already pinned) as a badge with a spoken label ("2 parts
  due"). The links collapse to the same two words at 375 px — no hamburger.
- **`#/garage`:** the maintenance strip (Pro; locked for free) and a card grid
  of cars — name, catalog label, *Default* marker, `vehicleTileLine`, and for
  Pro the hours and the worst part's status line — ending in the **+ Add car**
  tile, which opens the existing add form with `bindCatalogPicker` inline.
  With no cars the tile is the only card and carries one sentence about what the
  garage does. Offline, the tile is disabled with *"Adding a car needs a
  connection"*, since vehicle writes are off `QUEUEABLE`.
- **`#/vehicle/:id` for a free account:** loads `/vehicles` + `/events`; shows
  the header, *Track days / Events / Last event* tiles, the **best in this car**
  table, and the *Edit car* form; the consumables, *Hours*, *Spent* and the
  measured-ratio line render as locked panels. For Pro it is today's page plus
  the logbook tiles and the bests table.
- **Dashboard:** loses the garage cards and maintenance strip. The next-event
  hero gains one line when the event's car has a due or low part (Pro):
  *"Front pads due on the C8"*, linking to the car.
- **Settings:** the Vehicles section becomes a single *Cars are in the Garage →*
  row. The event form's hint ("manage cars in Settings → Vehicles") points at
  the Garage.
- **Track page:** the *"$N spent"* suffix renders only when `canViewSpend`.

### 3. iOS (ticket 2)

- **Shell:** `RootView`'s signed-in content becomes a
  `TabView(selection: $router.tab)` of two tabs, **each holding today's shell**
  — `stackShell` below expanded width, `splitShell` at it — so NS-34's rules
  apply per tab unchanged: *Events*' list pane is the dashboard, *Garage*'s is
  the garage list, and the detail placeholder in Garage reads *"Pick a car"*.
  iOS 17 is the deployment target, so this is the plain tab bar (bottom, at
  every width); `.sidebarAdaptable` is iOS 18 and is not used.
- **Router:** `AppRouter.path` becomes one path per tab (`paths[.events]`,
  `paths[.garage]`) plus `tab`. `Route.tab` names each route's home —
  `.vehicle` → garage, every event/track/session/leaderboard route → events,
  `.settings` → `nil` (pushed onto whichever tab is showing). `show` /
  `open` / deep links switch the tab first, so `/vehicle/:id` and a share link
  land in the right place at every width. `remapTempIds` walks both paths.
  `.id(route)` keying and `measuringPaneWidth()` stay on `destination(_:)`.
- **Above the tabs:** the recording and sync banners, the review, and
  `presentFullWindow` (recorder, importer, Wrapped) sit **outside** the
  `TabView`, so they span the window and a tab switch cannot bury an unsaved
  session — NS-18's rule, now with a second way to break it.
- **Garage tab** (`App/Screens/GarageScreen.swift`, new): the strip, a
  `TECardGrid` of `GarageCarTile`s, the **+ Add car** tile presenting the
  existing add form with `CatalogCarPicker` — the form's one `.sheet`, so the
  screen's other modals hang off buttons (one presentation per view). The model
  fetches `/vehicles` and `/events` for everyone and `/garage` alongside;
  a `proRequired` from `/garage` sets `pro = false` and the Pro halves render
  `ProUpsellCard`, rather than the whole screen going to `.paywall`.
- **Car page:** `VehicleModel` stops mapping a 402 to `.paywall` for the whole
  screen (`VehicleScreen.swift:721`) and loads the free half first; the locked
  sections sit where their content would.
- **Badge:** `.badge(dueCount)` on the Garage tab from `Garage.garageAlerts`,
  Pro only, 0 hides it.
- **Settings:** the Vehicles section and its delete confirmation move to the
  car page (delete lives on the car it deletes); Settings keeps one row.
- **Mac:** unchanged rules — the Garage tab is fine on a Mac; *Record laps* is
  still absent from the Events tab via `dashboardOffersRecorder`.
- **UI tests:** `GarageUITests` gains a free-tier pass (`POST
  /auth/dev/entitlement` clearing the tier) asserting the tab, the tile, add-a-car
  and the locked panels; `TwoPaneUITests` asserts the Garage tab's split at
  expanded width with the same column-ends-at-the-window invariant.

### 4. Android (ticket 3)

- **Shell:** `NavigationSuiteScaffold`
  (`androidx.compose.material3:material3-adaptive-navigation-suite`, added to
  `libs.versions.toml` on the `material3Adaptive` version) around the existing
  `SignedInScaffold` content — a bottom bar at compact width and a **rail** at
  medium and expanded, chosen by the library from the window's adaptive info.
  A phone in landscape (an expanded window on this platform, per NS-34) gets
  the rail; that is Material's behaviour and costs nothing.
- **Graph:** two nested graphs, `EventsGraph` (start `Route.Dashboard`) and
  `GarageGraph` (start `Route.Garage`, new), switched with
  `popUpTo(startDestination) { saveState = true }; launchSingleTop = true;
  restoreState = true` so each tab keeps its stack. `routeFor` (the `DeepLink`
  mapping) chooses the graph; `FollowTempIds` and `remapTempId` cover both.
- **Back:** at the Garage root, back selects Events; at the Events root it
  `moveTaskToBack`s as today (a recording notification may hang off the task).
- **Two panes:** each tab's list-detail runs through `TwoPaneShell`; Garage's
  placeholder reads *"Pick a car"*. The recorder, importer and Wrapped still
  drop the scaffold — **and the navigation suite** — to one pane.
- **Garage tab** (`screens/GarageScreen.kt` + `GarageModel.kt`, new, scoped to
  the back-stack entry via `rememberScreenModel`): as iOS, with
  `CatalogCarPicker` in the add dialog; a `PaymentRequired` from `/garage`
  locks the Pro halves (`ProUpsell`), not the screen. `VehicleModel`'s
  whole-screen `LoadState.Paywall` (`VehicleModel.kt:85`) goes the same way.
- **Badge:** the suite item's `badge` from `Garage.garageAlerts`, Pro only.
- **Settings:** as iOS; the delete dialog moves to the car page with its
  saveable part-id pattern (NS-34 ticket 4) reused for the vehicle id.
- **Tests:** `GarageLogbookTest` against the fixture, a Robolectric
  `GarageTabTest` (free: tile, add, locked panels; Pro: badge), and
  `TrackCompareLayoutTest`-style wiring checks that a Garage deep link lands in
  the Garage graph at compact and expanded width.

## Offline

Nothing new is queueable. The Garage tab reads offline from cached `/vehicles`,
`/events` and `/garage`; adding, editing and deleting a car still need a live
server and say so (the + Add car tile disabled offline, with the sentence, on
all three). The logbook summary works offline because it is computed from
cached events, which is the reason it is computed on the client.

## Docs owed (in the same PRs)

- **NS-32's tier table:** split the *vehicle list* row into the free Garage
  rows above, and add *Cost roll-ups (per track, per car, per season)* as Pro,
  enforced *client: `canViewSpend`; server: `/garage` for per-car*.
- **`docs/specs/native/README.md`:** the index row, and the split's note that
  the garage is on all three with a free half.
- **`AGENTS.md`:** the `#/garage` route, `vehicleLogbook` / `vehicleTileLine`
  in the `garage.js` bullet, `canViewSpend` in the `entitlement.js` bullet, the
  tab shells in the iOS/Android and NS-34 notes, and the removal of *Settings →
  Vehicles* wherever it is named (the `#/settings` route description included).
- **`README.md`** and **`site/docs/garage.html`**: the Garage tab, what is free
  and what is Pro, and the new place cars are added. `site/index.html`'s
  features grid if it describes the garage as Pro-only.

## Tickets

1. **Web + shared logic** — requirement 1 and 2, the two fixtures, the docs.
   Lands first; both ports assert against it.
2. **iOS** — requirement 3, the Kit ports (`Garage.vehicleLogbook`,
   `vehicleTileLine`, `Entitlement.canViewSpend`) with their JS test cases.
3. **Android** — requirement 4, the `:core` ports likewise.

## Acceptance criteria

- [ ] `vehicleLogbook`, `vehicleTileLine` and `canViewSpend` exist on all three clients under those names; `contracts/logic/garage-logbook.json` and the `entitlement.json` row are committed and both ports assert against them; `npm run contracts:check` is clean.
- [ ] A **free** account on every client can open the Garage, add a car through the catalog picker, see its tile line, open it, and see the logbook tiles and best-in-this-car table; every Pro section is visible and locked.
- [ ] A **Pro** account sees everything it sees today, the tab badge / top-bar count, and the hero card's due-part line; the dashboard no longer carries garage cards or the maintenance strip on any client.
- [ ] The track page's spend figure appears only for Pro; the event form's cost entry and the event page's own cost tile are unchanged for free.
- [ ] Settings on all three has no Vehicles section, only a link to the Garage.
- [ ] Deep links (`/share/<slug>`, `/vehicle/:id` where a client supports it) land in the right tab at compact and expanded width; temp-id remapping follows a destination on either tab.
- [ ] The recording banner, sync banner and review overlay span the window over both tabs; switching tab mid-recording never loses an unsaved session.
- [ ] At expanded width each tab is list-detail, and the Garage split's right column ends where the window ends (iPad portrait and landscape, a 1200dp tablet).
- [ ] No change under `src/`; `npm test`, `npm run typecheck`, `swift test`, the iOS app and UI suites named above, `:core:check` and `:app:testDebugUnitTest` pass.

## Verification

```sh
npm test && npm run typecheck && npm run contracts:check
cd apps/ios/Packages/TrackEvolutionKit && swift test
cd apps/android && ./gradlew :core:check :app:testDebugUnitTest
npm run dev   # then both tiers via POST /auth/dev/entitlement, on web, an iPhone, an iPad and a tablet emulator
```

## Notes

**Why tabs and not a bigger garage section.** The dashboard is already long —
hero, stat tiles, tracks — and the garage was losing to the fold on every
phone. A tab also gives the garage somewhere to say *"2 parts due"* without
taking dashboard space from a driver who doesn't track wear.

**Why the free half is on the client.** Everything in it is derivable from
`/events`, which every client already caches, and a server endpoint would be a
new golden, a new decode model on each phone, and something that fails offline.
The one tempting server field — free hours — is exactly what isn't done, for
the wear-math reason above.

**What this leaves for later.** A car photo on the tile (needs storage the app
doesn't have); cost entry on the phones (#147 graduates it when the web has
proven it — `canViewSpend` is ready for it); a third *Settings* or *Profile*
tab if the account menu outgrows itself.
