# NS-52 — Coach comments on sessions and laps

**Phase:** post-rewrite · **Platform:** Shared (server, web, iOS, Android) · **Depends on:** NS-38 (grants, the coach mount, `LogbookOwner`), NS-51 (the lap stage and the panel's cursor, for placed comments), `Corners` (#189) · **Estimate:** 3–4 weeks across three PRs — server + shared logic + web, then iOS, then Android · **Issue:** [#447](https://github.com/Richie97/track-history/issues/447)

## Goal

A coach reading a student's logbook can say something about what they see: on
a **session**, on a **lap**, or at a **place on a lap**. The student reads it
where it was said and can reply.

```
Coach, on Alex's lap 6                       Alex, on their own lap 6
┌────────────────────────────────────┐       ┌────────────────────────────────────┐
│ Lap 6 · 2:02.11 ★                  │       │ Lap 6 · 2:02.11 ★                  │
│ ▂▃▅▇▆▃▂▁▂▅▇  ◆                     │       │ ▂▃▅▇▆▃▂▁▂▅▇  ◆                     │
│ Comments                           │       │ Comments                           │
│  ◆ in T4 · 1,240 m                 │       │  Sam Lee · ◆ in T4 · 1,240 m       │
│  You · 2h ago                      │       │  Brake 10 m later here, you have   │
│  Brake 10 m later here, you have   │  ──▶  │  grip left on entry.     [Reply]   │
│  grip left on entry.    Edit · ✕   │       │                          Report ✕  │
│ ┌────────────────────────────────┐ │       │   You · 1h ago                     │
│ │ Add a comment…   ◆ at 1,240 m ✕│ │  ◀──  │   Tried it in session 4, the rear  │
│ └────────────────────────────────┘ │       │   stepped out. Trail off sooner?   │
└────────────────────────────────────┘       └────────────────────────────────────┘
```

NS-38 left this as its first follow-up: *"the first time two users write to
one logbook. Needs a table, notifications and a moderation story. The grant
table is where its permission will hang."* This is that spec.

## Fixed decisions

| | |
|---|---|
| Who writes | **A coach with a live grant**, on that student's logbook; and **the owner**, in reply. Nobody else, by any route. |
| Threads | **One private thread per coach.** Every comment row carries the `coach_id` whose conversation it is. The student sees all their threads; a coach sees only their own. A student's coaches do not learn of each other today (NS-38 never lists them to one another), and a comment must not be how they start to. |
| Targets | A **session**; a **lap** in it; or a lap plus **`dist_m`**, whole metres from the start/finish line along that lap. Nothing is anchored to an event, a track or a car: an event-level remark is a session comment on the session it is about. |
| A placed comment | Draws a marker on every lap-axis chart and on the track map, and tapping the comment moves the panel's cursor, or seeks the lap stage, to it. `dist_m` is the *lap's own* driven distance, so it needs no grid and survives a re-import that changes `dStepM`. A lap with no telemetry takes comments without a place. |
| Content | **Plain text**, 1–1,000 code points after trimming, newlines kept. Rendered through `esc()` / `Text`; a URL is not made a link. No images, no reactions, no mentions. |
| Shape | **Flat.** A thread on one target is a list in time order. No `parent_id`. |
| Editing | The **author** edits and deletes their own, at any time while they can still reach it; an edit sets `edited_at`, shown as *edited*. The **owner** can delete any comment in their logbook. A coach cannot delete the student's replies. |
| Tier | **Free**, both sides. A coach is any account (NS-38), and a reply is a write to your own logbook's conversation. No route here checks entitlement. A lapsed student's coach can still comment on what they can still see. |
| Reads go where | **Their own routes, never `GET /events/:id`.** The event detail is read by the share pages, the one-item share, the coach views, the MCP tools, the export and three offline mirrors; a `comments` field on it would have to be stripped in each. A separate read is stripped in none. |
| The coach mount | **Stays GET-only and untouched.** A comment is the coach's own data, written and read through the coach's own `/api/coaching/students/:id/…`, where `userId` is the coach and the grant is checked in the statement. No handler under the mount ever needs to know which coach is asking, so a forgotten filter cannot show one coach another's thread. |
| When a grant ends | The comments **stay in the student's logbook**, under the coach's name, and the thread closes: the student can read and delete but not reply, and the ex-coach can no longer read, edit or delete. A coach who wants a comment gone deletes it before leaving. Re-accepting a later invite reopens the same thread. |
| Account deletion | `coach_comments` cascades from `users` three ways (student, coach, author), so deleting either account removes everything it wrote or received. |
| Never shown | The public share page, the one-item share (NS-48), the leaderboard lap, Season Wrapped, OG tags, **the MCP tools**. |
| Notifications | **In-app only in v1**: an unread count on `/me`, a card on the dashboard, a list on the Coaching page. No push and no email: the Worker has no APNs / FCM sender and sends no mail today, and each is its own project (below). |
| Offline | Reads are cached like any GET. **Writes are live**, off every offline queue: *"Commenting needs a connection."* The typed draft is kept until it sends. |
| Moderation | Invite-only is the first line: nobody can comment on a logbook they were not invited to. Then: the owner deletes; *Remove coach* / *Stop coaching* is the block; every comment written by the other person carries **Report**; a per-author rate limit and per-thread caps. |
| Clients | **All three**, both roles. |

## Server

### Migration `0036_coach_comments.sql` (or the next free number when it lands)

```sql
CREATE TABLE coach_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- never reused, so a reported id stays unambiguous
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- whose logbook
  coach_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- whose thread
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- student_id or coach_id
  event_id   INTEGER NOT NULL REFERENCES events(id)   ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  lap_id     INTEGER REFERENCES laps(id) ON DELETE CASCADE,
  dist_m     INTEGER,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  edited_at  INTEGER,
  seen_at    INTEGER,                      -- by the one reader who is not the author
  CHECK (student_id <> coach_id),
  CHECK (author_id IN (student_id, coach_id)),
  CHECK (dist_m IS NULL OR lap_id IS NOT NULL)
);
CREATE INDEX coach_comments_event  ON coach_comments(event_id, coach_id);
CREATE INDEX coach_comments_unread ON coach_comments(student_id, coach_id, seen_at);
```

Three things about it:

- **`coach_id` references `users`, not `coach_grants`.** The grant decides who
  may *write and read as a coach*; the row outlives it, which is what lets the
  comments stay with the student after a revoke.
- **`event_id` is denormalised** from the session so the per-event read and the
  unread feed need no join through `sessions`. It is set by the insert's own
  `SELECT` from the ownership-scoped session and never by the body. No route
  moves a session between events; one that starts to owes this column an
  update.
- **No trigger bumps `updated_at`.** A comment is not an edit of the logbook
  (the `item_shares` rule), and `prefetch.js` must not re-fetch an event
  detail that has not changed. Because each row has exactly one reader who is
  not its author, **one `seen_at` column is the whole read state**.

A lap's comments go when the lap does. Lap ids are stable for this: no route
rewrites a session's laps (`sessions.ts` appends one with `POST
/sessions/:id/laps` and deletes one with `DELETE /laps/:id`, nothing else), so
a comment cannot be orphaned by an edit. A route that starts replacing laps
owes this table a re-key on `(session_id, lap_num)`.

### `src/lib/comments.ts` (pure, unit-tested)

- `COMMENT_MAX_CHARS = 1000`, `MAX_DIST_M = 100_000`,
  `MAX_THREAD_COMMENTS = 200` (per coach per session),
  `FEED_LIMIT = 50`.
- `sanitizeComment(v)` → `{ comment: { body, lap_id, dist_m } }` or
  `{ error }` naming the rule, the `sanitizeProfile` pattern. `body` is
  trimmed, 1–1,000 code points, control characters other than `\n` refused.
  `dist_m` is a whole number in `0…MAX_DIST_M` and only with a `lap_id`.
  Unknown keys are dropped.
- `commentView(row, viewerId)` — the response row, built by **allow-list**:
  `{ id, coach_id, session_id, lap_id, dist_m, body, created_at, edited_at, author: { id, name, picture }, mine, seen }`.
  `mine` is `author_id === viewerId`; `seen` is `seen_at != null` — on a row
  the viewer wrote it is the read receipt, on any other the viewer's own
  unread mark. Never an email.

### Routes (`routes/comments.ts`, an ordinary `/api` router, in `API_ROUTERS` with no gate)

The owner, on their own logbook (`userId` = the student):

| Route | |
|---|---|
| `GET /events/:id/comments` | `{ comments: [...], coaches: [{ id, name, picture, active }] }` — every thread on the event's sessions, oldest first; `coaches` names each thread's coach and whether the grant is still live (a closed thread shows no reply box). 404 for an event that is not the caller's. |
| `POST /sessions/:id/comments` | `{ coach_id, body, lap_id?, dist_m? }` → 201 `{ comment }`. The owner's reply into that coach's thread. `INSERT … SELECT` from the owned session **joined to a live `coach_grants` row**; zero rows is a 404 (not your session, not a lap of it, or not your coach). |
| `POST /events/:id/comments/seen` | `{ ok, seen }` — stamps `seen_at` on the event's rows the caller did not write. |

The coach, on a student's (`userId` = the coach; every statement joins
`coach_grants` on `(student_id, coach_id = userId)`, and no grant is a 404,
never a 403):

| Route | |
|---|---|
| `GET /coaching/students/:sid/events/:eid/comments` | `{ comments: [...] }` — the caller's thread only (`coach_id = userId`). |
| `POST /coaching/students/:sid/sessions/:id/comments` | `{ body, lap_id?, dist_m? }` → 201 `{ comment }`. `coach_id` and `author_id` are the caller; never read from the body. |
| `POST /coaching/students/:sid/events/:eid/comments/seen` | as the owner's. |

Either, on one row:

| Route | |
|---|---|
| `PUT /comments/:id` | `{ body }` → `{ comment }`. `WHERE id = ? AND author_id = userId`, and for a coach author the grant must still be live. Sets `edited_at`; leaves `seen_at`. |
| `DELETE /comments/:id` | `{ ok }`. The author (grant live, if a coach) **or** the row's `student_id`. |

And the feed, for both roles at once:

| Route | |
|---|---|
| `GET /coaching/comments` | `{ unread, comments: [...] }` — the newest `FEED_LIMIT` rows **addressed to** the caller (written by someone else, in a thread the caller can currently read), each with `{ ...comment, student: { id, name } \| null, event_id, track_name, start_date, session_label, lap_num }`. `student` is null when the logbook is the caller's own, so a client knows whether the link is `#/event/:id` or `#/student/:id/event/:id`. |

Also:

- `GET /me` gains `user.comments_unread` (one indexed `COUNT` joined into the
  existing batch), which is what the badge reads. `GET /coaching` gains
  `unread` on each `coaches[]` and `students[]` entry.
- **Limits, folded into the insert**: `MAX_THREAD_COMMENTS` per coach per
  session (409 `{ error: "too many comments on this session" }`), and a
  `COACH_COMMENTS` rate-limit binding, 20 a minute per author, through
  `withinLimit` (429 with `Retry-After`).
- `Cache-Control: no-store` on none of it: these are ordinary cached `/api`
  reads. `sw.js` and the offline layer treat them as any other GET.
- `DELETE /coaching/coaches/:id` and `…/students/:id` are unchanged: they
  delete the grant, and the comment routes' grant join does the rest.
- **The export** (NS-44): each session in `logbook.json` gains `comments`
  (body, dates, place, the author's display name), and the document a
  top-level `comments_written` for what the account wrote on other logbooks,
  without the student's data beyond their name. The CSVs are unchanged.
- **The MCP tools**: nothing. `apiGet` can only reach what a tool builds a
  request for, and no tool builds one for these paths; `ai-tools.test.ts`
  gains an assertion that a populated thread appears in no tool result.

### Tests (`test/api/comments.test.ts`, `test/unit/comments.test.ts`)

- A coach comments on a session, a lap and a place; the student reads all
  three and replies; each sees the other's `seen` flip after `/seen`.
- **Two coaches, one student**: coach B's read, feed, edit and delete never
  touch coach A's thread, and B's responses contain neither A's id nor name.
- Every refusal is a 404 with an identical body: no grant, another student's
  session, a `lap_id` from a different session, a comment id that exists but
  is not yours.
- After a revoke: the coach's read, write, edit and delete are 404; the
  student still reads the thread, `coaches[].active` is false, a reply is 404;
  re-accepting a new invite reopens it.
- Deleting the lap, the session, the event, the student or the coach removes
  the rows (the cascade through `users` asserted, as for `lap_clips`).
- `GET /events/:id`, `/api/share/:slug`, `/api/share/(e|s)/:token`, every
  `COACH_ROUTES` path and `logbook.json`'s forbidden-key walk are byte-for-byte
  unaffected by a populated thread, except the export's two new members.
- The rate limit and the per-thread cap; `sanitizeComment`'s rules, including
  a 1,001-code-point body of astral characters.
- `entitlement-gates.test.ts`: the router listed, nothing gated; a free
  student and a free coach both write.

## Shared pure logic (web first, then ported)

`public/js/comments.js`, ported as `Comments` to the Kit and `:core` under the
same names and pinned by `contracts/logic/comments.json`:

- `COMMENT_MAX_CHARS`, mirroring the server's and pinned to it by a unit test.
- `groupComments(comments, sessions)` → per session,
  `{ session: [...], laps: [{ lap_id, lap_num, comments }] }`: session-level
  first, then laps in lap order, a lap's comments by `dist_m` (unplaced last)
  then time. A comment whose lap is no longer in the session is dropped.
- `commentCounts(comments)` → `{ bySession, byLap }`, for the chips' markers,
  with an `unread` flag on each.
- `commentPlace(distM, lapLengthM, corners, units)` → `"in T4 · 1,240 m"`,
  through `cornerPlace` (`video-sync.js`) and `fmtDist`; the distance alone
  with no corners; null with no `dist_m`. The corner is derived at render
  time from the session's own `sessionCorners`, never stored, so it is the
  app's numbering the reader's panel shows.
- `commentMarkers(comments, lapId, lapLengthM)` → `[{ id, frac, mine }]`,
  the map and chart markers; a `dist_m` past the lap's end is clamped.
- `placeFromCursor(k, dStepM)` → whole metres, the composer's *at 1,240 m*.
- `canReply(coach)`, `commentError(err, offline)` (the offline sentence, the
  429, the cap), `unreadLine(feed)` (*"Sam Lee commented on Lap 6 · VIR"*,
  *"3 new comments from 2 coaches"*), `threadTitle(coach, isOwner)` and every
  fixed sentence, so no client words one differently.

Response shapes are pinned by new goldens (`comments-event`,
`comments-student-event`, `comment-created`, `comments-feed`, and
`me` / `coaching` re-captured), with `Comment` / `CommentFeed` models in the
Kit and `:core` landing **with the server ticket**, since both golden suites
fail on a capture no model maps.

### As built (ticket 1, server + web)

- The helpers take the shapes the web needed, and the ports follow these, not
  the list above: `commentThreads(comments)` splits an event's comments by
  coach; `groupComments(comments, session)` orders one session's;
  `commentPlace(distM, dStepM, corners, units)` takes the grid step, since
  `cornerPlace` works in grid indexes; plus `commentLength`,
  `commentCountText`, `commentWhen`, `feedTarget` / `feedLine`,
  `coachAudienceNote` and the report mail's subject and body.
  `commentError(status, message)` takes the status, null for no answer.
- The decode models are `CoachComment`, `EventComments`, `CommentSaved`,
  `CommentsSeen` and `CommentFeed` (`Comment` alone collides with nothing
  today, but says less).
- The owner's `coaches` lists only coaches with a thread on that event, so the
  owner can reply but not open a thread; the server would accept one.
- **Markers**: `showCommentMarks(root, marks)` in `channel-graphs.js` draws a
  diamond on each lap-axis chart's top edge, in the lap's slot colour, for
  every lit lap's placed comments; the panel re-applies them after each chart
  render through `setNotes(fn)` on its handle, which also feeds its own map.
  `renderTrackMap`'s handle gained `setNotes(fracs)`, and the event's map
  shows every lap's when it is that session's line. They take no pointer
  events: the comment in the list is what opens the place.
- **The lap stage**: while one is open the composer's *At the marked place*
  reads the playhead (side A first) instead of the pinned cursor, and a
  placed comment seeks the stage rather than pinning.
- **The export**: `comments` on each session of `logbook.json` (`lap_id`,
  `dist_m`, `body`, the dates, the author's name, `by_you`) and a top-level
  `comments_written` for what the account wrote as a coach, by the driver's
  name and the event's track and date, with no id of theirs.
- Neither native suite could be run where this was built (no Swift toolchain,
  and Gradle could not reach Google's Maven), so the decode models were
  checked by CI first.

### As built (ticket 3, Android)

- `Comments` in `:core` is the port, under the JS names (the JS objects
  become small data classes: `Thread`, `Grouped` / `LapComments`, `Counts` /
  `Count`, `Marker`), pinned by `CommentsTest` against every row of
  `comments.json`. `groupComments` takes `(comments, sessionId, laps)` with a
  `Session` overload.
- The routes on `ApiClient` take the `LogbookOwner` whose logbook it is and
  always run on `ApiClient.own`, so a coach's comment leaves from the
  student's scoped view while that view keeps refusing every other write.
- The session composer is **an inline row on the session card**, as above:
  the text box and a row of chips (*Whole session* / *Lap N*), collapsed to a
  button until opened. The lap page's composer is inline under the stage and
  is offered on a lap with no comments yet — always to a coach, and to the
  owner for each coach whose thread on the event is open. Drafts are in the
  destination's `SavedStateHandle`, keyed by target.
- The composer's place is taken on a tap (*◆ At the marked place*) from the
  stage's playhead or the panel's parked mark, never read in composition;
  before the line there is no place and it says so.
- Markers: a diamond on each lap-axis chart's top edge (a draw-phase overlay
  beside the playhead's), and a pin on every map of the session — on the lap
  page, the session compare, and the event page's best-lap trace and its
  expanded-width analysis column.
- The block control is on each comment someone else wrote (*Remove coach* /
  *Stop coaching*), beside *Report*, as well as on the Coaching page.
- Run: `:core:test`, `:core:check`, `:app:testDebugUnitTest`,
  `:app:assembleDebug`, `:app:checkReleaseHasNoCarApp`, and the debug build
  on an emulator against `wrangler dev`.
- Release step, outside any build: Play's Data safety form gains *other user
  content, shared with other users*.

## Clients

One rule first, because all three have a read-only seam that this is the
exception to. A student's logbook is read-only **except for the comment
composer**: the web's `readOnly()`, iOS's `owner.isReadOnly` and Android's
`readOnly` keep hiding every other control, and the comment calls go through
the **unscoped** client (the web's `api(path, { own: true })`, which skips the
`viewing` prefix and its write refusal; `auth.api` rather than
`.scoped(to:)` on iOS; the base `ApiClient` rather than `forOwner` on Android).
The scoped clients keep refusing every write, which their tests still pin.

### Web

- **Session card** (owner's `viewEvent` and the student view of it): a
  *Comments* block under the laps, collapsed to a count when empty of unread —
  session-level comments, then each lap's under *Lap 6 · 2:02.11*. A lap chip
  with comments carries a marker (and a dot when unread), through
  `bindChannelGraphs`' `chipAfter` hook beside the ▶.
- **Composer**: a textarea with a target select (*Whole session* / *Lap N*).
  When the channel panel has a pinned cursor (`memory.pin`) or the lap stage
  is open on that lap, it offers a removable **◆ at 1,240 m** chip, pre-set to
  that lap. The owner's composer sits under a coach's thread as *Reply*; with
  two coaches' threads on one target each has its own.
- **Markers**: `commentMarkers` on the lit lap, drawn by `channelChartSvg` as a
  ◆ on the axis and by `renderTrackMap`'s `markers` option. Clicking a placed
  comment calls `showDistanceMark` / pins the cursor, or seeks the stage.
- **Unread**: the account menu's *Coaching* link and the dashboard carry it. The
  dashboard gets one card above the tracks (`unreadLine`, linking to the
  newest); `#/coaching` gets a *Recent comments* list from the feed. Opening
  an event's comments posts `/seen` once they have rendered, never from
  `prefetch.js`.
- **Report** opens `mailto:eric@speedshift.io` with the comment id and the
  reporter's account in the body; *Remove coach* sits beside it for the owner.
- **Shared item and share pages** (`sharedView`, `shareShell`) render no block.
- Drafts are held in `sessionStorage` per target and cleared on a 201.

### iOS and Android

- **Lap page** (`LapDetailScreen` on both): a *Comments* card under the stage,
  the lap's comments in place order, the composer, and *◆ at …* from the
  stage's playhead or the panel's parked mark. Markers are drawn in the
  charts' overlay layer (`AxisMarkLayer` / `playheadOverlay`'s draw phase) and
  as `TrackMap` dots, never as chart data, for the reason the playhead is not.
- **Event page**: each session card shows its session-level comments and a
  count on lap rows (spoken: *"2 comments, 1 unread"*). The composer for a
  session comment is a pushed form on iOS (the event page's one `.sheet` is
  taken) and an inline row on Android (no `OutlinedTextField` in an
  `AlertDialog`, the Robolectric rule).
- Each comment card is one accessibility element with **named actions**
  (*Reply*, *Edit*, *Delete*, *Report*, *Show on lap*), the chart-card rule.
- **Drafts**: `AppRouter.heldFields` on iOS, the `SavedStateHandle` on Android,
  keyed by target, so a fold or a rotation keeps the text.
- **Unread**: a dashboard card on both; the Coaching row in Settings carries
  the count. The dashboard fetches the feed beside `/garage` and swallows its
  failure.
- The comment routes are live writes, absent from both `isQueueable`s
  (`OfflineStoreTest` / `OfflineStoreTests`), and `forgetStudent` also drops
  the cached `/coaching/students/<id>/…` responses.
- Analytics: no new route on either platform if the composer stays inline; a
  pushed form on iOS is `/event/:id/session/:id/comment`.

## Privacy, legal and stores

- **Privacy policy** (bump the date): comments are messages between a driver
  and the coaches they invited; who can read them; that they stay with the
  driver after a coach is removed; deletion with either account.
- **Terms of use** (bump the date): an acceptable-use sentence covering what
  one user writes to another, and that reported content may be removed.
- **Store rules, which no build enforces**: App Review guideline 1.2 and
  Play's user-generated-content policy both require a way to **report** content
  and **block** its author in the build that introduces UGC. *Report* and
  *Remove coach* / *Stop coaching* are that, and must be in ticket 2 and 3's
  builds, not a follow-up. The App Privacy label and the Data safety form gain
  *other user content*, shared with other users.

## Docs owed (in the same PRs)

- NS-32's tier table: *Coach comments — writing and reading, both roles*
  (Free; no gate).
- NS-38: strike the follow-up; `docs/specs/native/README.md`'s split note (all
  three).
- `AGENTS.md`: `routes/comments.ts`, `lib/comments.ts`, the migration, the
  read-only seam's one exception on each client, `comments.js` and its
  fixture, the goldens.
- `README.md`; `site/docs/index.html` (*Share with a coach* gains comments);
  `site/docs/data-model.html`'s privacy section; `site/llms.txt`.

## Tickets

1. **Server + shared logic + web** ([#448](https://github.com/Richie97/track-history/issues/448)): the migration, `comments.ts` ×2, tests,
   goldens with their native decode models, `comments.js` and its fixture, the
   web's blocks, composer, markers and unread surfaces, the docs. **7–9 days.**
2. **iOS** ([#449](https://github.com/Richie97/track-history/issues/449)): the `Comments` port, lap page card, event page, markers,
   dashboard card, report and block, UI test with a second account's token
   (`CoachingUITests`' pattern). **5–6 days.**
3. **Android** ([#450](https://github.com/Richie97/track-history/issues/450)): likewise. **5–6 days.**

## Acceptance criteria

- [ ] A coach comments on a session, a lap and a place on a lap, from any client; the student sees each on the same session or lap on any client, with the coach's name.
- [ ] The student replies, and the coach sees the reply; each side's unread count rises and clears on reading.
- [ ] A placed comment shows as a marker on the charts and the map on all three, and opening it moves the cursor or the lap stage there.
- [ ] With two coaches, neither can read, count or infer the other's thread; a test asserts it against responses, not just rows.
- [ ] After a revoke the coach can reach nothing, the student keeps the thread read-only, and a reply is refused.
- [ ] The author edits and deletes their own; the owner deletes anyone's; nobody else can.
- [ ] Comments appear on no share page, no one-item share, no leaderboard lap, no Wrapped page and no MCP tool result.
- [ ] No comment write is ever queued offline; a failed send keeps the draft.
- [ ] *Report* and the block control are present wherever another person's comment is shown.
- [ ] `npm test`, `npm run typecheck`, `npm run contracts:check`, `swift test`, `:core:check`, `:app:testDebugUnitTest` pass.

## Open question (decide in ticket 1)

- **Whether `GET /events` should carry a per-event comment count** so the
  events list can mark a row. v1 says no (the feed and the dashboard card
  carry it); revisit if students miss comments on older events.

## Follow-ups, deliberately not here

- **Push notifications** (*"Sam commented on your lap"*): needs an APNs / FCM
  sender, device-token storage, a permission prompt and both store
  disclosures.
- **Email digests**: the Worker sends no mail today.
- **Coaches seeing each other's comments**, as a per-student setting, for a
  student whose instructors work as a team.
- **Coach sign-offs** (NS-41's follow-up): a coach recording a milestone on a
  student's event. Same permission, a different write.
- **The AI assistant reading a human coach's comments**, with the coach's
  name withheld.
- **Comments on a time range, a corner or a compare** (*"T4 across laps 5–7"*).
