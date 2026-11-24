# NS-57 — Import laps anywhere: the track and the event found from GPS

**Phase:** post-rewrite · **Platform:** Shared (server, web, iOS, Android) · **Depends on:** the importers and recorders, NS-53 (`trace_geo`), the staged-session flow of the New Event form (`sessionsToCreate` / `EventFormSessions`), `track_catalog` and its `length_m` (NS-36) · **Estimate:** 3–4 weeks across four PRs — server + shared logic + web, then iOS, Android, then the catalog start/finish lines · **Issue:** [#483](https://github.com/Richie97/track-history/issues/483) (tickets #484–#487) · **Status:** ticket 1 built

## Goal

A driver drops a card's worth of files — two days at VIR, an afternoon at
Summit Point, a morning somewhere the catalog has never heard of — without
first creating an event or naming a track. The app reads where each file was
driven, names the track, groups the files into events by track and date, and
shows one review to confirm.

```
Import laps (no event picked)
┌────────────────────────────────────────────────────────────────┐
│ 7 files · 3 events found                                       │
│                                                                │
│ Virginia International Raceway (Full) · 14–15 Mar 2026         │
│   New event · 4 sessions · 31 laps · best 2:02.11    [Change]  │
│                                                                │
│ Summit Point (Main Circuit) · 2 May 2026                       │
│   Adds to your event on 2 May · 2 sessions · 14 laps [Change]  │
│                                                                │
│ Which track is this? · 20 Jun 2026                             │
│   No track we know is here. [ Name this track…          ]      │
│   1 session · 9 laps                                           │
│                                                                │
│                                   [ Save 3 events ]            │
└────────────────────────────────────────────────────────────────┘
```

## The facts this spec is built around

**Every GPS source already knows where it was.** Each parser returns the
full `gps` trace (lat / lon) and the file's own `date`, and since NS-53 every
save keeps the trace's anchor as `sessions.trace_geo`. PDR, PDR 2.5, GoPro,
SmartyCam, `.vbo`, Track Precision CSV and a phone recording all qualify.
Hand-typed laps never will.

**The catalog doesn't know where anything is.** `track_catalog` is a name and
(since 0026) a `length_m`. Nothing in the tree maps a coordinate to a track.

**No new write is needed.** `POST /events` already find-or-creates the track
by name (`resolveTrack`, which also links `catalog_id`), and the New Event
form already posts staged import sessions after the event and dates the event
from them. Auto-placement is that flow with the track and the dates filled in
by a match instead of typed — so it inherits the offline queue, temp ids and
the clip hand-off for free.

**Location finds the venue; only length finds the layout.** VIR, Summit
Point, NJMP and Thunderhill each have several catalog rows. Three rows
(MotorSport Ranch, Pocono, Utah Motorsports Campus) have no `length_m` on
purpose, so they can be suggested but never placed unasked.

## Fixed decisions

| | |
|---|---|
| Where matching runs | **On the device**, in a pure module. No coordinate is sent anywhere to be matched; nothing leaves the phone beyond the `trace_geo` a save already carries. |
| Two tiers | **Your own tracks first**, then the catalog. A track you have one anchored session at is a known place, catalog or not — which is how an uncatalogued track is named once and recognised ever after. |
| Never silent | **The review always shows.** A confident match is pre-filled, not pre-saved. A wrong placement pollutes a track's best, its goal and (through `catalog_id`) a leaderboard. |
| Confidence | `exact` — one candidate, length agrees: pre-filled. `choose` — several candidates, or one with no length to check: a picker with the nearest pre-selected, and the group is not saveable until it is confirmed. `none` — a name field. A `choose` may also be *venue only* (`venueOnly`): the place is a venue the catalog knows but the lap fits none of its layouts, so its rows are offered — nothing pre-selected — beside the name field. |
| Never guess a layout | A catalog row with a NULL `length_m`, or two rows at one venue within the length tolerance of each other, is always `choose`. |
| Grouping | By track, then by run of consecutive file dates. A two-day weekend is one event with `days: 2`. |
| Attaching | A group joins an existing event **at the same track** whose day range, widened by one day each side (file clocks are local on some sources and UTC on others), covers the group's dates. Otherwise a new event. **Never** an event at another track, whatever the date. |
| Ties | Two existing events both cover it: the one that started most recently, `pickRecordingEvent`'s rule. |
| New-event fields | Track name (the catalog's exact spelling, so `catalogIdForName` links it), `start_date`, `days`, and the account's default car. Everything else is empty and editable afterwards. |
| Files that need a line | GoPro, plain `.vbo` and recordings locate by venue from the raw trace before any lap exists; the line picker still runs per track group (phase 1–2), and the layout is confirmed only once laps exist. Phase 3 removes the picker where a line is known. |
| The existing doors | Importing from an event page or the New Event form is **unchanged**: the event is the driver's answer and nothing overrides it. On the event page, a file located at a *different* known track gets one warning line beside the existing date warning. |
| Tier | **Free**, as import is. No route here checks entitlement; the NS-32 tier table gets a row saying so. |
| Not placed | A trace that closes no lap (a drive on the road) matches nothing and is offered nothing beyond the existing "no laps found". |

## Server

### Migration `0040_track_catalog_geo.sql`

```sql
ALTER TABLE track_catalog ADD COLUMN lat REAL;   -- centre of the layout's bounding box
ALTER TABLE track_catalog ADD COLUMN lon REAL;
UPDATE track_catalog SET lat = 36.5665, lon = -79.2060 WHERE name = 'Virginia International Raceway (Full)';
-- … one UPDATE per row
```

Hand-curated like 0026: **the centre of that layout's bounding box**, not the
venue's gate or pit lane, read off the circuit's own published map and
commented with the source. Rows at one venue get their own centres (NJMP's
two circuits are a kilometre apart). A wrong coordinate is fixed by a new
migration. The centre is deliberately coarse — a point, not an outline — so
curating fifty-nine rows is an afternoon.

### Routes

- `GET /api/catalog` → each row gains `lat`, `lon`, `length_m` (it selects
  `id, name` today). Still seeded, public data; still cached whole by the
  offline layer, so matching works with no signal.
- `GET /api/tracks` → each of the caller's tracks gains
  `geo: { lat, lon, length_m } | null`: the bounding-box centre and closed
  polyline length of the best-lap trace of the **newest anchored session** at
  that track (one more statement in the route's batch, beside
  `traceDonorForTrackStmt`'s query shape). Computed in `src/lib/geo.ts`
  (`traceCentre`, reusing `polylineLength` from `lib/wrapped.ts`).
- **`geo` is the owner's only.** It is not added to `COACH_ROUTES`' track
  view, the public share, the leaderboard or any MCP tool result. A
  recording can be made anywhere; a track's place is as private as
  `trace_geo`.

No migration touches `tracks`: the place is derived at read time, so an old
logbook gains it the moment one anchored session exists.

### Tests

`test/api/track-geo.test.ts`: the catalog carries coordinates; a track with
an anchored session answers `geo`, one without answers null; a coach's
`/students/:id/tracks`, both share responses and the MCP `list_tracks` result
carry no `geo`. `test/unit/track-catalog-geo.test.js`: every row has a
coordinate inside the contiguous US, and every pair of rows within
`VENUE_RADIUS_M` of each other either has non-overlapping length windows
(`CATALOG_SHORT_TOLERANCE` below, `CATALOG_LONG_TOLERANCE` above) or is listed in an `AMBIGUOUS` table the test owns — so a
new catalog row that makes two layouts indistinguishable fails CI instead of
mis-placing someone's laps.

## Shared pure logic — `public/js/import/locate.js`

Ported as `TrackLocate` to the Kit and `:core` under the same names, pinned by
`contracts/logic/track-locate.json`.

- `OWN_RADIUS_M = 400`, `VENUE_RADIUS_M = 2000`, `LENGTH_TOLERANCE = 0.04`
  (own tracks, either way), `CATALOG_SHORT_TOLERANCE = 0.06` and
  `CATALOG_LONG_TOLERANCE = 0.02` (against a published length — a driven
  best-lap trace runs short of it, never long; `fitsCatalogLength`).
  Own tracks get the tight radius because both sides are measured the same
  way (bounding-box centre of a driven lap); the catalog's is a curated point.
- `recordingPlace(parsed)` → `{ lat, lon, lengthM } | null`. With laps: the
  bounding-box centre of `bestLapTrace` unprojected through `traceGeo`, and
  its closed polyline length. Without laps yet (`needsLine`): the centre of
  the raw `gps` bounding box and `lengthM: null`. Null with no usable fix, on
  `traceOrigin`'s rules. A Racelogic west-positive file is already negated by
  `vbo.js`; a batch item that only fitted through the mirror has no
  `traceGeo` and so no place.
- `locateTrack(place, ownTracks, catalog)` →
  `{ confidence, candidates: [{ source: "own" | "catalog", id, name, distM, lengthOff }] }`.
  Own tracks within `OWN_RADIUS_M` whose length agrees win outright
  (`exact`, even when the catalog also matches — the driver's own name for a
  place stands). Otherwise catalog rows within `VENUE_RADIUS_M`, kept when
  their length agrees or is NULL, ordered by length error then distance. One
  survivor with a length is `exact`; anything else non-empty is `choose`.
  When length rules out every row at the venue, those rows come back as a
  `choose` with `venueOnly: true` (nearest length first) rather than `none`;
  with no row in the radius at all it is `none`. `venueOnly` is on every
  answer and on every group. A catalog row the driver already has a track for is
  returned as that own track.
- `groupImports(items, events)` → the review's cards:
  `[{ track, confidence, candidates, dates: { start, days }, eventId | null, items }]`.
  Items sort by the file's own date and time; a group is one track and one
  run of consecutive dates; `eventId` by the attaching rule above.
- `eventBodyFor(group, defaultCar)` → the `POST /events` body.

The fixture's rows are chosen for the ways a port goes wrong: a place exactly
on each radius (both bounds inclusive), a length exactly at tolerance, two
layouts at one venue, a NULL-length row alone, an own track beating a
catalog row, a weekend across a month end, and a file dated the day after
its event by a UTC clock.

## The review

One new entry, **Import laps**, with no event chosen:

- **Web:** a button beside *+ Add event* on the dashboard and on the
  first-run welcome card, opening the dropzone on a page of its own
  (`#/import`). `bindTelemetryImport` gains an `auto` mode alongside
  `onSessions`: after parsing, `groupImports` replaces the single-event
  review with one card per group.
- **iOS / Android:** the dashboard's import door and the share-sheet import
  open the importer with no event (`Route.importVideo(eventId: nil)` /
  `Route.Import(null)`); the review's event picker is replaced by the group
  cards. The picker stays reachable per card through *Change*.

Each card shows the track, the dates, whether it is a new event or joins an
existing one, the session and lap counts and the best lap. *Change* opens the
candidates, the driver's other tracks and a free-text name. Saving posts, per
group and in date order, the event (when new) and then its sessions through
the existing staged-session code path; a group that fails keeps its card with
the error and the rest still save. Clips follow their sessions exactly as on
the New Event form.

A `choose` or `none` group must be answered before *Save* enables for it; the
other groups can be saved without it.

## Phase 3 — the start/finish line, found too

GoPro, plain `.vbo` and phone recordings need a picked line. Two sources can
supply one:

1. **Your own earlier session there.** A stored best-lap trace begins at the
   line crossing, so its first point and heading, unprojected through its
   `trace_geo`, rebuild a gate with `buildGate`. `GET /api/tracks`' `geo`
   gains `sf: { lat, lon, heading }` from the same session. *(To confirm in
   the ticket: that every source's `lapTrace` starts at the crossing, not at
   the nearest fix.)*
2. **The catalog.** `track_catalog` gains `sf_lat`, `sf_lon`, `sf_heading`,
   curated per row.

With either, the review applies the line unasked, says *"Start/finish from
your last session here"* or *"…from the track's official line"*, and keeps
*Pick a different line*. The layout check then runs on real laps.

## Docs owed (in the same PRs)

`README.md` (import, the catalog, the routes), `AGENTS.md` (`locate.js`, the
migration, the routes, the ports), `site/docs/telemetry-import.html` and
`site/docs/index.html` (the new way in), the six per-source pages' browser
and phone steps where they say "open an event first" — which owes
`npm run site:howto` — `site/llms.txt`, the landing page's features grid
(and so `npm run landing:generate`), the NS-32 tier table, and the privacy
policy only if its wording on location needs it: matching is on-device and no
new data is stored.

## Tickets

1. **Server + shared logic + web.** Migration `0040`, the two route
   additions, `src/lib/geo.ts`' `traceCentre`, goldens (`catalog`, `tracks`)
   and both native models decoding the new fields; `locate.js`, its unit
   tests and `contracts/logic/track-locate.json`; the web's `#/import` and
   grouped review; the event page's wrong-track warning. Sources with their
   own lap timing place fully; line-picker sources place by venue.
2. **iOS.** `TrackLocate` in the Kit pinned by the fixture; the event-less
   importer and grouped review; a UI test over two fixture clips at two
   anchors.
3. **Android.** The same in `:core` and `:app`, with a Robolectric test of
   the grouped save's request order.
4. **Start/finish lines.** Phase 3 on all three clients, after the catalog's
   lines are curated.

Tickets 2 and 3 are independent of each other; 4 follows all three.

## Acceptance criteria

- Seven files from two catalog tracks and one unknown place, dropped with no
  event, produce three cards; saving creates the events with the right
  tracks, dates and `days`, and every session lands in its own.
- A file dated inside an existing event at the matched track joins that
  event; one dated the same day as an event at another track does not.
- A lap at a multi-layout venue is pre-filled only when its length singles
  one layout out; otherwise it asks.
- A track named once in the review is pre-filled the next time, with no
  catalog row.
- Airplane mode with a cached catalog: the review groups and names
  correctly, and the saves queue and replay in order.
- No request carries a coordinate other than the `trace_geo` on a session
  save, and no coach, share or MCP response carries a track's `geo`.

## As built (ticket 1)

- **`choose` lists, it does not pre-select.** The card's picker opens on
  *Pick the track…* with the candidates first; a pre-selected layout the
  driver has to notice is the silent guess this spec exists to avoid.
- **A file waiting for its line is not in a group yet.** The review draws one
  line picker per venue (files within `VENUE_RADIUS_M` of each other share
  one), and a file joins the cards once its line gives it laps and so a
  length.
- **An unknown place is named once per review**: the name goes to every date
  at that place, not only the card it was typed on.
- **Attaching prefers a real cover over slack.** An event whose days contain
  the file's date wins; the one-day slack is consulted only when none does
  (`eventForDate`), so a file on Saturday never lands in Sunday's event.
- **Attaching is per file.** Files that join an existing event form that
  event's card; the rest group by track and consecutive dates.
- **The catalog's coordinates are OpenStreetMap's.** Migration `0040` holds
  the centre of the bounding box OSM has for each circuit or its venue. Seven
  rows have no object of their own there (both NJMP circuits, Summit Point
  Shenandoah, both Thunderhill courses, VIR North and South) and sit inside
  the venue OSM does map; layouts are told apart by length, so a point only
  has to fall within `VENUE_RADIUS_M`.
- **The radii and tolerances were tried on real footage** (the 239 files in
  `telemetry-samples/`: SmartyCam, Corvette and Cadillac PDR, Track Precision
  VBO and CSV, at nine venues). Every file with laps was placed at the right
  venue and none at a wrong track. Two things changed because of it. A
  best-lap trace measured 0.7–4.0 % *short* of the catalog's length at every
  venue and never long — Sebring passed the symmetric 4 % by under a metre —
  so the catalog tolerance became 6 % short / 2 % long; the closest pair of
  layouts at one venue (Summit Point Main / Shenandoah, 9.1 % apart) still
  separates. And Mid-Ohio's 2.258-mile course, 139 m from the catalog's
  2.4-mile row, came back as `none`: a venue whose every layout the length
  rules out is now a venue-only `choose`. Own-track matching had room to
  spare (centres within 11 m of each other against 400 m, lengths within
  2.6 % against 4 %). The committed fixtures are 1.9 km synthetic circles
  near VIR, which fit no catalog layout.
- **Not changed, seen in the same run:** a file dated the day after an
  event's last day joins it through the one-day slack without extending the
  event's `days`.
- `GET /api/catalog`'s shape changed (it was pinned to `{ id, name }` by
  0026's test); both native models decode the new fields.
- Not built: the *looks already imported* warning, and the landing page's
  features grid, which waits for the phones.

## As built (tickets 2–4)

- **The line comes from the driver's own last session there — and only from
  there.** `geo` on `GET /api/tracks` gains `sf: { lat, lon, heading }`
  (`startFinish` in `src/lib/geo.ts`): the stored best lap's first point,
  unprojected, and the heading to the first point 15 m on. Checked first:
  every parser's stored trace is `lapTrace(trace, best.startT, best.endT)`,
  whose first point is the first fix at or after the crossing, so it sits on
  the timing line to within one fix. **The catalog half is not built**: no
  `sf_*` columns were added, because there is no curated line to put in them
  and an empty column is not a feature. A venue the driver has never timed
  still asks for a click, once.
- **A known line is tried, then checked.** `knownLines(place, ownTracks)`
  offers every own track within `VENUE_RADIUS_M` that has an `sf`, nearest
  first; `gateFromSf` rebuilds the gate in the file's own frame (direction
  filter included, so a day driven the other way finds no laps);
  `lineFits` keeps it only when the laps it cuts locate `exact` to that same
  own track. A line from another layout at the venue cuts laps of the wrong
  length and is dropped, and the picker asks as before. The picker stays, and
  a tap replaces the line.
- **On an event's own page too**, on all three clients: a file waiting for a
  line on an event whose track has one is timed without a click, under the
  same check. Changing the event in the phone's picker afterwards does not
  re-try it.
- **Android (ticket 3).** `TrackLocate` in `:core` under the JS names, its
  inputs three small interfaces the models implement (`OwnTrack`,
  `CatalogRow`, `EventRow`), pinned by `TrackLocateTest`. `Route.Import()` with
  no event — the dashboard's and the welcome card's new *Import laps*, and
  files shared into the app — begins `RecordingFlow` with `auto = true`: one
  `VenuePicker` per venue, `groups` from `groupImports`, and a save that is
  `POST /events` then its sessions per group. `GroupedImportTest` pins the
  request order, the retry onto an event already made, and the known line;
  `GroupedReviewScreenTest` the cards.
- **iOS (ticket 2).** `TrackLocate` in the Kit, its inputs three small
  structs built from the models, pinned by `TrackLocateTests` — which was run
  on Linux against a Foundation-only subset of the Kit. The app half
  (`ReviewModel`'s `auto` mode, the cards in `ReviewScreen`, the dashboard's
  *Import laps*) mirrors Android's and **has not been compiled or run**: there
  is no Xcode here. The UI test the ticket asks for is not written.
- **The phones' cards list the candidates and a name field**, not the web's
  select with the driver's other tracks under it; typing an own track's name
  still joins it (`groupImports` matches names).
- **A grouped save lands on the event when there is one, the dashboard when
  there are several** (Android); iOS dismisses the importer.
- The phones' `LinePicker` draws no marker for a line nobody tapped; the
  sentence above it is what says where it came from.

## Open questions

- **A genuine extra day and the date slack.** The slack exists for file
  clocks, but a file that really is from the next day joins a shorter event
  without lengthening it. Extend `days`, or leave it to the driver?
- **Re-importing the same file** creates a duplicate session today, on every
  door. An event-less import makes that easier to do by accident; a
  "looks already imported" warning (same lap list in that event) may belong
  in ticket 1.
- **Catalogue beyond the US.** The matching has no US assumption; only the
  seed and the unit test's bounds do.

## Follow-ups, deliberately not here

- A reference outline per catalog row, which would separate layouts of
  similar length and catch a reversed-direction day.
- Placing the live recorder's session at Stop with no event that day (it
  records unattached today and is offered to the next event opened).
- Suggesting a catalog row for an existing free-text track from its anchor.
