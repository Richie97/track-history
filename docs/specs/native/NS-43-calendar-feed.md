# NS-43 — Calendar feed

**Phase:** post-rewrite · **Platform:** Shared (server, web, iOS, Android) · **Depends on:** the events list, Settings on all three clients · **Estimate:** ~1 week across three PRs: server + web, then iOS, then Android · **Issue:** [#378](https://github.com/Richie97/track-history/issues/378)

## Goal

A driver subscribes once, from Settings, and their track days appear in
Apple Calendar, Google Calendar or Outlook. The calendar stays current as
they add, move or delete events, with no export step and nothing to re-share.

```
Settings → Calendar
┌──────────────────────────────────────────────┐
│ Your track days in your calendar             │
│ [ Subscribe in Calendar ]  [ Google Calendar ]│
│ [ Copy link ]                                │
│ Last checked by your calendar 2 hours ago    │
│ Reset link · Turn off                        │
└──────────────────────────────────────────────┘
```

## Why

A track day is booked weeks ahead on MotorsportReg or an organizer's site,
and the driver's calendar is where they plan the weekend around it: the
trailer, the hotel, the time off. Today the app knows the date and the
calendar doesn't. A subscription feed (RFC 5545 over https) is the one
mechanism every calendar app supports and keeps current, and it needs no
native calendar permission.

## Fixed decisions

| | |
|---|---|
| Mechanism | **A subscription URL**, `https://<host>/cal/<id>.<mac>.ics`, served by the Worker. Not EventKit or CalendarContract writes: those need calendar permission on each phone, write copies that go stale, and do nothing for the web. |
| The secret | Calendar apps send no cookie and no bearer, so the URL carries the credential. It is **an HMAC, not a stored token**: `mac = HMAC-SHA256(CALENDAR_FEED_SECRET, "cal:" + userId + ":" + version)`, hex. The database holds only `version`. So no usable credential is stored, the Settings page can **show the link again on any device** (a hashed, show-once token like a coach invite can't), and resetting it is `version + 1`. `id` is the user's integer id, which isn't a secret. |
| Off by default | No feed exists until the driver turns it on. Turning it off deletes the row, and the old URL answers 404. |
| Unknown is 404 | A wrong `mac`, a stale `version`, a disabled feed and a nonexistent user all answer **404** with no body difference. Never 403. The comparison is constant-time. |
| What's in it | Event **dates**, **track name**, **organizer**, **run group**, **car**, and a link back to the event. **Never** notes, checklist text, costs, setups, lap times, the instructor or anything from the garage. The link can be forwarded, and a calendar is often shared with family. |
| Which events | Every upcoming event, plus past events from the last **365 days**. Older history adds weight to every fetch and nothing to planning. |
| Tier | **Free.** It's the logbook's own dates. |
| Config | `CALENDAR_FEED_SECRET` is a Worker secret. When it's unset, `GET /api/me/calendar` answers `{ available: false }` and every client hides the section, which is how `GET /auth/providers` gates the Apple button. |
| Not cached client-side | `/api/me/calendar` returns a credential-bearing URL, so it is **read past every cache**: `sw.js` skips it, the web's offline layer doesn't store it, and both native clients read it with the cache bypassed (Android's `cached = false`, as `coachInvite` does). The `/cal/*` path is skipped by `sw.js` too. |

## Server (ticket 1)

### Migration `0033_calendar_feeds.sql` (or the next free number when it lands)

```sql
CREATE TABLE calendar_feeds (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_fetched_at INTEGER
);
```

### Management (authed, `routes/calendar.ts`, under `/api`)

| Route | |
|---|---|
| `GET /me/calendar` | `{ available, enabled, url, webcal_url, google_url, last_fetched_at }`. `url` / `webcal_url` / `google_url` are null when the feed is off. `google_url` is `https://calendar.google.com/calendar/render?cid=<url-encoded webcal_url>`, Google's documented subscribe link. |
| `POST /me/calendar` | Turn on (idempotent: an existing feed keeps its version). Answers the `GET` shape. |
| `POST /me/calendar/reset` | `version + 1`, answering the new shape. The old URL is dead from that request on. 404 when off. |
| `DELETE /me/calendar` | Turn off. `{ ok: true }`. |

Live writes, off every offline queue. None of them checks entitlement.

### The feed: `GET /cal/:file` (public, outside `/api`)

- `"/cal/*"` joins `run_worker_first` with a comment, and `app.route("/cal",
  calendarFeed)` mounts ahead of the SPA fallback, without session
  middleware.
- Parse `<id>.<mac>.ics`. Load `calendar_feeds` joined to `users` in one
  statement, recompute the mac, compare in constant time, and 404 on any
  failure.
- Rate limit: a new `CAL_FEED` binding (60 per minute), keyed by **user
  id**, not IP: Google and Apple fetch from shared provider addresses.
  Applied through `withinLimit`, so a missing binding means unlimited. A 429
  carries `Retry-After`.
- Read events through `listEvents(db, userId)` and filter to the window in
  the route. `last_fetched_at` is touched through `waitUntil`, at most once
  an hour.
- Response headers: `Content-Type: text/calendar; charset=utf-8`,
  `Cache-Control: private, max-age=900`, `Referrer-Policy: no-referrer`,
  `X-Robots-Tag: noindex`.

### `src/lib/ical.ts` (pure, unit-tested)

- `calendarFeed(events, { origin, now })` returns the `VCALENDAR` text:
  `PRODID:-//Track Evolution//Calendar feed//EN`, `VERSION:2.0`,
  `CALSCALE:GREGORIAN`, `X-WR-CALNAME:Track Evolution`,
  `REFRESH-INTERVAL;VALUE=DURATION:PT6H` and `X-PUBLISHED-TTL:PT6H`.
- One `VEVENT` per event:
  - **`UID`**: `event-<id>@trackevolution.app`. It's stable across edits, so
    a moved date moves the entry rather than duplicating it.
  - **`DTSTAMP`** and **`LAST-MODIFIED`**: from `updated_at`.
  - **`DTSTART;VALUE=DATE`**: `start_date`.
  - **`DTEND;VALUE=DATE`**: the day *after* `eventLastDay` (DTEND is
    exclusive for all-day events). It uses `eventLastDay`'s rule: the day
    count rounded **up**, minimum one, so a 1.5-day event covers two
    calendar days.
  - **`SUMMARY`**: *"Track day: <track name>"*.
  - **`LOCATION`**: the track name.
  - **`DESCRIPTION`**: organizer · run group · car, then *"Open in Track
    Evolution: <origin>/#/event/<id>"*.
  - **`URL`**: the same link.
  - **`TRANSP:OPAQUE`**.
- `icsEscape` (backslash, `;`, `,`, newline → `\n`) and `foldLine`, which
  folds at **75 octets of UTF-8**, never inside a multi-byte character. A
  track name like *"Autódromo"* is where a byte-naive fold corrupts the
  feed.
- Tests:
  - escaping each special character;
  - folding at the boundary, with a multi-byte character straddling it;
  - DTEND for 1, 1.5 and 3 days, and for `days` null;
  - the 365-day window;
  - an event with only a track name;
  - a round-trip through a small unfold-and-parse helper in the test, which
    asserts every line is ≤ 75 octets and CRLF-terminated.

### API tests (`test/api/calendar.test.ts`)

- On, off and reset, including that the old URL dies on reset.
- 404 for every bad-URL case, with identical bodies.
- Another user's id with your mac is a 404.
- The window, and the `Content-Type`.
- The feed carries no notes, costs, checklist text or instructor, asserted
  against a fully populated logbook.
- `available: false` without the secret.

## Clients

### Web (ticket 1)

A *Calendar* section in `viewSettings`, after *Prep checklist*. When off,
one sentence and *Add your track days to your calendar*. When on, three
buttons: *Subscribe in Calendar* (a `webcal_url` link), *Google Calendar*
(`google_url`, a new tab) and *Copy link*. Under them sit the
last-fetched line (*"Your calendar last checked 2 hours ago"* / *"Not
checked by a calendar yet"*), *Reset link* (confirm: *"Calendars using the old
link stop updating"*) and *Turn off*. Offline, the section says it needs a
connection. `sw.js` skips `/cal/` and `/api/me/calendar`.

### iOS (ticket 2)

The same section in `SettingsScreen`. *Subscribe in Calendar* calls
`UIApplication.shared.open(webcal_url)`, which hands Calendar its subscribe
sheet. *Google Calendar* is a `Link`, and *Copy link* uses `UIPasteboard`.
`APIClient.calendarFeed()` bypasses the response cache, and its writes are
off the offline queue (asserted in the Kit's offline tests).

### Android (ticket 3)

The same section in `SettingsScreen`. *Subscribe* fires `Intent.ACTION_VIEW`
on the `webcal_url`, not a Custom Tab, which won't take the scheme. When no
app resolves it (common on Android), the button is replaced by *Google
Calendar* (`google_url` through `CustomTabs.open`) plus *Copy link*.
`ApiClient.calendarFeed` reads with `cached = false`, and its writes are
off `isQueueable` (asserted in `OfflineStoreTest`).

## Privacy and legal

- **Privacy policy**, *Who can see your logbook* (bump the effective
  date): a calendar link, if you turn one on, shows anyone who has it your
  track days' dates, tracks, organizer, run group and car. Resetting or
  turning it off stops it. Calendar services (Apple, Google, Microsoft) fetch
  it on your behalf.
- `site/docs/index.html`: a short *Your track days in your calendar*
  section, with the Google Calendar note that Google refreshes subscribed
  calendars on its own schedule (often several hours).
- No store-disclosure change: no new data type, and the sharing is the
  user's own act.

## Docs owed (in the same PRs)

- NS-32's tier table: *Calendar feed* (Free).
- `docs/specs/native/README.md`: the index row and the split note (all three).
- `AGENTS.md`: `routes/calendar.ts`, `/cal/*` in `run_worker_first` and its
  reason, `lib/ical.ts`, migration 0033, the `CAL_FEED` binding, the secret,
  and the cache bypass on every client.
- `README.md`: the secret (`npx wrangler secret put CALENDAR_FEED_SECRET`)
  and the binding.

## Tickets

1. **Server + web** ([#379](https://github.com/Richie97/track-history/issues/379)): migration, `calendar.ts`, the feed route, `ical.ts`,
   the rate-limit binding, tests, the web Settings section, `sw.js`, privacy
   and docs. **3–4 days.**
2. **iOS** ([#380](https://github.com/Richie97/track-history/issues/380)): the Settings section and the cache-bypassing client call. **1–2 days.**
3. **Android** ([#381](https://github.com/Richie97/track-history/issues/381)): likewise, with the `webcal` fallback. **1–2 days.**

## Acceptance criteria

- [ ] Turning the feed on from any client gives a link that Apple Calendar, Google Calendar and Outlook each subscribe to and display correctly, multi-day events included. Checked by hand once per calendar app before the web ticket merges.
- [ ] Adding, moving or deleting an event changes the feed on its next fetch. A moved event moves rather than duplicating.
- [ ] Reset kills the old link immediately; Turn off makes every link 404.
- [ ] The feed carries no notes, costs, checklist text, setups, lap times or instructor (asserted).
- [ ] Neither the feed URL nor `/api/me/calendar` lands in any client cache or the service worker.
- [ ] With `CALENDAR_FEED_SECRET` unset, no client shows the section and `/cal/*` answers 404.
- [ ] `npm test`, `npm run typecheck`, `npm run contracts:check`, `swift test`, `:core:check`, `:app:testDebugUnitTest` pass.

## Follow-ups, deliberately not here

- **Add one event** (a single `.ics` download or the phones' native
  *Add to Calendar*) for drivers who don't want a subscription.
- **Reminders** (a `VALARM` the night before with the prep checklist's
  progress). Most calendar apps ignore alarms in subscribed feeds, so it
  isn't worth shipping until one doesn't.
- **Importing** MotorsportReg registrations as events. That's the other
  direction, and needs their API.
