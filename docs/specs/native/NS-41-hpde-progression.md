# NS-41 — HPDE progression

**Phase:** post-rewrite · **Platform:** Shared (server, web, iOS, Android) · **Depends on:** the event form on all three clients, NS-38 (the coach view, the driver profile), the share page, the MCP tools (#314) · **Estimate:** 1.5–2 weeks across three PRs: server + web + shared logic, then iOS, then Android · **Issue:** [#373](https://github.com/Richie97/track-history/issues/373)

## Goal

HPDE drivers measure their progress in run groups and sign-offs: novice to
intermediate to advanced, *"signed off to solo at NCM, May 2026"*, the move to
HPDE3. The logbook records lap times well and that progression barely at all.
This spec records it on the event it happened at, and shows it back as a
per-organizer timeline:

```
Progression
┌───────────────────────────────────────────────┐
│ NASA Mid-Atlantic                  HPDE3 now  │
│  HPDE2 ──── 4 events ──── Apr 2025–Jun 2025   │
│  HPDE3 ──── 7 events ──── Aug 2025–today      │
│   ◆ Signed off to solo · VIR · 12 Jul 2025    │
│                                               │
│ Chin Track Days                     Blue now  │
│  Green ── 2 events · Blue ── 3 events         │
└───────────────────────────────────────────────┘
```

## What exists

Most of it. `events.club` and `events.run_group` have been free-text columns
since `0001_init.sql`. Every client's form labels them *Club / organizer* and
*Run group*, and they flow through the share page, the coach view
(`COACH_EVENT_FIELDS`) and the MCP tools (`eventRow`). What's missing:

- **Who instructed you** on the day.
- **The sign-off or milestone** itself. Today it can only go in the event's
  notes, which nothing reads and no coach sees, or in the profile's free-text
  `instruction` box.
- **Consistent values.** Free text with no suggestions gives "NASA",
  "nasa ma" and "NASA Mid-Atlantic" for one organizer.
- **Any view over time.**
- **Length limits.** `club` and `run_group` are bound raw in `POST`/`PUT
  /events`, unbounded.

## Fixed decisions

| | |
|---|---|
| Where a milestone lives | **On the event, as a field: `events.milestone`.** Sign-offs happen at a track day, so the event is where they belong. As a column on the event they get the offline queue, the goldens, the coach view and the MCP tools for free. A milestone *table* (for things that happen away from an event: a school, a licence) is a follow-up. The profile's `instruction` box covers those today. |
| Instructor | **`events.instructor`**, free text, the instructor's name. It's a third party's name, so it is **never on the public share page**. Coaches and the MCP tools see it. |
| Organizers | **Free text, as now, with suggestions.** No organizer catalog: the guide (`site/docs/track-days.html`) is where organizers are listed, and regional chapters ("NASA Mid-Atlantic" vs "NASA NorCal") are a real distinction a catalog would flatten. Consistency comes from suggesting the driver's own past values first. |
| Grouping | Timelines group by **organizer, compared trimmed and case-insensitive**, shown with the most recent spelling. Run groups compare the same way within an organizer. Events with no organizer appear in no timeline, but their milestones still list under *Other*. |
| Past only | A timeline counts **past events** (`start_date <= today`, the totals' rule). An upcoming event's run group isn't a step you've reached. |
| Limits | `club`, `run_group`, `instructor`: 100 characters. `milestone`: 200. Enforced on write by `isValidEventText` in `src/lib/validate.ts`; a longer value is a 400 naming the field. Existing rows aren't touched. |
| Tier | **Free.** It's the logbook. |
| Share page | `milestone` is public (a brag sheet is where it belongs). `instructor` joins the strip list. |
| Coach view | Both fields join `COACH_EVENT_FIELDS`. A coach of a student sees the student's progression card. |
| Clients | **All three**, both the fields and the card. |

## Server (ticket 1)

### Migration `0032_event_progression.sql` (or the next free number when it lands)

```sql
ALTER TABLE events ADD COLUMN instructor TEXT;
ALTER TABLE events ADD COLUMN milestone TEXT;
```

Plain, route-set columns with no trigger, like `temp_f` and the cost items.

### Routes and views

- `POST` / `PUT /events`: both columns in the column lists, binds and the
  `PUT` allowlist. All four text fields are validated by `isValidEventText`,
  trimmed, with `""` stored as null.
- `eventSelect` (`src/db.ts`) and `EventRow` (`src/lib/stats.ts`) carry both.
- `share.ts`: `instructor` joins the destructure that strips private fields.
  `test/api/share.test.ts` asserts its absence.
- `coaching.ts`: both join `COACH_EVENT_FIELDS`, and `coaching.test.ts`'s key
  assertion follows.
- `ai/tools.ts` `eventRow` and `ai/output-schemas.ts` `eventProperties` (which
  is `additionalProperties: false`, so the schema must change with the row),
  plus the copies in `chatgpt-app-submission.json`. The `INSTRUCTIONS` text
  gains one line: run groups are the organizer's own names and aren't
  comparable across organizers.

### Goldens

The rich event sets both non-null (`instructor: "Sam Lee"`, `milestone:
"Signed off to solo"`). Non-null, because iOS's golden check drops nulls
before diffing. `share-public` shows `milestone` and lacks `instructor`. Both
native `Event` / `EventDraft` / `EventPatch` / `SharedEvent` models and both
`OfflinePatch` field lists gain the two fields **in ticket 1**, since
Android's strict decode fails on a capture no model maps.
`public/js/offline.js` adds both to `EVENT_FIELDS` and the `applyLocal`
create.

## Shared pure logic (ticket 1, web; ported in 2 and 3)

`public/js/progression.js`, ported as `Progression` to the Kit and `:core`
under the same names, and pinned by `contracts/logic/progression.json`:

- **`progression(events, today)`** returns
  `{ organizers: [{ club, current_group, first_date, last_date, events, steps, milestones }], other_milestones }`.
  - `steps` are the run-group runs in date order:
    `[{ run_group, from, to, events }]`. A **return to an earlier group is a
    new step**: a driver bumped back to HPDE2 in the wet is part of the story,
    and merging would hide it.
  - `current_group` is the latest past event's group.
  - `milestones` is `[{ date, text, event_id, track_name }]`.
  - Organizers are ordered by most recent event.
  - Events with no run group still count toward the organizer's `events`
    and dates, but make no step.
- **`fieldSuggestions(events, field, context)`** returns the distinct
  trimmed values of `club` / `run_group` / `instructor`, deduplicated
  case-insensitively keeping the latest spelling, most recent first.
  - For `run_group` and `instructor`, values used **with `context.club`**
    come first, then the rest.
  - Upcoming events count here: a run group typed into next month's event is a
    good suggestion for the one after.
- **`progressionLine(entry)`** returns the one line a compact surface shows:
  *"NASA Mid-Atlantic · HPDE3 since Aug 2025"*. It takes the client's date
  formatter, as `coaching.js` does.

The fixture's events are chosen for the ways a port goes wrong:
- one organizer spelled three ways;
- a run group that goes up, comes back down, and up again;
- a milestone on an event with no organizer;
- an event dated today (past) and one tomorrow (excluded from the timeline,
  included in suggestions);
- two events on the same date at different organizers;
- whitespace-only values (they count as empty).

## Clients

### The event form (all three)

After *Club / organizer* and *Run group*, two new fields: *Instructor*
(placeholder *"Who rode with you"*) and *Sign-off or milestone*
(placeholder *"Signed off to solo, moved up to HPDE3…"*). All three of
organizer, run group and instructor gain suggestions from
`fieldSuggestions` over the cached `/events`, through the existing
combobox on each client: `bindCombo` on the web, `SuggestingField` on iOS and
Android. So it works offline and costs no request. Each draft-holding
mechanism carries both new fields: iOS's `EventFormDraft`, Android's
`SavedState` with the `hydrated` rule, and the web's form.

### The event page (all three)

The header's organizer line becomes *"NASA Mid-Atlantic · HPDE3 · with Sam
Lee"* (parts omitted when empty). A milestone shows as a chip under it, in the
accent colour with a flag glyph, never colour alone. The share page shows the
chip, without the instructor.

### The progression card

- **Web:** a *Progression* panel on `#/profile` above the profile form,
  and on the coach's `#/student/:id` dashboard. One row per organizer, using
  `progressionLine`, expanding to its steps and milestones. Hidden entirely
  when no past event has an organizer or a milestone. It is an optional
  panel, not a page, so it gets no empty state of its own.
- **iOS / Android:** the same card at the top of the Coaching screen's
  profile card (`CoachingScreen`, reached from Settings) and on the student
  home (`StudentHomeScreen` / Android's student home), which already reads
  the student's `/events`.
- **Wrapped is untouched in v1** (see the follow-ups).

## Privacy and legal

- **Privacy policy**, under *What we collect* (bump the effective date):
  the instructor's name you choose to record. Under *Who can see your
  logbook*: the share page shows run groups and milestones, never the
  instructor; coaches see both.
- No store-disclosure change: the profile's text already declared "other
  user content".

## Docs owed (in the same PRs)

- NS-32's tier table: *Organizer, run group, instructor, milestones and
  progression* (Free).
- `docs/specs/native/README.md`: the index row and the split note (all three).
- `AGENTS.md`: migration 0032, `isValidEventText`, `progression.js` and its
  ports, the fixture, the share page's strip list.
- `README.md`. `site/docs/data-model.html` (the two fields, share-page
  privacy). `site/docs/index.html` (logging an event). `site/docs/track-days.html`'s
  *Moving up* section, which can now say the app keeps the record.

## Tickets

1. **Server + web + shared logic** ([#374](https://github.com/Richie97/track-history/issues/374)): migration, validation, routes, share
   strip, coach allowlist, MCP row and schema, goldens and both native models,
   `progression.js` + fixture, the web form, page and card, and docs.
   **4–5 days.**
2. **iOS** ([#375](https://github.com/Richie97/track-history/issues/375)): the `Progression` port, form fields with suggestions, the event
   page line and chip, and the card on Coaching and the student home.
   **3–4 days.**
3. **Android** ([#376](https://github.com/Richie97/track-history/issues/376)): likewise. **3–4 days.**

## Acceptance criteria

- [ ] Organizer, run group, instructor and milestone save on all three clients, offline included, and round-trip without loss.
- [ ] Each of the first three suggests the driver's own past values, most recent first, with run groups and instructors from the chosen organizer first.
- [ ] The progression card groups an organizer typed three ways into one row, shows a demotion as its own step, and lists milestones by date, on all three clients from the same pinned function.
- [ ] The public share page shows milestones and never an instructor (asserted by `share.test.ts`); a coach sees both.
- [ ] A 101-character organizer is a 400 naming the field; existing longer values still read.
- [ ] `npm test`, `npm run typecheck`, `npm run contracts:check`, `swift test`, `:core:check`, `:app:testDebugUnitTest` pass.

## Follow-ups, deliberately not here

- **A milestones table** for what happens off a track day: schools,
  competition licences, a coach's sign-off recorded later.
- **A Wrapped card** (*"Moved up to HPDE3 this year"*). It needs a new key in
  `GET /wrapped/:year`, both native `Wrapped` models and two goldens, so it
  waits until drivers have a season of data in the fields.
- **Coach sign-offs**: a coach recording the milestone on a student's event.
  It's a write into another user's logbook, which NS-38 left as a follow-up
  for comments, and it should arrive with that.
