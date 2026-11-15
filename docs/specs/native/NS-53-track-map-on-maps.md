# NS-53 — The racing line on a real map

**Phase:** post-rewrite · **Platform:** Shared (server, web, iOS, Android) · **Depends on:** the importers and recorders (`geo.js` / `Geo` / `GeoTrace`), `trackmap.js` / `TrackMap`, NS-35 (leaderboard lap), NS-38 (coach allow-lists) · **Estimate:** 3–4 weeks across four PRs — server + shared logic, then iOS, Android, web · **Issue:** [#453](https://github.com/Richie97/track-history/issues/453)

## Goal

The best-lap trace, drawn today as a line on an empty card, opens on a real
map: satellite imagery of the circuit with the speed-painted line laid over
the tarmac it was driven on. The driver pans, pinches to zoom, rotates, and
taps the line to read the speed there.

```
Event page (unchanged card)                 Map viewer (new, full window)
┌──────────────────────────────┐            ┌──────────────────────────────────┐
│ Best lap · 2:02.11      [⤢]  │            │ ‹ Back     VIR (Full) · 2:02.11  │
│      ╭───────╮               │            │ ░░▒▒▓▓ satellite imagery ▓▓▒▒░░  │
│   ╭──╯       ╰──╮            │   [⤢]      │ ░░ ╭━━━━━━╮ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒░░  │
│   │    ◆        │            │  ─────▶    │ ▒━━╯  ◆   ╰━━╮ ▓▓▓  ● 142 mph    │
│   ╰─────┬───────╯            │            │ ▒┃   paddock  ┃▓▓▓    1,240 m    │
│         S/F                  │            │ ░╰━━━━━┳━━━━━━╯▒▒░░░░░░░░░░░░░░  │
└──────────────────────────────┘            │ [Satellite|Map|Line]   [◎ Fit]   │
                                            │                    © Apple/Google│
                                            └──────────────────────────────────┘
```

## The fact this spec is built around

**A stored trace has no position on Earth.** `sessions.trace` is
`[x, y, v]` in local metres (`sanitizeTrace`), produced by
`projectTrace(points, origin)`, and the origin is thrown away at save. It is
not even the same point from source to source: `gps[0]` for a PDR, a
recording and a Track Precision CSV, the *first file's* first fix for a batch
that shares a line pick (`state.origin` in `js/import/ui.js`), the file's own
origin for a `.vbo`. Nothing in the tree links a map SDK either.

So the work has three parts, in this order: **keep the origin** on new
sessions, **recover one** for the sessions already in a logbook, and only
then **draw**.

## Fixed decisions

| | |
|---|---|
| Map provider | **iOS: MapKit. Android: Google Maps SDK. Web: MapKit JS.** One provider per platform, no user choice. |
| Why MapKit JS on the web | Its free tier (250,000 map loads a day with the developer membership the iOS app already needs) is far past this app's reach, and its token is an ES256 JWT the Worker can already sign (`signES256` in `lib/apple.ts`). Google Maps JS bills per load past a small monthly allowance and puts a billing account behind a public page. |
| Where the map is | **A full-window viewer**, opened from the track map card. The inline card stays the drawn canvas, unchanged, on every client. |
| Why not inline | An interactive map inside a scrolling page fights the page for every one-finger drag, and on the lap stage the card is redrawn per video frame, which a map view cannot be. A map in a `List` row on iOS is the hazard `LapChannelChart` documents. The viewer owns its gestures outright. |
| Gestures | Drag to pan, pinch to zoom, two-finger rotate, double-tap to zoom in, two-finger tap to zoom out. **No pitch**: a tilted camera bends the line's speed colours away from the reader. Web adds wheel / trackpad pinch, `+` `-` and arrow keys. |
| Map types | **Satellite** (default), **Map** (the provider's standard style, following the app theme), **Line** (no tiles: the line on `--bg-page`). Remembered per device. |
| What is drawn | The speed-painted line with a dark casing, the start/finish tick, a direction arrow, and the limit markers when the page that opened the viewer had them. Tapping the line reads speed and driven distance at that point. |
| One line | The viewer draws **one trace**: the session's best lap, the only lap a session stores a line for. Two lines at once is a follow-up. |
| Anchor | New column `sessions.trace_geo`, `{ lat, lon }`: the origin the trace was projected from. Sent by the client beside `trace`. |
| Old sessions | **Borrow** an anchor at read time from the owner's newest anchored session at the same track, by matching bounding-box centres, flagged `approx: true`. No backfill migration, no re-import. |
| Bad anchor | An implausible `trace_geo` is **stored as null, never a 400**. The session is the irreplaceable thing; a map backdrop is not worth refusing one. |
| No anchor | The viewer still opens, in **Line** mode with the other two disabled and one sentence saying why. |
| Tier | **Free.** The trace is free; where it lies is not analysis of it. No route here checks entitlement. |
| Privacy of the anchor | An anchor is a real coordinate. It goes to the **owner**, an invited **coach**, and on a **leaderboard lap** (always a catalog circuit). It is **never** on the public share page, the one-item share (NS-48) or the MCP tools in v1. |
| My-location | **Off, on every platform.** The viewer never asks for or shows the device's position. It adds no permission prompt. |
| Offline | The viewer opens from the cached event. Tiles the SDK has cached draw; otherwise Line mode and *"Map imagery needs a connection."* |
| Third-party load | Nothing is fetched from Apple or Google until the viewer is opened (the promo poster's click-to-load rule). The web loads MapKit JS on first open, never from `index.html`. |

## Server

### Migration `0037_session_trace_geo.sql`

```sql
ALTER TABLE sessions ADD COLUMN trace_geo TEXT;  -- JSON {"lat":..,"lon":..} or NULL
```

Plain and route-set, no trigger: it is not derived from another column. It
rides the session's existing `updated_at` bump on insert.

### `src/lib/geo.ts` (pure, unit-tested)

- `sanitizeTraceGeo(v, trace)` → `{ lat, lon } | null`. Null when `trace` is
  null, when `v` is not an object of two finite numbers, when `|lat| > 85` or
  `|lon| > 180`, or when both are within 0.01° of zero (an unset GPS reports
  0, 0). Rounded to 7 decimals (about a centimetre). **Never `undefined`**:
  there is no 400 path.
- `KX(lat) = 111320 · cos(lat)`, `KY = 110540`: `projectTrace`'s constants,
  restated. **The inverse must use the same two numbers.** They are
  approximations, but the projection is then its own exact inverse, so a
  point comes back to within the trace's 0.1 m rounding. Substituting a
  "more correct" metres-per-degree figure moves the far end of a 5 km lap by
  about 7 m and fails no test that does not pin it.
- `traceCentre(trace)` → `[cx, cy]`, the bounding box's centre.
- `borrowAnchor(trace, donorTrace, donorGeo)` → `{ lat, lon, approx: true }`:
  the origin that puts `trace`'s bbox centre on the donor's, i.e. the donor's
  centre unprojected, then stepped back by `trace`'s own centre. Null when
  the two bounding boxes differ by more than `BORROW_MAX_MISMATCH` (15 %) in
  either dimension, which is a different layout or a partial lap, not this
  track.

### Routes

- `POST /events/:id/sessions` reads `trace_geo` from the body and stores
  `sanitizeTraceGeo(body.trace_geo, trace)`. A shipped client that sends none
  stores null.
- `GET /events/:id`: each session gains `trace_geo` (`{ lat, lon }`,
  `{ lat, lon, approx: true }` or null). One statement joins the detail's
  existing `db.batch`: the caller's newest session at this event's track with
  a non-null `trace_geo` (`trace`, `trace_geo`). Sessions with a trace and no
  anchor get `borrowAnchor` from it. No donor, no extra work.
- **Coach mount:** `trace_geo` joins `COACH_SESSION_FIELDS`. The donor
  statement runs as the student, like everything else under the mount.
- **Leaderboard lap** (`GET /tracks/:id/leaderboard/laps/:lapId`): the entry
  gains `trace_geo`, copied by `publicLapChannels`' allow-list, stored or
  borrowed from that owner's own sessions.
- **Not carried:** `sharedEvent` (NS-48) and the public share send no
  `trace_geo`; `test/api/share.test.ts` and the item-share test assert its
  absence. The logbook export includes the stored value (it is the owner's
  data) and never a borrowed one.
- `GET /api/map-token` (web only; ordinary `/api` router, in `API_ROUTERS`
  with no gate, not in `COACH_ROUTES`): `{ token, expires_at }`, a MapKit JS
  JWT (`alg` ES256, `kid` = `MAPKIT_KEY_ID`, `iss` = `APPLE_TEAM_ID`, `iat`,
  `exp` = now + 30 min, `origin` = the request's own origin; the `origin`
  claim is left out on a dev host). 404 when `MAPKIT_KEY_ID` or
  `MAPKIT_PRIVATE_KEY` is unset, so the web **ships dark** like Stripe and
  YouTube. Rate limit `MAP_TOKEN`, 20 a minute per user, through
  `withinLimit`. `no-store`; `sw.js` skips the path.
- `GET /me`: `user.maps = { web: boolean }`, the `user.youtube.available`
  pattern. Both native `User` models decode it and read nothing from it.

### Tests

`test/unit/geo-anchor.test.ts` (round trip to 0.1 m at 0°, 37° and 60°
latitude; the null rules; `borrowAnchor` on a shifted copy, a mirrored copy
and a different layout). `test/api/trace-geo.test.ts`: stored and returned;
an implausible one saves the session with null; a borrowed anchor carries
`approx`; another user's anchored session at a same-named track is never the
donor; coach sees it, both public shares do not; the token route's claims,
its 404 without secrets, and its rate limit. Goldens: the rich event's
session gets an anchor and a second one borrows, so both native `Session`
models decode both shapes.

## Shared pure logic (web first, then ported)

`public/js/import/geo.js` gains, and the Kit's `Geo` and `:core`'s `GeoTrace`
port under the same names, pinned by a new `contracts/logic/geo-anchor.json`:

- `traceOrigin(gps, origin)` → the `{ lat, lon }` a save sends: the origin
  `projectTrace` was called with, null when it is not a real coordinate. The
  parsers set it as `traceGeo` beside `bestLapTrace`, and the three parser
  fixtures (`video-parsers.json`, `vbo-parsers.json`, `csv-parsers.json`) pin
  it for the ports.
- `unprojectTrace(trace, geo)` → `[{ lat, lon, v }]`.
- `traceGeoBounds(trace, geo)` → `{ south, west, north, east }`.
- `nearestOnTrace(trace, x, y, maxM)` → `{ idx, frac, alongM, offM } | null`:
  the tap's hit test, in metres. `alongM` is the driven distance to the
  nearest point, `frac` that over the trace's length (cumulative chord
  length, the `traceIndexAtFraction` rule: a trace is denser where the car
  was slower), `offM` how far the tap was from the line.
- `speedRuns(trace, buckets = 16)` → `[{ from, to, bucket }]`: the line cut
  into runs of one quantised speed colour. MapKit JS strokes a polyline in
  one colour, so the web draws one overlay per run; the phones use it to
  build their gradient stops, so all three colour the same metres the same.

Every importer and both recorders pass the origin through to the save.
**One refusal:** a batch item that only fitted the picked line through
`ui.js`'s longitude mirror (the legacy west-positive fallback) sends
`trace_geo: null`. Its trace was projected from negated longitudes and no
origin describes it truthfully.

## The viewer (all three clients)

Opened by an expand control on the track map card wherever a trace is drawn
from a session: the event page, the lap page, the lap stage's map, the
analysis column, the leaderboard lap. Read-only pages (a coach's view) get
it too. The public share pages do not show the control.

- **Initial camera:** the trace's bounds, north up, 48 pt of padding, never
  under the controls.
- **Zoom:** out to twice the fitted span, in to the provider's maximum.
- **Fit** recentres to the initial camera. The provider's compass, shown once
  rotated, returns north.
- **Line:** 5 pt, round joins, speed ramp `--map-slow` → `--map-fast`, over a
  7 pt casing in near-black at 60 % so it reads on pale concrete and dark
  trees alike. Width is in screen points and does not scale with zoom.
- **Tap:** a dot on the nearest point within 24 pt, with speed in the
  driver's units and distance from the line (`fmtSpeedKph`, `fmtDist`).
  Tapping elsewhere clears it.
- **Approximate anchor:** one line under the title, *"Position estimated from
  another session here."*
- **Attribution:** the provider's logo and legal link stay visible and
  uncovered, always. Both terms require it.
- **Accessibility:** the map is one element whose label is the track map's
  existing description plus the map type; every control is labelled; the tap
  read-out is also reachable as "Next point / Previous point" adjustable
  actions stepping 5 % of the lap. Reduce Motion cuts the fit animation.
- **Analytics path:** `/event/:id/session/:id/map`,
  `/track/:id/leaderboard/:id/map`.

### iOS

`Route.trackMap(source:)`, `source` being `.session(eventId, sessionId)` or
`.leaderboardLap(trackId, lapId)`; a **pushed page**, never a sheet (the
pages that open it already present one). `remapTempIds` follows both ids.
`App/Screens/TrackMapScreen.swift` wraps an `MKMapView` in a
`UIViewRepresentable`: SwiftUI's `MapPolyline` cannot colour along its
length, `MKGradientPolylineRenderer` can. `isPitchEnabled = false`,
`showsUserLocation = false`. Map type in `UserDefaults` (`mapType`). Works
unchanged as Designed for iPad on a Mac. The model reads the cached event
through `auth.api.scoped(to: owner)`.

### Android

`Route.TrackMap(source, student?)`, a plain `composable` (no `PageColumn`: a
map wants the pane). `maps-compose`'s `GoogleMap` with a `Polyline` of
gradient `StyleSpan`s; tilt gestures and my-location off. New dependencies
`play-services-maps` and `maps-compose`, `:app` only, so
`checkNoAndroidDependency` is untouched. The API key is restricted to the
package and the three signing fingerprints (Play, upload, debug) and to the
Maps SDK alone, and is committed on `google-services.json`'s terms. **No
Play Services** (`GoogleApiAvailability`) is Line mode with a sentence, never
a crash. The map cannot run under Robolectric, so the screen takes a
`LocalMapAvailable` seam and its tests cover the Line path, the controls and
the missing-anchor wording; the geometry is `:core`'s. Map type in
`settingsDataStore` (`map_type`).

### Web

`#/event/:id/session/:sid/map` and `#/track/:id/leaderboard/:lapId/map`,
through `L()` for a student. A fixed full-viewport layer over the shell, as
Wrapped is. `public/js/map-viewer.js` injects the MapKit JS script on first
open, authorises through `/api/map-token` (fetched outside `api()`, so a
coach's view does not prefix it), and draws `speedRuns` as polyline
overlays. While `state.me.maps.web` is false the viewer offers Line only.
`th-map-type` in localStorage. Escape closes.

#### As built — web

- **Line is the drawn line, not a map without tiles.** MapKit JS has no
  tile-less type, so *Line* is `renderTrackMap` on a canvas sized to the
  viewer: no pan or zoom there, and no tap read-out. It is also what shows
  while MapKit loads, and what stays when it cannot.
- **The tap's speed comes from the lap's channel entry**, never the trace's
  third value, whose unit depends on the source. A session with no channel
  entry for its best lap reads distance along the line only.
- **Limit marks need the lap's `flags` / `wheelSlip`**, which are Pro
  channels, so a free account's map carries the line, the start/finish pin
  and the direction arrow.
- **No zoom-out limit** is set; MapKit's own range applies. Keyboard pan and
  zoom are MapKit's.
- **Markers are zero-size wrappers** around a centred child, because MapKit
  anchors a custom annotation at its element's bottom centre.
- The viewer was exercised in a browser against a stand-in for MapKit JS
  (the same calls, drawn on a canvas). **Apple's real imagery has not been
  seen from this code yet**: the first open on the deployed app is that test.

#### As built — Android

- **`:core` carries the pure half**: `GeoTrace.KX` / `KY` / `traceOrigin` /
  `unprojectTrace` / `traceGeoBounds` / `nearestOnTrace` / `speedRuns`
  (`GeoAnchorTest`, every row of `geo-anchor.json` plus the JS cases), and
  `MapViewer`, the port of `map-viewer.js`' exported helpers under the same
  names (`viewerPlan`, `startType`, the four `NOTE_*` sentences, `rampColor`,
  `traceMetres`, `headingDeg`, `tapHit`, `placeAt`, `readoutText`,
  `pointAlong`) plus `stepHit`, the 5 % accessibility step (`MapViewerTest`).
- **The anchor**: `ParsedTelemetry.traceGeo`, set where the JS sets it — a
  beacon PDR, a `.vbo` with a `[laptiming]` line, a Track Precision CSV, and
  `Telemetry.applyGate` (null when the line only fitted mirrored) — and sent
  as `SessionDraft.traceGeo` (`trace_geo`) only beside a trace. The three
  parser contract tests assert the fixtures' `traceGeo`; the offline patch
  carries it into the optimistic session as `offline.js` does.
- **`Route.TrackMap`** (flat nullable ids; `source` is the two halves),
  a plain `composable`, opened by the ⤢ on `TrackMap`'s card (`onExpand`):
  the event page, its analysis column, the lap page and its stage map, the
  leaderboard lap — never `SharedItemScreen` / `SharedLogbookScreen`.
- **The seam is `MapSupport`** (`LocalMapAvailable`): `available` is the key
  (`BuildConfig.MAPS_KEY_SET`) and Play services (`GoogleApiAvailability`),
  `online` is asked once at open (offline is `NOTE_OFFLINE` and the line —
  tiles the SDK has cached are not offered), and `drawMap` is
  `GoogleTrackMap`. `TrackMapViewerTest` stands a plain composable in for it.
- **Line** is the drawn card (`TrackMap`) at the pane's size, with the
  accessibility steps ringing the place; no tap there, as on the web.
- **The ramp is one solid `StyleSpan` per `speedRuns` run**, not gradient
  spans, so a run is the web's overlay colour exactly; the casing is a 7 dp
  near-black polyline under it. Zoom out stops one level past the first fit
  (`minZoomPreference`). The standard style follows the app theme through
  `mapColorScheme`. Limit marks are dots in the side's colour.
- **No real tiles have been seen from this code**: there is no key yet, so
  every build so far, emulator included, is Line-only.

## Privacy, legal and stores

- Opening the viewer sends the viewed area and the device's IP to Apple (iOS,
  web) or Google (Android). `site/docs/privacy.html` gains a *Maps* section
  and a new effective date.
- App Store label: no change (MapKit is the platform's). Play **Data
  safety**: review against Google's guidance for the Maps SDK before the
  first upload that links it.
- No map imagery is stored, exported, or put in a share image. The promo
  video and store screenshots that show it keep the attribution in frame.

## Docs owed (in the same PRs)

`README.md` (the feature, the three `MAPKIT_*` / Maps key setup steps, the
`MAP_TOKEN` binding); `site/docs/data-model.html` (the trace now has a
place; what "estimated" means); `site/docs/telemetry-import.html` and
`lap-recording.html` (one line each); `site/index.html` features grid and
`llms.txt`; the NS-32 tier table row (free); `AGENTS.md`;
`docs/specs/native/README.md`.

## Tickets

1. **Server + shared logic — landed.** Migration `0037`, `lib/geo.ts`, the
   anchor on the session save, the event detail, the coach mount, the
   leaderboard lap and the export; goldens; the `geo.js` additions and
   `contracts/logic/geo-anchor.json`; every web importer sending `trace_geo`;
   both native models decoding it. No UI. Ships first so anchors start
   accumulating.
2. **iOS.** The `Geo` ports, importers and recorder sending the anchor, the
   viewer.
3. **Android — landed.** The `GeoTrace` ports and the viewer's pure half
   (`MapViewer`), every importer and the recorder sending the anchor, the
   viewer. See *As built — Android* below. **Still manual:** creating the
   restricted Maps key (`MAPS_API_KEY`) and Play's **Data safety** review
   before the first upload that links the SDK — until the key exists, every
   build is Line-only.
4. **Web — landed.** `GET /api/map-token` and `user.maps` on `/me` (moved
   here from ticket 1: they are only testable against the viewer that uses
   them), the `MAPKIT_*` secrets, `map-viewer.js`, the privacy page. See
   *As built — web* below.

Tickets 2–4 are independent of each other.

## Acceptance criteria

- A session imported or recorded after ticket 1 on any client stores an
  anchor, and its line sits on the circuit's tarmac in Satellite on all
  three, within GPS error.
- A session saved before it, at a track with one anchored session, opens on
  the map marked estimated; at a track with none it opens in Line mode.
- Pan, pinch, rotate and double-tap work; the page behind never scrolls.
- A session whose body carries a nonsense anchor saves with a 201.
- Neither public share response contains `trace_geo`.
- Nothing loads from Apple or Google before the viewer is opened.
- Airplane mode: the viewer opens and draws the line.

## Open questions (decide in ticket 1)

1. **Borrowed anchors on the leaderboard lap.** Another driver's borrowed
   anchor is two estimates deep. Send it flagged, or stored anchors only?
   This spec says flagged.
2. **Pre-fix Racelogic imports** stored a mirrored trace. A borrowed anchor
   draws it mirrored on the map, where today it is merely mirrored on a
   blank card. `borrowAnchor`'s mismatch test does not catch a mirror; a
   winding-direction check against the donor would.

## Follow-ups, deliberately not here

- **The start/finish picker on satellite.** The picker already holds raw
  fixes, so it needs no stored anchor, and picking the painted line beats
  picking a bend in a polyline. The strongest next step.
- A static map backdrop behind the inline card.
- Two lines at once (the two-lap compare, a leaderboard lap against yours).
- The lap stage's playhead and NS-52's placed comments on the viewer.
- A live map on the recorder.
- Latitude and longitude from `get_racing_line` (MCP), and on the shares for
  catalog circuits.
