# NS-42 — Consistency over clean laps

**Phase:** post-rewrite · **Platform:** Shared (server, web offline mirror, both native offline mirrors; no screen changes) · **Depends on:** `withComputed`, the three `recomputeDetail` mirrors, `cleanLaps` (`public/js/lap-stats.js`, ported as `LapStats`) · **Estimate:** 2–3 days, **one PR** (the goldens tie the four copies together) · **Issue:** [#377](https://github.com/Richie97/track-history/issues/377)

## Goal

An event's **consistency** (the coefficient of variation of its lap times)
is computed over its **clean laps**: laps within 107% of **their own
session's** best. Out-laps, cool-down laps, and laps lost behind slower
traffic stop reading as driver inconsistency.

## Why

Today it is computed over every logged lap (`src/db.ts`'s `lap_avg` /
`lap_avg_sq`, `src/lib/stats.ts`'s `withComputed`). One 2:40 out-lap in a
session of 2:02s moves the figure more than every other lap together, and a
lap spent stuck behind a slow car looks exactly like a lap the driver drove
badly. A driver asked for a per-lap *traffic* checkbox to get those laps out.
That's the right instinct with the wrong mechanism: every session has some
traffic, a yes/no flag is a judgement call made after the fact, and nobody
ticks twenty boxes per session.

The app already has the right filter. `cleanLaps` (the F1 107% rule) drops
out-laps, cool-downs and heavily held-up laps, and `paceSlope` and the MCP
insights already use it. Consistency is the one lap-time statistic that
doesn't. Light traffic within 7% stays in, which is honest: it's part of the
session.

## Fixed decisions

| | |
|---|---|
| The rule | A lap is **clean** when `time_ms <= sessionBest × 1.07`, where `sessionBest` is the minimum `time_ms` **in that lap's session**. The comparison is inclusive and computed in double precision on every client, matching `cleanLaps`'s `<=`. |
| Per session, not per event | Against the event's best, a wet morning session or a second car's session would be thrown out whole. Each session is its own baseline, which is also what `cleanLaps` assumes when it's given one session's laps. |
| Minimum | **3 clean laps**, else `consistency` is null. A coefficient over two laps is noise, and the threshold counts what the figure is computed over. |
| What doesn't change | `lap_count`, `lap_avg`, `best_ms`, `session_count`, and the hours rule (`eventHours` reads `lap_avg × lap_count` and `MIN_TIMED_LAPS` against **all** laps, deliberately: an out-lap is still time on track). Per-session best-3, pace slope and warm-up are unchanged. |
| Manual best | Unaffected. `best_time_ms` isn't a lap and never entered consistency. |
| Shape | The response field `consistency` keeps its name and type. No client screen changes; every place that shows it shows the new figure. |
| History | Computed, not stored, so every past event's figure changes on deploy, usually down (better). It goes in the release notes, and `data-model.html` says what the number means. |
| No per-lap exclusion | Not in this spec. If the 107% rule proves too coarse, the follow-up is a general *exclude from stats* toggle on a lap, not a *traffic* label. |

## Requirements

### Server

- `eventSelect` (`src/db.ts`) gains a derived table of session bests and
  three conditional aggregates beside the existing ones:

  ```sql
  LEFT JOIN (SELECT session_id, MIN(time_ms) AS sbest FROM laps GROUP BY session_id) sb
         ON sb.session_id = s.id
  …
  COUNT(CASE WHEN l.time_ms <= sb.sbest * 1.07 THEN 1 END)                       AS clean_count,
  AVG(CASE WHEN l.time_ms <= sb.sbest * 1.07 THEN l.time_ms * 1.0 END)            AS clean_avg,
  AVG(CASE WHEN l.time_ms <= sb.sbest * 1.07 THEN l.time_ms * 1.0 * l.time_ms END) AS clean_avg_sq
  ```

  `idx_laps_session` already serves the derived table. The factor is a named
  constant (`CLEAN_FACTOR = 1.07`, `src/lib/stats.ts`) written into the
  statement as a literal, since `eventSelect` is a SQL fragment that many
  statements bind differently. Every caller of `eventSelect` gets the change: the list, the detail, the
  share page, the track's setups rows, Wrapped and the coach mount.
- `withComputed` computes `consistency` from `clean_*` with the
  `MIN_CONSISTENCY_LAPS = 3` threshold, and strips the three new columns as
  it strips `lap_avg` / `lap_avg_sq` today.
- `src/lib/wear.ts`'s comment calling `MIN_TIMED_LAPS` "the same 3+ bar
  consistency uses" is reworded. The two thresholds are now about different
  laps.

### Shared logic and the three mirrors

- `public/js/lap-stats.js` gains **`eventConsistency(sessionLaps)`**: an
  array of per-session lap-time arrays in, the CV over the union of each
  session's `cleanLaps` out, or null under `MIN_CONSISTENCY_LAPS`. It's
  ported to `LapStats.eventConsistency` in the Kit and `:core` beside their
  existing `cleanLaps`. It also exports `CLEAN_FACTOR = 1.07` and
  `MIN_CONSISTENCY_LAPS = 3`, so the JS names match what `:core`'s `LapStats`
  already calls the factor, and `cleanLaps`'s default reads the constant.
- `public/js/offline.js` `recomputeDetail` calls it. **Naming trap:**
  `offline.js` already has a local `cleanLaps` that mirrors `sanitizeLaps`
  (validation, not the 107% filter), as do both `OfflineMirrors`. The import
  is `eventConsistency`, never `cleanLaps`, and the mirror tables in all three
  files gain a row saying so.
- Both native `OfflineMirrors.recomputeDetail`s call
  `LapStats.eventConsistency`. The hours computation beside them keeps
  reading all laps.
- **Fixture** `contracts/logic/consistency.json`, generated from
  `eventConsistency`:
  - a session with an out-lap and a cool-down beyond 107%;
  - a lap exactly at `best × 1.07` (inclusive; 100000 → 107000 is `<=` in
    double precision);
  - two sessions whose bests differ by more than 7% (both kept);
  - 3 laps of which 2 are clean (null);
  - a single-lap session beside a full one;
  - an empty event.

  Both ports assert against it.

### Goldens

`contracts/generate.mjs`: one session on the rich event gains an **out-lap
beyond 107%**, so the captured `consistency` differs between the two rules.
Without it no golden tells them apart (every captured lap today is within
7%). The native `OfflineMirrorsTest(s)`, which compare `recomputeDetail`
against the golden event details to 1e-12, then pin the new rule on both
platforms. `lap_count`, the hours and Wrapped's figures in the captures
move with the extra lap. That's expected, and the review should check those
are the only diffs besides `consistency`.

### Tests that change (all intended)

- `test/unit/stats.test.ts`: the `[100000, 110000, 120000]` case is now
  null (only one lap is within 107%). Its `withLaps` helper builds the
  `clean_*` columns. New cases cover the per-session rule and the threshold.
- `test/unit/offline.test.js`: the same fixture is now null.
- `test/api/events.test.ts`: a new case posts a session with an out-lap and
  asserts the out-lap is excluded.
- Android `OfflineMirrorsTest.kt` (the same 3-lap case). iOS `ModelTests`'s
  "`lapCount >= 3` ⇔ consistency non-nil" assertion becomes a clean-lap
  count over the golden's laps.

## Docs owed (in the same PR)

- `site/docs/data-model.html`: *"Consistency is the coefficient of variation
  (standard deviation ÷ mean) of an event's clean laps — those within 7% of
  their session's best, which leaves out out-laps, cool-downs and laps lost
  in heavy traffic — shown once there are three."*
- `README.md` (the consistency paragraph), `AGENTS.md` (the `stats.ts`
  bullet, the mirror pairs, the new fixture).
- MCP: the `consistency` descriptions in `src/ai/tools.ts` and
  `src/ai/output-schemas.ts`, and their copies in `chatgpt-app-submission.json`.
- Historical NS-03/04/05/21/22 mentions are left alone. They describe what
  was built then.

## Acceptance criteria

- [ ] An event with a 2:40 out-lap and seven 2:02s reports the consistency of the seven alone, on the server and in all three offline mirrors.
- [ ] Two sessions in different conditions are each judged against their own best.
- [ ] Fewer than 3 clean laps gives null on every client.
- [ ] `lap_count`, `best_ms` and `hours` are unchanged for every event in the goldens except the one that gained a lap.
- [ ] `contracts/logic/consistency.json` is pinned by both ports. `npm test`, `npm run typecheck`, `npm run contracts:check`, `swift test`, `:core:check`, `:app:testDebugUnitTest` pass.
