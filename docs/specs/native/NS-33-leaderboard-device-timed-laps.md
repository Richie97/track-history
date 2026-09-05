# NS-33 — Leaderboards rank only device-timed laps

**Phase:** post-rewrite · **Platform:** Shared (server, web, iOS, Android) · **Depends on:** the per-track leaderboards (2026-08), NS-30, NS-32 (video import) · **Estimate:** 2 days — one server PR, copy changes on three clients

## Goal

A per-track leaderboard ranks only laps that a device timed — the phone's GPS
recorder or an imported telemetry file. A lap time typed into the app, and an
event's manual "best time" field, stay in the driver's own logbook and never
reach a leaderboard.

Today `GET /tracks/:id/leaderboard` takes each opted-in user's best with the
same `MIN(manual best, best logged lap)` rule as everywhere else. That rule is
right for a logbook — a driver who imports ten years of history from a
notebook should see their real best — and wrong for a ranking, where a typed
`1:29.000` costs nothing and is indistinguishable from a driven one.

## Why "device-timed" and not "GPS"

The request was "only laps that have GPS", and that is the intent: a time the
app *measured* rather than one the driver *asserted*. The stored data has no
per-lap GPS flag, but it has something better: **`sessions.channels`**, the
per-lap telemetry blob every measuring source writes and no hand entry can.
A lap whose time matches an entry in its session's channel data was cut from a
recording by `buildLapChannels`; a lap without one was typed.

Every source that measures a lap produces channels, so the two definitions
agree except in one corner:

| Source | Timed by | Writes `channels` | Ranked |
|---|---|---|---|
| Native GPS recorder (iOS NS-17, Android NS-18), since NS-30/NS-32 | Phone GPS | Yes — cut from the phone's own fixes | **Yes** |
| GoPro `.mp4` import (web, iOS, Android) | GPS (GPMF stream) | Yes | **Yes** |
| Racelogic `.vbo` import (web) | GPS | Yes | **Yes** |
| Corvette PDR `.mp4` with a decodable GPS trace | Car beacon / GPS | Yes | **Yes** |
| Corvette PDR `.mp4` whose coordinates fail the plausibility checks | Car beacon + odometer, no GPS | Yes — odometer-distance grid | **Yes** — see the decision below |
| Native GPS recorder **before** NS-30/NS-32 stored channels | Phone GPS | No (only the best-lap `trace`) | No — see *Rejected alternatives* |
| Hand-entered session (web "Add a session" fallback, native manual entry) | The driver | No | No |
| Laps added later to any session (`POST /sessions/:id/laps`) | The driver | No entry for them | No |
| `events.best_time_ms` (the manual best field) | The driver | — | No |

**Decision: a PDR lap without a GPS fix still counts.** Its time comes from the
car's own beacon and odometer, which is a device, and the recording carries a
speed trace the driver could not have typed. Rejecting it would drop a real
Corvette lap for the sake of the word "GPS". If this is not the intent, the
rule tightens to "channels *and* a session `trace`" with no other change to
the design; that variant is recorded here so it is a one-line decision rather
than a redesign.

## Threat model, stated honestly

Every client talks to an open, authenticated API, and every parser runs on the
client, so the server can never *prove* a lap was driven. What this spec buys
is a bar: today a fake leaderboard time costs one typed number; afterwards it
costs a hand-crafted channel blob that passes `sanitizeChannels`, posted
through the API with a matching lap. That is the difference between an
accident (a driver keying in a remembered time without thinking of the
leaderboard) and a deliberate forgery, and it is the difference the user asked
for. Making forgery expensive beyond that is the follow-up list at the end,
not this spec.

## Fixed decisions

| | |
|---|---|
| The rule | A lap is **device-timed** when its session's `channels` blob contains a lap entry whose `timeMs` equals the lap's `time_ms`. Same matching rule the channel graphs use (`matchLapsToChannels` in `public/js/channel-graphs.js`), applied server-side. |
| Where it is decided | **The server**, in D1, as a trigger-maintained column on `laps`. Clients send nothing new and cannot assert eligibility. |
| Retroactive | **Yes.** The migration backfills every existing lap, so leaderboards are correct the moment it deploys — for every app version, including builds that predate this spec. |
| Response shape | **Unchanged.** `GET /tracks/:id/leaderboard` keeps `{ catalog_id, opted_in, entries: [{ name, best_ms, date, you }] }`. No native model changes, no golden-shape change. |
| Logbook stats | **Unchanged.** `withComputed`, the track page's best, progress charts, share pages and goals keep the `MIN(manual, laps)` rule. Only the leaderboard changes. |
| Tier | Leaderboards stay **Free** (NS-32 table). Import is free on every client, so a free account can be ranked; the recorder is Pro. `stripProFields` nulls `channels` in *responses* and never touches the column, so a lapsed Pro user's recorded laps stay ranked. |

## Server

### Migration `0018_laps_device_timed.sql`

```sql
-- A lap the app measured (GPS recorder or telemetry import) rather than one
-- the driver typed: its session's per-lap channel data carries an entry with
-- this lap's time. Trigger-maintained like every other derived column here,
-- so a support script that inserts laps directly cannot leave it stale.
-- Backfilled on migration so existing recordings rank immediately.
ALTER TABLE laps ADD COLUMN device_timed INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER laps_device_timed_ai AFTER INSERT ON laps BEGIN
  UPDATE laps SET device_timed = EXISTS (
    SELECT 1 FROM sessions s, json_each(s.channels, '$.laps') j
     WHERE s.id = NEW.session_id
       AND json_extract(j.value, '$.timeMs') = NEW.time_ms)
  WHERE id = NEW.id;
END;

-- No route rewrites channels today (PUT /sessions/:id touches label and notes
-- only), but a column derived from another column owes the other column a
-- trigger, or the first edit silently strands it.
CREATE TRIGGER sessions_device_timed_au AFTER UPDATE OF channels ON sessions BEGIN
  UPDATE laps SET device_timed = EXISTS (
    SELECT 1 FROM json_each(NEW.channels, '$.laps') j
     WHERE json_extract(j.value, '$.timeMs') = laps.time_ms)
  WHERE session_id = NEW.id;
END;

UPDATE laps SET device_timed = EXISTS (
  SELECT 1 FROM sessions s, json_each(s.channels, '$.laps') j
   WHERE s.id = laps.session_id
     AND json_extract(j.value, '$.timeMs') = laps.time_ms);
```

Notes for the implementer:

- Ordering already works: `POST /events/:id/sessions` inserts the session
  (with `channels`) first and `insertLaps` after it, so the insert trigger sees
  the blob. `POST /sessions/:id/laps` adds laps with no matching entry, so
  they land as `0` — which is the point: a lap typed into a recorded session
  is still typed.
- `json_each(NULL, …)` yields no rows, so a manual session's laps are `0`
  without a special case. `sanitizeChannels` rounds `timeMs` and
  `sanitizeLaps` rounds `time_ms`, so integer equality is exact, and two laps
  with identical times both match — fine for a ranking.
- The `UPDATE laps` inside the trigger fires the `0011_updated_at` ancestor
  bumps a second time in the same transaction. Harmless (same clock tick), and
  cheaper than making the rule live in route code where a backfill script
  would miss it.
- `laps.time_ms` is never updated by any route. If one ever edits lap times, it
  owes this column an `AFTER UPDATE OF time_ms` trigger too — say so at the
  route.
- No new index: the leaderboard query already reaches laps through
  `idx_laps_session`, and the flag is a filter on rows it has in hand.

### The leaderboard query (`src/routes/tracks.ts`)

The `UNION ALL` collapses to one branch. The manual-best branch goes, and the
laps branch gains `AND l.device_timed = 1`:

```sql
SELECT b.user_id, u.name, MIN(b.ms) AS best_ms, b.d AS date
FROM (
  SELECT t.user_id AS user_id, l.time_ms AS ms, e.start_date AS d
    FROM tracks t
    JOIN events e ON e.track_id = t.id
    JOIN sessions s ON s.event_id = e.id
    JOIN laps l ON l.session_id = s.id
   WHERE t.catalog_id = ?1 AND l.device_timed = 1
) b
JOIN users u ON u.id = b.user_id
WHERE u.leaderboard_opt_in = 1
GROUP BY b.user_id
ORDER BY best_ms ASC
LIMIT 100
```

Rewrite the comment above the route: it currently says the query pushes
`withComputed`'s rule into SQL, and after this change it deliberately does
not. A future reader who "fixes" the discrepancy re-opens the hole.

### Rejected alternatives

- **Evaluate `json_each(s.channels)` inside the leaderboard query, no
  migration.** Correct and retroactive, but it parses every channel blob of
  every opted-in user's session at the track on every track-page load. A blob
  is up to ~800 KB (`MAX_TOTAL_VALUES`), and a popular track with fifty
  opted-in drivers is hundreds of parses per request. The column costs one
  parse per lap insert instead.
- **A client-asserted provenance field** (`laps.source = 'manual' | 'gps' |
  'telemetry'` sent by the clients). Same trust level as channels — the client
  asserts it either way — but it touches every session-creating path on three
  clients plus both offline layers' optimistic patches, needs the lap row in
  every golden fixture and both native `Lap` models to change, and is not
  retroactive. The channel rule is all of that for free.
- **Rescue pre-channel native recordings via the session `trace`** ("a session
  with a trace is a recording, so its laps count"). The trace is the best lap's
  line only, and `POST /sessions/:id/laps` lets a driver add a typed lap to a
  recorded session — under this rule that lap would rank. The window is small
  (recorder GA to NS-30 on iOS, to NS-32 on Android, both in August 2026) and
  those sessions keep their logbook standing; they just don't rank. Recording
  the day again does.
- **Requiring a `trace` as well as channels** (the strict "GPS" reading). Drops
  PDR laps whose coordinates failed to decode; see the decision above. Kept as
  the documented one-line variant.

## Clients

No model, request, or offline-layer change on any client: the rule is
server-side and the response shape is unchanged. What changes is **copy**, in
the same three places on each client, so a driver whose logbook best beats
their leaderboard row understands why.

1. **The leaderboard section's lead line** (web `leaderboardHtml` in
   `public/app.js`; iOS `TrackScreen.leaderboardSection`; Android
   `LeaderboardCard`): "Best laps by Track Evolution drivers at this track —
   opt-in only." becomes "Best **device-timed** laps by Track Evolution
   drivers at this track — opt-in only. Laps recorded with the app or imported
   from telemetry count; hand-entered times don't."
2. **The join/leave privacy copy** (the same three places, plus Settings on all
   three): "your name and your best lap" becomes "your name and your best
   device-timed lap". The privacy promise — exactly two things — is unchanged
   and the copy must keep saying so.
3. **A viewer-specific hint** under the table, rendered from data the track
   page already has (the viewer's track best comes from the events list; the
   ranked best is the `you` row):
   - opted in, no `you` row, viewer has laps or a manual best at the track:
     "None of your laps here were timed by a device, so you aren't ranked yet.
     Record with the app or import telemetry to appear."
   - opted in, `you` row slower than the viewer's track best: "Your best here
     (`1:29.500`) was entered by hand and isn't ranked."
   - otherwise nothing.

   The web app renders this from `viewTrack`'s already-fetched events; the
   native track models hold the same list. Wording is shared verbatim across
   the three, as the existing leaderboard copy is.

The "Leave the leaderboards?" confirmation, the Settings toggle label
("Appear on per-track leaderboards") and the opt-in write's off-the-queue rule
are untouched.

## Documentation

Part of the same PR, per AGENTS.md:

- `README.md` *Sharing & leaderboards*: replace the sentence about the
  `MIN(manual best, best logged lap)` rule with the device-timed rule and the
  `laps.device_timed` column; note that logbook stats keep the old rule.
- `site/docs/data-model.html` *Leaderboards*: add the rule in user terms
  ("only laps the app timed — recorded with the phone or imported from
  telemetry — are ranked; times you type in stay in your logbook") and keep the
  layout sentence.
- `site/docs/privacy.html`: "your name and best lap" → "your name and best
  device-timed lap" in both places. Wording-only; no data-collection change,
  so no effective-date bump.
- `site/index.html` feature card: "stack your best lap" → "stack your best
  recorded lap".
- `AGENTS.md`: the `tracks.ts` route description and the *Database* paragraph
  (a new trigger-maintained column; migration 0018).
- `docs/specs/native/README.md`: this spec in the post-rewrite table and a
  line on the leaderboards bullet under *Post-rewrite feature decisions*.

## Contracts

- `contracts/golden/track-leaderboard.json` — shape unchanged, **content
  changes**: the capture's rich event has a manual best of `121500` and a
  channel-bearing session at `121900`, so the `you` row moves to `121900`.
  Regenerate with `npm run contracts:generate`; both native golden tests keep
  decoding and re-encoding it unchanged. Keep a channel session on that
  track — a capture with an empty `entries` would stop pinning the row shape.
- No `contracts/logic/` fixture: nothing pure is ported, the rule lives in SQL.

## Tests

`test/api/leaderboard.test.ts` — the `trackDay` helper grows a `channels`
option that builds a valid blob for the given laps (the twelve-point arrays
`test/api/sessions.test.ts` already uses):

- **A manual event best never ranks**, even when it beats every lap. Replaces
  "takes the better of a manual best and logged laps".
- **A hand-entered session never ranks**: laps posted with no `channels` leave
  the user off the board, and `opted_in` is still reported.
- **Channel-backed laps rank**, across two accounts, ordering by the best
  device-timed lap rather than the best lap.
- **Partial coverage inside one session**: laps `[95000, 93211]` with a
  channel entry for `95000` only → the user's row is `95000`.
- **Laps added afterwards to a recorded session** (`POST /sessions/:id/laps`)
  don't rank.
- **Insert directly through D1** (as `helpers.ts` does for users) with
  `channels` present and absent, and assert `device_timed` — pins the trigger
  rather than the route.
- **Backfill**: the API tests apply every migration to a fresh D1, so the
  backfill can't be exercised there; cover it by running `0018` against a
  `wrangler d1` local database seeded from `seed/seed.sql` before merging and
  eyeballing `SELECT device_timed, COUNT(*) FROM laps GROUP BY 1`. Say so in
  the PR.
- `test/api/entitlement-gates.test.ts` is unaffected: no gate is added.

Existing tests that keep passing are the ones about what does *not* leak:
non-opted-in users, unknown catalog tracks, other users' track ids.

## Acceptance criteria

1. Every existing session with `channels` ranks its matching laps after the
   migration; every hand-entered lap and every `events.best_time_ms` stops
   ranking — on every client build, without an app update.
2. `GET /tracks/:id/leaderboard`'s JSON shape is byte-for-byte the golden
   shape; only values differ.
3. The track page's best, progress chart, share page and goals are unchanged
   for the same data.
4. The leaderboard section on web, iOS and Android states the rule, and a
   driver whose logbook best is hand-entered is told why the row differs.
5. README, the docs site's data-model and privacy pages, and AGENTS.md
   describe the rule; `npm run contracts:check` is clean.

## Follow-ups (out of scope, listed so the bar can be raised later)

- **Plausibility on write.** Integrate the stored `speed` array over
  `dStepM` (the unscaled total `lapTimeSeries` already computes) and reject a
  channel lap whose integral disagrees with `timeMs` by more than a tolerance.
  Real sources agree by construction — the recorder cuts channels from the same
  fixes that timed the lap, and PDR's speed and odometer share a clock — so the
  check only bites a forgery. Needs a tolerance measured against the committed
  clips first.
- **A per-lap badge.** Exposing `device_timed` on lap rows would let the
  event page mark recorded laps. That is a lap-row shape change on every
  golden fixture, both native `Lap` models and both offline layers' optimistic
  laps, so it is its own spec.
- **Rate and range limits** on leaderboard-visible times (a lap faster than
  the catalog track's record by a margin) — a catalog column that doesn't
  exist yet.
