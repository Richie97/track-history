# NS-36 — Season Wrapped

**Phase:** post-rewrite · **Platform:** Web (server + web app) · **Depends on:** year in review (`#/year`), the share pages, NS-32 (tier), the garage (one card) · **Estimate:** 5–6 days across five PRs, on `main` before **1 November 2026**

## Goal

In November a driver opens Track Evolution and gets their season handed back
to them as a story: a swipe-through of full-screen cards — the numbers, the
track they drove most, the time they found, their fastest lap, the tyre they
lived on — ending on one card they can post to the club group chat.

```
My 2026 Track Evolution

14 track days · 6 tracks · 1,923 laps · 4,281 track miles

Most driven          VIR (Full)
Biggest improvement  Summit Point, −4.83 s
Fastest lap          VIR (Full), 2:00.03
Favourite tyre       Continental ExtremeContact Force
```

Spotify Wrapped, for track days.

## Why

Year in review already exists (`#/year`, web, Pro): four tiles and a per-track
table of best-before against best-this-year. It answers the question and makes
nobody feel anything, and nothing on it can be shared as a picture.

Wrapped is the same data plus two stats the app has never computed — **track
miles** and **favourite tyre** — with a different job. The off-season is the one
moment a driver is at a desk, already nostalgic, and one tap from posting. The
app's acquisition loop is sharing (share pages, per-slug OG tags, leaderboards);
Wrapped is the first thing built to be shared *as an image*, and the first
thing with a date on it.

## Fixed decisions

| | |
|---|---|
| Platform | **Web-first**, laid out portrait-first. The frontier rule from the README: new ideas land on the web and graduate once proven. The page is opened from a link on a phone as often as at a desk, so it is designed for a phone screen and merely fine on a wide one. A native screen is a decision for after the first November, not this spec — see *Why not the phone apps now* below for why a link-out is not the answer either. |
| Season | The **calendar year**, same as year in review (`eventYear`). Past events only — `start_date <= today`, UTC, the `userTotals` rule. |
| Availability | Any year with at least one past event, at any time. The route is a view, not a countdown. What is seasonal is the **reveal**: from 1 November to 31 January the dashboard carries a Wrapped hero for the year that is ending or just ended. A wrapped for the running year says *through <date>*. |
| Tier | **Free** for the story and the share; **Pro** for the two cards built from Pro data (favourite tyre — garage consumables; top speed — channels). A free account sees those two as **locked** cards, never silently missing. Year in review stays Pro. Rows added to NS-32's tier table. |
| Where it is computed | **The server**, in one endpoint, with the pure half in `src/lib/wrapped.ts`. Year in review is computed on the client from `/events`; Wrapped is not, because its inputs are different — the catalog's lap lengths, and every session's channel blob for top speed, which is Pro-stripped and far too heavy to ship for one number. The public share needs the same numbers with no session, and the OG description needs them inside the Worker. |
| Schema | One column: `track_catalog.length_m` (migration 0022), seeded. **No existing response shape changes** — Android decodes the goldens with `ignoreUnknownKeys = false`, so a field added to `/tracks` or `/catalog` is a three-client change; a new endpoint is a one-client change. `GET /api/catalog` keeps returning `{ id, name }`. |
| Public share | `/share/:slug/wrapped/:year`, only for an owner who already has a share slug, carrying **the free card set only** — no garage, nothing channel-derived. Every number on it is derivable from what `GET /api/share/:slug` already publishes, so this is no new privacy surface and the policy does not need a bump. |
| The share image | Rendered **on the client** (canvas; a 1080×1920 story and a 1200×630 landscape), handed to the Web Share API with files where the browser has it, downloaded otherwise. No Worker rasteriser: [#155](https://github.com/Richie97/track-history/issues/155)'s blocker stands. The link's OG *image* stays the brand card; its OG *title* and *description* become per-wrapped. |
| Empty cards | A card with no data is **skipped**, never drawn empty — a card that says "no data" is a card of nothing. The exception is the two Pro cards on a free account, which draw locked. |

## The cards

In order. Copy is indicative; the tone is warm and specific, never a dashboard.

| # | Card | Data | Skipped when |
|---|---|---|---|
| 1 | **Cover** — "Your 2026 Track Evolution", the driver's name | `users.name` | never |
| 2 | **The numbers** — track days · tracks · laps · track miles | `SUM(days)`, distinct tracks, `SUM(lap_count)`, miles (below) | never |
| 3 | **Most driven** — the track with the most track days; "N days · M laps · best m:ss.fff" | per-track sums; ties broken by laps, then events | never (card 2 exists ⇒ a track exists) |
| 4 | **Biggest improvement** — best before the year → best in the year, seconds found | year-review's `gains`, max positive `gain_ms` with a prior baseline; **fallback:** the largest *in-year* gain (first timed event at a track → best that year), labelled as a first year at that track | no timed track gained anything |
| 5 | **Fastest lap** — the year's lowest `best_ms`, with its track and date | `best_ms` across the year's events | no timed event |
| 6 | **New tracks** — "First time at X, Y" | year-review's `new_tracks` | none |
| 7 | **Hours behind the wheel** | `SUM(hours)` via `eventHours` (`lib/wear.ts`) | never |
| 8 | **Hottest day** — the event, its track, the temperature | `MAX(ambient_hi_c)` over the year's events, else `MAX(temp_f)` | no reading at all |
| 9 | **Favourite tyre** — *Pro* — the tyre with the most track days on it | below | Pro and no tyre parts; **locked** on free |
| 10 | **Top speed** — *Pro* — the year's highest sample, with its track | `MAX` over `speed` in every session's `channels` for the year | Pro and no channels; **locked** on free |
| 11 | **The poster** — the summary card: the four numbers, most driven, improvement, fastest, tyre; Share / Save / Copy link; a link to year in review for the full table | everything above | never |

Units follow the app's existing display convention (miles, mph, °F, with the
stored SI kept in the response); if a units toggle lands first, Wrapped reads
it.

## The two new computations

### Track miles

`miles = Σ over the year's events of lap_count × lap_length(track)`, with
`lap_length` resolved in this order and the first hit winning:

1. `track_catalog.length_m` through `tracks.catalog_id` — the seeded value.
2. **The driver's own telemetry at that track**, any year: the median over
   every channel-carrying lap of `dStepM × speed.length` (a gridded lap's
   driven distance, by construction), else the polyline length of the best-lap
   `trace`. The server reads `channels` regardless of tier; this is arithmetic
   on stored data, not a Pro read.
3. Unknown. The track contributes zero, and the card says **"across N of M
   tracks"** so the number never pretends.

Counted laps are *logged* laps. A best-lap-only history undercounts, and the
card does not correct for it — the numbers card is the driver's logbook, not
an estimate of their life. (`eventHours` already makes the opposite call for
hours, and says so; the two are different questions.)

### Favourite tyre

For every `parts` row of kind `tires` on any of the driver's vehicles, take the
year's events on that vehicle that fall inside the part's service window —
`eventsInWindow` in `lib/wear.ts`, the same rule wear uses — and sum their
days. The part with the most days wins; ties go to the most hours. Named by
`parts.name` ("Continental ExtremeContact Force"). An event only counts toward
a vehicle through `events.vehicle_id`, which the car field auto-matches by
name — an event whose car isn't in the garage counts toward no tyre.

A setup sheet's explicit `tires_id` for a day is the better signal and is
**not** used in v1; the window rule is what the garage already believes, and
the sheet override is a refinement for when the card is wrong for someone.

## Requirements

### 1. `GET /api/wrapped/:year` (ticket 1)

Authed. `:year` is four digits; anything else is 400. A year with no past
events is 404 `{ "error": "no events in 2026" }`. Otherwise:

```json
{
  "year": 2026,
  "years": [2026, 2025, 2024],
  "through": "2026-11-01",
  "name": "Eric",
  "totals": { "events": 9, "track_days": 14, "tracks": 6, "laps": 1923,
              "hours": 31.5, "miles": 4281.4, "miles_tracks_counted": 5 },
  "most_driven": { "track_id": 3, "track_name": "Virginia International Raceway (Full)",
                   "track_days": 5, "laps": 612, "best_ms": 120030 },
  "improvement": { "track_id": 7, "track_name": "Summit Point (Main Circuit)",
                   "best_before": 94120, "best_this_year": 89290, "gain_ms": 4830,
                   "baseline": "prior_years" },
  "fastest": { "track_id": 3, "track_name": "…", "best_ms": 120030,
               "event_id": 41, "date": "2026-06-14" },
  "new_tracks": [{ "track_id": 9, "track_name": "…" }],
  "hottest": { "event_id": 44, "track_name": "…", "date": "2026-07-19", "temp_c": 34.5 },
  "pro": null
}
```

- `years` is every year with a past event, newest first — the picker.
- `through` is today while the year is running, `null` once it has ended.
- `improvement.baseline` is `"prior_years"` or `"first_event"` (the fallback).
  `improvement`, `fastest`, `hottest` and `most_driven` are `null` when
  skipped; `new_tracks` is `[]`.
- `pro` is **the one tier-dependent field**, decided from `entitledUntil` on
  the context the way `stripProFields` decides `channels`: `null` for a free
  account; for Pro, `{ "tire": {…} | null, "top_speed": {…} | null }`, so the
  client can tell *locked* from *no data*. Until ticket 4 lands the key is
  present and `null` for everyone.
- The pure half is `src/lib/wrapped.ts` — `seasonWrapped(inputs, year, today)`
  over plain rows, no I/O — and every rule in this spec (miles precedence,
  the tie-breaks, the improvement fallback, the tyre window) has a unit test
  in `test/unit/wrapped.test.ts`. The route is thin and batched (`DB.batch`,
  like `/me`).
- The capture is `contracts/golden/wrapped.json`. The fixture already has two
  VIR layouts and an event with no laps; add a catalog-matched track with a
  length and one without, so `miles_tracks_counted < tracks` is pinned.

### 2. Migration 0022 — `track_catalog.length_m` (ticket 1)

`ALTER TABLE track_catalog ADD COLUMN length_m INTEGER;` plus one `UPDATE` per
catalog row with a known length, in metres, from the venue's own published
figure for the layout the catalog row names. Rows with an ambiguous layout
(Pocono, Utah Motorsports Campus, MotorSport Ranch) stay `NULL` rather than
guessing — resolution 2 above covers a driver who has telemetry there. The
seed values are listed on the ticket and **verified against the venue before
merge**, because a wrong length is a wrong number on somebody's poster.

### 3. `#/wrapped/:year` (ticket 2)

- Route in `app.js`, `viewWrapped(year)`; `#/wrapped` alone goes to the newest
  year. A 404 from the API renders "No track days in 2026 — yet" with the year
  picker, not the error banner.
- **Story layout:** one card fills the viewport; next/previous by tap on the
  right/left third, swipe, `→`/`←`/`Space`, and progress dots that are
  buttons. Cards are real DOM (not a canvas), so text is selectable and
  screen-readers walk them; the current card is announced through an
  `aria-live` region.
- `prefers-reduced-motion` turns every transition into a cut, the same rule
  `celebrate.js` follows.
- Dark and light both first-class; the Wrapped surfaces may use the lime
  accent generously — this is the one page where "used sparingly" is
  suspended, and that is a deliberate exception to note in `style.css`, not a
  drift.
- **The dashboard hero:** `wrappedSeason(today)` in `public/js/wrapped.js`
  (pure, unit-tested) returns the year to promote — the current year from
  1 Nov to 31 Dec, the previous year from 1 Jan to 31 Jan, `null` otherwise.
  When it returns a year with events, the dashboard draws a hero above the
  tiles: "Your 2026 Wrapped is ready →". Dismissable for the season
  (localStorage, per year).
- The two Pro cards on a free account are locked: the card's shape with a
  `pro-badge`, one line saying what it would show, and `proPanelHtml`'s
  store links. Rendered from `pro === null`; a Pro account with no data skips
  them.
- Docs in the same PR: README feature list, `site/index.html` features grid,
  `site/docs/index.html` (a short "Your season, wrapped" section), `AGENTS.md`
  route list and the `js/` module bullet.

### 4. Share (ticket 3)

- `GET /api/share/:slug/wrapped/:year` — public, mounted on `publicShare`,
  same shape as requirement 1 **without the `pro` key**. 404 for an unknown
  slug or an empty year. `test/api/share.test.ts` asserts no garage or
  channel-derived field appears for a Pro owner.
- `sharePage` gains a `/:slug/wrapped/:year` route ahead of `/*`: title
  "Eric's 2026 on Track Evolution", description
  "14 track days · 6 tracks · 1,923 laps · 4,281 track miles · most driven VIR (Full)",
  `og:url` the wrapped URL. Same shell, same cache header.
- The SPA's `SHARE_SLUG` parse widens to
  `^\/share\/([^/]+)(?:\/wrapped\/(\d{4}))?\/?$`; a wrapped path renders
  `shareWrapped(year)` through the **same card renderer** as the authed view,
  the way `yearReviewHtml` is shared today. The cover names the driver; the
  poster's buttons become *Track your own laps*.
- **The image:** `public/js/wrapped-image.js` draws the poster to a canvas
  (Geist via `document.fonts.load`, with the system fallback the CSS already
  declares), 1080×1920 and 1200×630, brand mark and the app URL in the
  corner. *Share* uses `navigator.share({ files })` when `canShare` says yes,
  else offers the PNG for download; *Copy link* copies the public URL when the
  owner has a slug, and otherwise offers to set one (the existing Settings
  control, linked).
- Docs: `site/docs/data-model.html`'s share-page section says what a wrapped
  link shows and that it carries nothing the share page doesn't.

### 5. The Pro cards (ticket 4)

- Server: `pro.tire` per *Favourite tyre* above (`vehicleHoursEvents` and
  `eventsInWindow` already exist for wear); `pro.top_speed` as
  `{ kph, track_id, track_name, event_id, date }` from a `json_each` walk over
  the year's sessions' `channels` laps' `speed` arrays — once a year per user
  is not a hot path, so no trigger-maintained column. Unit tests for the
  window rule and the tie-break; an api test that a free account gets
  `pro: null` and a Pro account gets the object with `null`s when empty.
- Web: cards 9 and 10 for Pro; the locked treatment for free; the tyre line
  on the poster when present. Fixture regenerated.
- NS-32 tier table: the rows land with **this** PR's spec change, ahead of the
  first merge — done in this spec's PR, not deferred.

### 6. November launch QA (ticket 5)

The date gate makes the launch automatic, so the checklist is what has to be
true before 1 November:

- Every catalog length verified (a second pass, against the venue).
- The real account renders every card, in both themes, on a phone and a
  laptop; reduced motion honoured; the locked cards checked with
  `POST /auth/dev/entitlement` on a dev host.
- A wrapped link unfurls correctly in iMessage, Slack and a social card
  debugger; the story image shares from iOS Safari and Android Chrome.
- Lighthouse on the story page from a phone profile: no layout shift between
  cards, no long task on card change.
- A decision recorded in the specs README on whether the phone apps get a
  native Wrapped for the *next* November, with what this one taught.

## Acceptance criteria

- [ ] `GET /api/wrapped/:year` behaves per requirement 1; `contracts/golden/wrapped.json` is committed; `npm run contracts:check` is clean.
- [ ] Migration 0022 applies on a database at 0021; `GET /api/catalog` is byte-identical before and after.
- [ ] Every rule in *The two new computations* has a unit test; `miles_tracks_counted < tracks` is pinned by the golden fixture.
- [ ] `#/wrapped/:year` renders the story on a 375-px-wide viewport with no horizontal scroll, in both themes, with keyboard, tap and swipe navigation, and cuts instead of transitions under reduced motion.
- [ ] The dashboard hero appears only inside the 1 Nov – 31 Jan window (`wrappedSeason` unit-tested at both edges) and only for a year with events.
- [ ] A free account sees locked cards 9 and 10; a Pro account sees them or nothing.
- [ ] `/share/:slug/wrapped/:year` serves per-wrapped OG title/description to a scraper and the story to a browser; the public API never carries a garage or channel-derived field.
- [ ] The poster PNG shares through the Web Share API on iOS Safari and Android Chrome, and downloads elsewhere.
- [ ] README, `site/`, `AGENTS.md` and the NS-32 tier table describe the feature; `npm test` and `npm run typecheck` pass.

## Verification

```sh
npm test && npm run typecheck && npm run contracts:check
npm run db:migrate:local && npm run dev     # then #/wrapped/2026 and /share/<slug>/wrapped/2026
```

## Notes

**Why not the phone apps now.** The obvious November move is a card in both
apps that opens the web page — and it lands the driver on the web sign-in
screen, because the apps authenticate with a bearer token and the phone's
browser holds no cookie. A link-out is therefore worse than nothing. The
honest options are a real native screen or nothing, and this spec makes the
choice cheap for next year on purpose: the computation is server-side, so a
native Wrapped is **the endpoint plus a screen** — no port, no fixture — and
the only pure client logic (`wrappedSeason`, the hero window) is the kind the
Kit and `:core` already carry under shared names. Ticket 5 records the
decision.

**What this deliberately leaves for later.** A "what it cost" card belongs to
[#147](https://github.com/Richie97/track-history/issues/147) (cost tracking)
and will slot in as card 8½ when that lands. A per-track length override on the
track form is the fix for a driver at a non-catalog track with no telemetry; it
touches `/tracks`' shape and so is a three-client change, which is why it is not
here. The setup-sheet `tires_id` refinement of the tyre rule is a one-line
change once someone's card is wrong. A per-slug OG *image* is #155.

**The gains table is not duplicated.** Card 4 shows one track; the full
per-track table stays on year in review, which the poster links to. That is
also what keeps year in review worth its Pro row.
