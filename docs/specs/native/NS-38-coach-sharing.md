# NS-38 — Share with a coach

**Phase:** post-rewrite · **Platform:** Shared (server, web, iOS, Android) · **Depends on:** NS-32 (tier), NS-34 (large screens), NS-37 (the Garage tab), the share page, the MCP read path (`apiApp(auth)`, #314) · **Estimate:** 4–5 weeks across four PRs — server, web, iOS, Android, in that order · **Issue:** [#338](https://github.com/Richie97/track-history/issues/338)

## Goal

A driver with Pro can give an **instructor or coach** read-only access to their
logbook: every event, session and lap, **the full channel panel** (the
analysis, not just the times), and the high-level garage — the car, its
modifications, and its geometry. The driver also fills out a **driver
profile** (occupation, experience, safety gear, goals, anything the
instructor should know) that their coaches see beside the data.

The coach signs in with their own account — free is enough — opens a
*Students* list, and reads the student's logbook through the same screens the
student uses, read-only.

```
Student (Pro)                                   Coach (any account)
Settings → Coaching                             Settings → Coaching → Students
┌──────────────────────────────┐                ┌──────────────────────────────┐
│ Your coaches                 │                │ Students                     │
│  Sam Lee · viewed 2h ago  ✕  │                │  Alex R. · 14 days · VIR     │
│ [ Invite a coach ]           │   link / QR    │  ─────────────────────────── │
│   trackevolution.app/coach/… │ ─────────────▶ │ Viewing Alex's logbook       │
│   expires in 7 days          │                │   (read-only)                │
└──────────────────────────────┘                └──────────────────────────────┘
```

## Why

The share page (`/share/<slug>`) is deliberately a brag sheet: it strips
per-lap data, notes and everything telemetry, because anyone with the link
can read it. An instructor needs the opposite: the traces, the corners and the
friction circle, for one known person, revocably. The MCP connector solved the
same problem for an AI assistant (read-only, audience-bound, through the API
itself); this is the human version.

## Fixed decisions

| | |
|---|---|
| Who can share | **Pro, to create an invite.** Accepting needs only a signed-in account. |
| Whose tier applies | **The student's.** The coach's reads run with the student's `entitledUntil`, so `stripProFields` decides `channels` by the student's tier: a Pro student's free coach sees the full panel, and a lapsed student's coach sees the free half, the same as the student does. Grants survive a lapse; a lapse loses Pro reads, never access. |
| What is shared | **Lap data always**: tracks, events, sessions, laps, `channels`, traces, conditions. **The high-level garage**: `/vehicles`, meaning the name, the *modifications & notes* field, the catalog link, wheelbase, steering ratio, target hot pressure and default. **The driver profile.** Nothing else. |
| What is never shared | Email, billing and entitlement details (the coach gets one `pro` boolean, below), AI connections, leaderboard consents, the share slug, event/session/track **notes**, the prep **checklist**, **costs**, garage **consumables** (`/garage`: parts, wear, hours, odometer), **setup sheets**, the **leaderboards** (other drivers consented to be seen by drivers at the track, not by your coach), and **Season Wrapped**. |
| Scope | **The whole logbook**, including events added after the grant. No per-event or per-track grants, and no expiry on a grant: it lasts until either side revokes it. |
| Access | **Read-only, enforced by the server.** The coach mount answers only `GET`, only on an allowlist of paths. Anything else is a 404 (never a 403, which would confirm the student exists). |
| Identity | **Account to account**, through a single-use invite link. No anonymous "anyone with the link" mode: it can be forwarded, and can't be revoked for one person. |
| Clients | **All three**, both halves (granting and viewing). |
| Profile visibility | The owner and their coaches. **Never** the public share page, the leaderboards, OG meta or the MCP tools. |

## Server

### Migration `0031_coaching.sql`

```sql
CREATE TABLE coach_grants (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coach_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_viewed_at INTEGER,
  UNIQUE (student_id, coach_id),
  CHECK (student_id <> coach_id)
);
CREATE INDEX coach_grants_coach ON coach_grants(coach_id);

CREATE TABLE coach_invites (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,      -- sha256Hex, like auth_sessions
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  expires_at INTEGER NOT NULL           -- 7 days
);

ALTER TABLE users ADD COLUMN profile TEXT;  -- JSON, sanitizeProfile (lib/profile.ts)
```

Account deletion is already a `DELETE FROM users` cascade, so grants,
invites and the profile go with either account.

### Invites and grants (authed, `routes/coaching.ts`, under `/api`)

| Route | |
|---|---|
| `POST /coaching/invites` | **Pro** (`requireEntitlement`). Returns `{ id, url, expires_at }`, where `url` is `https://<host>/coach/<token>` and the 32-byte token is stored hashed. At most 10 open invites and 10 coaches per student. |
| `DELETE /coaching/invites/:id` | Withdraw an unused invite. |
| `GET /coaching` | `{ coaches: [{ id, name, picture, since, last_viewed_at }], students: [{ id, name, picture, since, event_count, last_event_date }], invites: [{ id, created_at, expires_at }] }`, both directions in one call. `event_count` and `last_event_date` count past events only, on the totals' rule. An invite's link is not listed: only its hash is stored, so it is shown once, at creation. |
| `GET /coaching/invites/:token` | Preview for the accept screen: `{ student: { id, name, picture }, expires_at, own, already_coach }`. 404 if unknown, used or expired. |
| `POST /coaching/invites/:token/accept` | 201 `{ student: { id, name, picture } }`. Creates the grant and burns the invite — the burn is a `DELETE … RETURNING`, so of two people accepting at once exactly one gets the grant. 400 for your own invite, 409 if already a coach of this student or the student has 10; none of the three burns the link. Not rate-limited: a token is 256 random bits, so guessing is not the threat. |
| `DELETE /coaching/coaches/:coachId` | The student revokes. |
| `DELETE /coaching/students/:studentId` | The coach leaves. |
| `GET` / `PUT /me/profile` | The owner's profile. `GET` answers `{ id, name, picture, pro, profile }` — the same shape a coach reads under the mount, which is why it carries the name and the tier. `PUT` takes `{ profile }` (null clears) and answers `{ ok, profile }` with the stored, trimmed profile, or a 400 naming the rule that failed. Free. |

`POST /coaching/invites` is a **stated exception** to "no write route checks
entitlement", on the setups rule: an invite is not a recording, and a dropped
one costs a tap. It joins the enumerated set in
`test/api/entitlement-gates.test.ts`, and the router joins `API_ROUTERS`.

### The coach mount: `/api/students/:studentId/*`

A third instance of `apiApp(auth)`, beside `index.ts`'s and the MCP tools', and
registered **before** `/api` the way `/api/share` is. Its middleware,
`requireCoachGrant`:

1. Resolves the caller's session (cookie or bearer, as `requireSession` does),
   joins `coach_grants` on `(student_id, coach_id)` and the student's `users`
   row **in one statement**, and answers 404 when there is no grant.
2. Refuses anything that isn't a `GET`, and any path not on `COACH_ROUTES`,
   with a 404.
3. Sets `userId` to the **student** and `entitledUntil` to the **student's**,
   then calls `next()`. Every route runs unchanged: the ownership scoping,
   `withComputed` and `stripProFields` are the ones the student gets.
4. Touches `last_viewed_at` through `waitUntil` (at most once an hour), and
   passes a 200 JSON response through the path's view on the way out.

`COACH_ROUTES` in `src/lib/coaching.ts` (pure and unit-tested) is **one table
of path and view**, so a route cannot be reachable without a view deciding its
fields: `/me/profile`, `/tracks`, `/events`, `/events/:id`, `/vehicles`,
`/vehicles/:id/steering-fit`, `/catalog`, `/car-catalog`.

Each view **copies allowed fields rather than deleting forbidden ones** (the
rule `publicLapChannels` follows), so a column added to `events` later stays
private until someone adds it to the allowlist. The hidden fields that have a
place in the shape — notes, the checklist, the cost line items and the setup
sheets — are sent empty (`null`, or `[]` for `setups`) rather than dropped, so
the native models, which already treat them as optional, decode a coach
response with no second model; any other field is dropped. `/me/profile`
carries `pro` (under the mount, the student's tier): the coach's client needs
that tier to open the channel panel, see *Clients*.

### Profile: `sanitizeProfile` in `src/lib/profile.ts`

Validated JSON, the `sanitizeSetup` pattern, every field optional:

| Group | Fields |
|---|---|
| About | `occupation` |
| Experience | `first_track_year`, `experience` (karting, autocross, sim… free text), `license` (competition licence, free text), `instruction` (schools and coaching so far) |
| Safety gear | `helmet` (make/model), `helmet_rating` (`SA2020` / `SA2025` / `SAH2020` / `FIA8859` / `M` / `other`), `head_neck` (`none` / `hans` / `hybrid` / `other`), `suit`, `gloves`, `shoes` (booleans), `gear_notes` |
| Coaching | `goals` ("What I want to work on"), `for_instructor` ("Anything your instructor should know — glasses, an old injury…") |

Strings are capped (200 chars; 1,000 for the free-text boxes).
`public/js/profile.js` holds the field spec the three forms render, mirroring
`sanitizeProfile` the way `garage.js` mirrors the setup sheet.

**No birth date and no emergency contact**, by decision (2026-09): an
instructor asks for both at the track, and a logbook that never holds them
never has to protect them — nor, without a birth date, learn a driver's age.
A body carrying either has it dropped like any unknown key.

## Clients

### Shared pure logic (web first, then ported)

`public/js/coaching.js`: `profileSections(profile)` (the coach card's grouped,
non-empty lines) and `coachingSummary` (a student row's line). Ported as
`Coaching` to the Kit and `:core` under the same names and pinned by
`contracts/logic/coaching.json`.

### Tier gates read the student's tier

Every client gate (`canViewChannels`, `canViewChannel`) reads the **viewer's**
`state.entitlement` today. In a student's logbook it must read the
**student's** (`pro` from their profile), or a free coach sees the channels
the server sent and the client locks them. Each client carries this as an
owner context (below), and a test on each platform pins it: a free coach
viewing a Pro student sees the Grip tab unlocked.

### Web

- **Settings → Coaching**: *Your coaches* (last viewed, Revoke), *Invite a
  coach* (the link, a copy button and the system share sheet; shown locked for
  free accounts), open invites with Withdraw, and *Students* when there are
  any. **Settings → Driver profile**: the form from `profile.js`, with a line
  saying who can see it.
- `/coach/<token>`: the accept page. Signed out, the token is parked in
  `sessionStorage` across sign-in (`isSafeNext` stays oauth-only).
- `#/student/:id`, plus `/event/:eid`, `/track/:tid`, `/track/:tid/lap-compare`
  and `/vehicle/:vid` under it: the existing views, given a
  `{ base: "/students/:id", readOnly: true, entitlement }` context. `api.js`
  prefixes the path. Read-only hides every edit, import, delete and checklist
  control; a banner says *"Alex's logbook · read-only"*; the student's profile
  is a card at the top of their dashboard.
- Offline: the prefix keeps the cache keys apart from the coach's own, nothing
  under it is in `QUEUEABLE`, `prefetch.js` skips it, and a 404 under a prefix
  purges that student's cached responses.

### iOS and Android

- The same Settings sections, profile form and accept screen. The invite also
  shows as a **QR code**, for handing it over in the paddock: `CIQRCodeGenerator`
  on iOS; on Android either `zxing:core` (one small, dependency-free jar) or a
  share-sheet-only v1, decided in the ticket.
- `/coach/<token>` joins the AASA components (`wellKnown.ts`), Android's
  App Links intent filter and both `DeepLink` tables — **in the client
  tickets, not the server one**: Apple's CDN caches the association file, and
  an installed app that claims `/coach/*` before it can handle it would
  swallow every invite link into a screen that drops it. A link opened signed-out
  is parked until sign-in, the way billing holds a purchase.
- A **`LogbookOwner`** (`.me` / `.student(id, name, pro)`) threads through the
  API client (path prefix) and the dashboard, event, lap, session-compare,
  track, two-lap compare and vehicle screens. `.student` hides every write,
  the recorder and import doors, the leaderboard button, Wrapped, and the
  vehicle page's Pro sections (no `/garage` under the mount). It supplies the
  tier the channel gates read.
- Where it lives: Settings → Coaching → a student opens their dashboard as a
  pushed destination on the Events tab. It is not a third tab.
- Offline as on the web: cached under the prefix, not queueable, purged on a
  404.

## Privacy and legal

- **Privacy policy** (bump the effective date): the profile's categories
  (occupation, experience, safety gear, optional free text a driver may use
  for health information), that a driver can share their logbook and profile
  with coaches they invite, **that a coach may keep what they have already
  seen**, and that revoking stops further access.
- **Health data**: the *for your instructor* box invites it without asking for
  it. It is stored like any other text; say so in the policy.
- **Store disclosures — no build can enforce these**: App Store Connect's
  privacy details and Play's Data safety form gain the new data types (other
  user content — the profile's text) and the sharing with other users.
  Tick them before the native releases go out.

## Docs owed (in the same PRs)

- NS-32's tier table: *Invite a coach* (Pro; server `requireEntitlement`),
  *Being a coach* (free), *A coach's view of the channel panel* (the
  **student's** tier; server `stripProFields` under the student's
  `entitledUntil`).
- `docs/specs/native/README.md`: the index row and the split note (all three).
- `AGENTS.md`: `routes/coaching.ts`, the third `apiApp` mount and
  `requireCoachGrant`, `COACH_ROUTES`, `sanitizeProfile`, migration 0031, the new
  web routes, `coaching.js` / `profile.js`, `LogbookOwner` on both phones,
  the new goldens and fixture.
- `README.md`; `site/docs/index.html` (sharing gains *Share with a coach*);
  `site/docs/data-model.html`'s share-page privacy section; privacy policy;
  `site/index.html`'s features grid.

## Tickets

1. **Server**: migration, `coaching.ts`, the coach mount, `coachView`,
   `sanitizeProfile`, tests, and the goldens with their native decode models
   (`Coaching.swift` / `Coaching.kt`), since both golden suites fail on a
   capture no model maps. **3–4 days.**
2. **Web + shared logic**: Settings sections, profile form, the accept page,
   the student logbook, `coaching.js` / `profile.js`, the fixture, the docs.
   **6–8 days.** The owner-context refactor of `app.js`'s views is the risky
   part.
3. **iOS**: the ports, Settings, profile, accept + Universal Link + QR,
   `LogbookOwner` through the screens, UI test. **6–8 days.**
4. **Android**: likewise. **6–8 days.**

## Acceptance criteria

- [ ] A Pro student creates an invite on any client; a free account sees the control locked; the link opens the accept screen on all three (signed out included) and accepting shows the student under *Students*.
- [ ] A coach reads the student's events, sessions, laps and **full** channel panel while the student is Pro, and the free half once the student lapses, on all three.
- [ ] Every coach response lacks email, notes, checklist, costs, parts, setups, leaderboard and billing data. A test walks every `COACH_ROUTES` route against a fully populated logbook and fails on any key outside the allowlist.
- [ ] A non-GET, a path off the allowlist, a revoked grant, or no grant: 404, and the next request after a revoke is refused.
- [ ] The coach's client purges a student's cache on that 404; no write under the prefix is ever queued.
- [ ] The profile saves and validates on all three, holds no birth date or emergency contact, and it shows on the coach's view of the student and nowhere public.
- [ ] Deleting either account removes the grant.
- [ ] `npm test`, `npm run typecheck`, `npm run contracts:check`, `swift test`, `:core:check`, `:app:testDebugUnitTest` pass.

## Follow-ups, deliberately not here

- **Coach comments on laps** ("brake 10 m later into T4"): the first time two
  users write to one logbook. Needs a table, notifications and a moderation
  story. The grant table is where its permission will hang.
- **Sharing toggles**: notes, track course notes and setup sheets are the
  likely next asks. Each is one field added to the `coachView` allowlist behind
  a per-grant flag.
- **The coach's AI assistant** reading a student (`student_id` on the MCP
  tools, which read through `apiGet` and would need nothing else).
- **Helmet-rating advice** (Snell ratings age out of many clubs' rules after
  about ten years). The ratings vary by organisation, so v1 records the rating
  and passes no verdict.
