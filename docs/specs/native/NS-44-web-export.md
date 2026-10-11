# NS-44 — Export your logbook (web)

**Phase:** post-rewrite · **Platform:** Server + web (no native change) · **Depends on:** `eventSelect` / `withComputed`, the garage tables, `requireSession` · **Estimate:** 4–5 days, one PR · **Issue:** [#383](https://github.com/Richie97/track-history/issues/383)

## Goal

A driver can download **everything they have put into the logbook**, from
Settings on the web:

- **`laps.csv`**: one row per lap, ready for a spreadsheet.
- **`events.csv`**: one row per event, with its computed figures and costs.
- **`track-evolution-<date>.json`**: the complete logbook (tracks, events,
  sessions, laps, setups, the garage, the profile and preferences),
  optionally with every session's telemetry.

```
Settings → Your data
┌───────────────────────────────────────────────────┐
│ Download a copy of your logbook                   │
│  [ Laps (CSV) ]  [ Events (CSV) ]                 │
│  [ Everything (JSON) ]   ☐ include telemetry      │
│     Telemetry makes the file much larger —        │
│     about 1 MB per imported or recorded session.  │
└───────────────────────────────────────────────────┘
```

## Why

There is no way to get data out today. That matters three ways:

- **Trust**: a logbook people keep for years has to be leavable.
- **Analysis**: drivers who live in spreadsheets want their lap times there.
- **Obligation**: EU and UK users (the consent banner exists because they
  do) have a right to a portable copy, and the account-deletion page should
  be able to say *"download a copy first"*.

## Fixed decisions

| | |
|---|---|
| Where | **The web, in Settings.** The phones are a follow-up. The routes take a bearer as well as the cookie (`requireSession` does both), so a native door later needs no server change. |
| Tier | **Free, and complete for every account.** A lapsed or free account's export includes its full `channels`, garage and setup sheets, though the app shows them only with Pro. The Pro line is the *analysis* (`stripProFields` hides on read and never deletes, #264). The data is the driver's, and an export that withheld part of it would fail the portability it exists for. |
| Three files, no ZIP | Two CSVs for the spreadsheet case, one JSON for the complete case. A ZIP would mean a hand-written streaming encoder (the Worker and the web app take no dependencies) to save two clicks. It's a follow-up if asked for. |
| Streamed | The JSON is **streamed**, written as it is read, so a logbook with hundreds of telemetry sessions never sits in the Worker's 128 MB at once. Sessions with channels are read in pages (`EXPORT_PAGE_SESSIONS = 10`), and each blob is written and released before the next page. |
| What's in the JSON | Everything the user entered or the app derived and stored for them. **Profile and preferences**: name, email, units, checklist template, leaderboard consents, share slug, and the driver profile. **Logbook**: tracks (goal, course notes, catalog link), events (every column, plus the computed `best_ms` / `consistency` / `hours` / `cost_cents`), sessions (label, notes, trace, conditions, odometer, and channels when asked), laps (`time_ms`, `device_timed`), setups. **Garage**: vehicles, parts, mounts with swap points, measurements. **Who has access**: coach grants as `{ name, since, last_viewed_at }`, connected AI assistants as `{ client_name, connected_at }`, and the subscription as `{ provider, status, expires_at }`. |
| What's never in it | Credentials and their hashes (`auth_sessions`, `auth_codes`, `oauth_*` tokens and codes, `coach_invites`), store identifiers (`external_id`, purchase tokens, JWS), provider subjects (`google_sub`, `apple_sub`), internal ids of *other* users, and the seeded catalogs beyond the link (`catalog_id` plus the catalog row's name). |
| Units and names | **Stored units and the API's own field names**, as the MCP tools do. A top-level `units` legend says what each unit-bearing field holds (lap times in ms, `temp_f` in °F, channel speeds in km/h, setup pressures in psi, …). Converting would make the export depend on a display preference and break a future import. |
| Versioned | `{ "format": "track-evolution-export", "version": 1, "exported_at": … }` leads the file, so a future importer can tell what it holds. |
| Not offline, not cached | `/api/export/*` is skipped by `sw.js` (it would otherwise network-first the whole download into `th-data-*`) and is never fetched through `api()`. The buttons are plain `download` links, disabled offline with *"Exporting needs a connection"*. |
| Coach mount | **Unreachable**: no `/export` path in `COACH_ROUTES`, asserted by a test. The MCP tools never call it. |
| Rate limit | `EXPORT` binding, **10 per hour per user**, through `withinLimit`. A 429 carries `Retry-After`, and the web shows it in words. |

## Server

### Routes (`routes/export.ts`, under `/api`, authed)

| Route | Response |
|---|---|
| `GET /export/laps.csv` | `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="track-evolution-laps-<yyyy-mm-dd>.csv"` |
| `GET /export/events.csv` | Same, `…-events-<date>.csv` |
| `GET /export/logbook.json?telemetry=1` | `application/json`, `…-<date>.json`, streamed. `telemetry` is optional; without it, sessions carry `channels: null` and a top-level `"telemetry_included": false`. |

All three: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
The date in the filename is the server's UTC date. The router joins
`API_ROUTERS` in `entitlement-gates.test.ts`, with no gate.

### `src/lib/export.ts` (pure, unit-tested)

**`csvCell(v)`**: RFC 4180. Quote when the cell has `,`, `"`, CR or LF, and
double inner quotes. **Formula-injection guard**: a *text* cell beginning
with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'`. Numbers are written
unquoted and unguarded, so a camber of −3.2 stays a number.

**`lapsCsv(rows)`**: header and one line per lap, in event date, session and
lap order. Columns:

| Column | |
|---|---|
| `event_id` | |
| `event_date` | `start_date` |
| `track` | |
| `organizer` | `club` |
| `run_group` | |
| `car` | |
| `session_id` | |
| `session` | label |
| `lap` | lap number |
| `lap_time_ms` | |
| `lap_time` | `m:ss.fff`, via a server copy of `fmtMs` pinned to `format.js` by a unit test |
| `session_best` | `1` / `0` |
| `clean` | `1` / `0`: within 107% of the session's best, NS-42's rule, so a spreadsheet can reproduce the consistency figure |
| `device_timed` | `1` / `0` |

**`eventsCsv(rows)`**: one line per event, newest first. Columns:

| Column | |
|---|---|
| `event_id` | |
| `start_date` | |
| `days` | |
| `track` | |
| `organizer` | |
| `run_group` | |
| `car` | |
| `conditions` | |
| `temp_f` | |
| `ambient_lo_c`, `ambient_hi_c` | |
| `sessions` | |
| `laps` | |
| `best_lap_ms` | |
| `best_lap` | |
| `consistency_pct` | rounded to 0.01 |
| `hours` | |
| `cost_entry`, `cost_fuel`, `cost_travel`, `cost_misc`, `cost_total` | dollars to 2 places, empty when null |
| `notes` | |

Upcoming events are included, with their computed columns empty.

**`exportHeader(user, now)`** and **`UNITS_LEGEND`**: the JSON's fixed
opening.

### The JSON stream

`routes/export.ts` returns `new Response(readable)` over a `TransformStream`
and writes in sections:
1. The header and `units`.
2. `profile` (the user row's allowed columns plus the parsed profile).
3. `tracks`.
4. `events`: each with its `sessions` and their `laps` and its `setups`,
   built from the same statements the event detail uses. Telemetry is read
   page by page.
5. `garage` (vehicles → parts → mounts, measurements).
6. `access` (coach grants, assistants, subscription).

Each section is one D1 batch where it can be. A failure mid-stream can't
change the status code any more, so the writer ends the document with
`"error": "<message>"` and closes it. The web reports a file that doesn't
parse as a failed export.

### Tests

- **`test/unit/export.test.ts`**: `csvCell` quoting and the injection guard
  (text vs number), `fmtMs` parity with `format.js`, column order, an
  upcoming event's empty cells, and the `clean` flag at the 107% boundary.
- **`test/api/export.test.ts`**, against a fully populated logbook (every
  table, a coach, an assistant, a subscription):
  - each file's headers and `Content-Disposition`;
  - the JSON parses, carries every section, and contains **no** forbidden
    key anywhere (a recursive walk for `token`, `token_hash`, `external_id`,
    `google_sub`, `apple_sub`, `jws`, …);
  - telemetry absent without the flag and present with it;
  - a free account's export has the full channels;
  - another user's data never appears;
  - the coach mount answers 404 for `/export/*`;
  - the 11th request in an hour is a 429.

## Web

- **Settings → *Your data***, after *AI assistants*: the three download
  links, the telemetry checkbox (it toggles the JSON link's query) and a
  one-line note on size.
- Each link is an `<a download>`, so the browser handles progress. Offline
  they are disabled with the sentence above.
- `sw.js`: `/api/export/` joins the bypass list beside `/coach/`.

## Docs owed (in the same PR)

- **Privacy policy**, *Retention and deletion* (bump the effective date):
  you can download a copy of your data from Settings at any time; what it
  contains; that it includes data from the paid tier whatever your tier.
- **`site/docs/account-deletion.html`**: *"Download a copy from Settings →
  Your data first."*
- **`site/docs/index.html`**: a short *Your data* section.
- **NS-32's tier table**: *Exporting your data* (Free, complete for every
  account).
- **`docs/specs/native/README.md`**: the index row and the split note (web
  only; native door a follow-up).
- **`AGENTS.md`**: `routes/export.ts`, `lib/export.ts`, the `EXPORT` binding,
  and the `sw.js` bypass. **`README.md`**: the binding.

## Acceptance criteria

- [ ] From Settings on the web, a signed-in user downloads all three files. The CSVs open cleanly in Excel, Numbers and Google Sheets (checked by hand once), and a notes cell starting with `=` stays text.
- [ ] The JSON holds every section listed above, and nothing from the *never* list (asserted by a recursive key walk).
- [ ] With telemetry, a logbook of 200 channel-carrying sessions exports without exceeding Worker memory (a test streams a synthetic logbook of that size and checks the parse).
- [ ] A free account's export is complete, channels included.
- [ ] `/api/export/*` never lands in the service worker's or the offline layer's cache.
- [ ] The coach mount and other users can't reach it; the 11th export in an hour is a 429.
- [ ] `npm test`, `npm run typecheck`, `npm run contracts:check` pass.

## Follow-ups, deliberately not here

- **Export from the phones.** A Settings row that downloads through the
  bearer-authed routes and hands the file to the share sheet.
- **Import / restore from an export.** The `version` field is there for
  this. It needs ID remapping and conflict rules, and earns its own spec.
- **A ZIP** of all three plus per-session telemetry files, if drivers ask
  for one download.
- **Per-session telemetry CSV** (the gridded channels as columns) for
  drivers taking data to other analysis tools.
