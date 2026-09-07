# NS-35 — Open a leaderboard lap

**Phase:** post-rewrite · **Platform:** Shared (server, web, iOS, Android) · **Depends on:** the per-track leaderboards (2026-08), NS-33, #165 (the two-lap compare) · **Estimate:** 3 days — one server PR, one per client

## Goal

A row on a per-track leaderboard opens. Tapping it shows that lap: its racing
line, its channel traces, and — the point of the screen rather than a feature
on it — the viewer's own best lap at the same track laid over it, corner for
corner.

Today the leaderboard is a list of times. A driver can see that someone at
their track is two seconds a lap faster and has no way to find out *where*.
Everything needed to answer that is already stored, already ported, and already
drawn: `sessions.channels`, `CompareLaps.alignLapPair`, and the channel panel
all three clients ship.

## The consent problem, first

The existing opt-in copy — on the track page and in Settings, on every client —
says:

> Joining shares exactly two things with other signed-in drivers, per track:
> your name and your best device-timed lap.

A driver who agreed to that has **not** agreed to publish their telemetry.
Widening `users.leaderboard_opt_in` to cover the lap would retroactively change
what an existing opt-in meant, which is not a thing to do quietly.

So this is a **second flag**, `users.leaderboard_share_laps` (migration 0021),
default 0. Every already-opted-in driver keeps exactly the share they consented
to until they say otherwise, and the two controls sit next to each other in
both places the first one appears, because that is where a driver is looking at
what it would publish.

The alternative — reset every `leaderboard_opt_in` to 0 and make everyone
re-consent to a combined flag — was rejected: it silently empties every
leaderboard and punishes the drivers who already opted in.

## Fixed decisions

| | |
|---|---|
| Consent | Two flags. `leaderboard_opt_in` publishes name + best time + date, unchanged. `leaderboard_share_laps` additionally publishes **that one lap**. Opting out clears both **in the same statement**, so a rejoin cannot silently re-publish. |
| How much is reachable | **One lap per driver per catalog track** — the one the board already names. Not the session it came from, not their other laps, not the event. |
| What it carries | Gridded channel traces, the stored racing line, lap time, date, driver display name, and the recorded ambient temperature and elevation. |
| What it never carries | Anything user-entered — session label, notes, event, car, typed conditions, setup sheet — plus the **per-lap scalars** (oil, coolant, fuel, battery, tyre pressures and temperatures: the car's condition, not the lap) and **`meta.odometerKm`** (the car's lifetime mileage). |
| Tier | The lap is **Free**, as leaderboards are. `channels` is the one Pro field, stripped exactly as on the event detail (NS-32 rule 4) — the racing line and the times are free, and a free account gets an offer under them, not instead of them. |
| Failure mode | Every refusal is a **404**, never a 403 — a 403 confirms the lap exists. |
| Deep links | **No.** A lap id means nothing away from the leaderboard it came from, and a link to one goes stale the moment its owner sets a faster lap or turns sharing off. |

## Server

### Migration `0021_leaderboard_share_laps.sql`

```sql
ALTER TABLE users ADD COLUMN leaderboard_share_laps INTEGER NOT NULL DEFAULT 0;
```

A plain preference, route-set. No trigger: unlike `laps.device_timed` or
`sessions.ambient_c`, it is not derived from another column.

### `PUT /me/leaderboard`

Takes `{ opt_in, share_laps? }`. `share_laps` is **optional**, and omitting it
leaves the stored value alone — a shipped older client sends `{ opt_in }` and
knows nothing about the second flag, and its request must not clear a consent
given elsewhere. `opt_in: false` forces `share_laps` to 0 in the same
`UPDATE`.

### `GET /tracks/:id/leaderboard`

Two additions, no removals:

- the response gains `share_laps`, the **viewer's own** flag, so the UI can
  offer both consents without a second request;
- each entry gains `lap_id`, **non-null only when that row's owner shares** —
  and always for the viewer's own row, because seeing what the board would
  publish before publishing it is the point of the control.

The `lap_id` rides along with `MIN(ms)` as a bare column, the same documented
SQLite min/max behaviour the existing `date` column relies on. That is not
incidental: the lap the detail route will serve has to be *this* row's lap.

### `GET /tracks/:id/leaderboard/laps/:lapId`

Every condition the leaderboard row satisfied is asserted **again** here — a
`lap_id` came out of a response and a client can send any integer:

1. The viewer owns `:id` and it has a `catalog_id`.
2. The lap is at that catalog track, is `device_timed`, and its owner has both
   consents (or is the viewer).
3. **It is that owner's ranked lap** — its `time_ms` equals their minimum
   device-timed time at the catalog track.

Condition 3 is the one that keeps this from becoming a read handle on a
stranger's logbook. Two of their laps tied at exactly that time would both
open; they are the same published time, so nothing beyond it is disclosed.

Response:

```json
{
  "lap_id": 42, "name": "Jamie R.", "you": false,
  "time_ms": 121900, "date": "2026-04-10",
  "ambient_c": 21.4, "elevation_m": 38,
  "trace": [[x, y, v], …],
  "channels": { "v": 1, "dStepM": 20, "laps": [{ "n": 1, "timeMs": 121900, "speed": […], … }] }
}
```

`channels` is the stored `sessions.channels` shape with exactly one lap — the
same shape `alignLapPair` produces — so every client's existing renderers draw
it with no new code path.

### `src/lib/leaderboard.ts`

`publicLapChannels` builds the published entry by **copying
`GRIDDED_CHANNEL_NAMES`**, not by deleting the fields it must not publish. That
is the whole reason the module exists: a scalar appended to `SCALAR_SPECS` later
stays private with no edit here, while a gridded channel appended to
`CHANNEL_SPECS` is published, which is the intent — the point of a shared lap is
the traces.

The stored `trace` is `[x_m, y_m, v]` in a **local projected frame** (migration
0005), so publishing the racing line discloses the shape of the lap and not
where on Earth it happened. That is a property of the existing storage, not
something this spec arranged, but it is load-bearing and should not be
"improved" into lat/lon without revisiting this page.

## Clients

All three render the same thing:

- the leaderboard row is openable iff `lap_id != null`, marked with a chevron
  (colour alone will not do — most rows are not openable);
- the lap page is a time, whose it is, the date and the recorded conditions;
  the racing line; a head-to-head table; and the channel panel;
- **their lap is always side A**, so it keeps its colour whether or not the
  viewer has a lap of their own to put beside it;
- the viewer's side defaults to their own fastest lap at the track, with a
  picker only when there is more than one to pick from;
- a viewer with no telemetry at the track gets the lap alone and a sentence
  saying why there is one side;
- failing to load the viewer's own events costs the comparison, never the page.

**Max RPM is dropped** from the head-to-head the two-lap compare shows: a
stranger's engine speed against yours is a fact about two different cars, not
about the lap.

Three platform differences, each stated at its call site:

- **Web** — a hash route, `#/track/:id/leaderboard/:lapId`, with the viewer's
  pick in `?mine=`.
- **iOS** — a **sheet at every width**, unlike the compare, which NS-34 made a
  column at expanded width: that one is a second reading of the page's own laps
  and belongs beside them, while this is someone else's lap, a detour rather
  than a column. The track screen presents both through a **single**
  `.sheet(item:)`, because two `.sheet` modifiers on one view is the documented
  watchdog crash.
- **Android** — a destination (`Route.LeaderboardLap`), matching how the
  two-lap compare is reached there.

## Threat model, stated honestly

Same posture as NS-33. The server cannot prove a lap was driven, and this spec
does not try to. What it bounds is *disclosure*: a driver who turns the second
flag on publishes exactly one lap per track, chosen by the server, stripped by
an allow-list, and reachable only by another driver who has that track in their
own logbook. Turning the flag off makes every one of those laps 404 immediately
— there is no cached publication, because the flag is read on every request.

What this does **not** defend against: a viewer who screenshots or scrapes what
they were shown. Anything published to other users is published.

## Follow-ups, deliberately not here

- A leaderboard lap on the **track map together with your own line**, rather
  than beside it on the distance axis. It needs the two traces in one projected
  frame, which the stored `[x, y, v]` local frames are not.
- **Sector splits against the leaderboard lap** on the phones. The web gets
  them free through `sectorTableHtml`; the native panels would need the sector
  table wired into this screen the way NS-34 ticket 3 wired it into the
  analysis column.
- A **per-catalog-track leaderboard page** that isn't reached through one of
  your own tracks. Every privacy check here is anchored to "a track the viewer
  has", and lifting that is its own decision.
