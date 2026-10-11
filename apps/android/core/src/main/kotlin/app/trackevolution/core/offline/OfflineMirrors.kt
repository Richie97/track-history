package app.trackevolution.core.offline

import app.trackevolution.core.Costs
import app.trackevolution.core.JsMath
import app.trackevolution.core.LapStats
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.EventDetail

/**
 * Server behaviors reimplemented client-side, so an offline read looks like a
 * server read.
 *
 * **This file is a mirror, and mirrors rot.** Each function below duplicates
 * logic that already exists three times — once on the server, once in
 * `public/js/offline.js`, once in the iOS kit's `OfflineMirrors`. That makes four
 * copies of two behaviors, which is the highest-risk debt in the native
 * programme. They live together here, named after their JS counterparts, with the
 * server source called out, so that when one changes there is one obvious place
 * to change the others:
 *
 * | here | web mirror | iOS mirror | server truth |
 * |---|---|---|---|
 * | [cleanLaps] | `cleanLaps` in `offline.js` | `OfflineMirrors.cleanLaps` | `sanitizeLaps` in `src/lib/validate.ts` |
 * | [recomputeDetail] | `recomputeDetail` in `offline.js` | `OfflineMirrors.recomputeDetail` | `withComputed` in `src/lib/stats.ts` (+ `eventHours` in `src/lib/wear.ts`, `eventCostCents` in `src/lib/costs.ts`) |
 * | consistency, via `LapStats.eventConsistency` | `eventConsistency` in `lap-stats.js` | `LapStats.eventConsistency` | the `clean_*` aggregates in `src/db.ts` + `withComputed` |
 *
 * [cleanLaps] here is **not** `LapStats.cleanLaps`: this one validates lap
 * times on the way in, that one is the 107% filter consistency uses (NS-42).
 *
 * If you find a divergence from the server, fix the server-matching behavior and
 * say so — the web app probably has the same bug.
 */
public object OfflineMirrors {

    /**
     * Lap times as the server would store them: rounded to whole milliseconds,
     * non-finite and non-positive dropped.
     *
     * Mirror of `sanitizeLaps`. [JsMath] rather than [kotlin.math.round] because
     * the web mirror rounds the JavaScript way (half up, not half to even) and
     * the two must agree on the same input.
     *
     * **Known divergence, deliberately kept.** The server filters *then* rounds;
     * the web mirror rounds *then* filters, so a lap of `0.4` ms is stored as `0`
     * by the server and dropped here. Both clients match the web mirror rather
     * than the server, because a sub-millisecond lap time is not reachable from
     * any input path — a recorder fix interval is ~100 ms — and three clients
     * agreeing with each other is worth more than all four agreeing on a value
     * that cannot occur.
     */
    public fun cleanLaps(laps: List<Double>): List<Int> = laps.mapNotNull { value ->
        if (!value.isFinite()) return@mapNotNull null
        val rounded = JsMath.round(value, 1.0)
        if (!rounded.isFinite() || rounded <= 0.0) return@mapNotNull null
        if (rounded > Int.MAX_VALUE.toDouble()) return@mapNotNull null
        JsMath.roundToInt(rounded)
    }

    /**
     * Recompute an event's aggregates and derived stats from its sessions, the way
     * the server does when it answers.
     *
     * Mirror of `withComputed`. The rules that matter, and that a naive
     * implementation gets wrong:
     *
     *  - [Event.bestMs] is `MIN(manual best, best logged lap)`, and null when
     *    there is neither.
     *  - [Event.consistency] is the coefficient of variation of the **clean**
     *    laps — within 107% of their own session's best (NS-42) — and **null
     *    below 3 of them**, not zero. `lapCount` and `hours` still count every lap.
     *  - [Event.hours] is the manual override when set, else
     *    the logged lap time with 3+ laps, else `days × 1h15m`, rounded to 1dp. It is never null.
     *  - [Event.costCents] is the sum of the entered cost line items, and
     *    **null when none was entered** — not zero, so an uncosted day never
     *    reads as a free one (#147).
     */
    public fun recomputeDetail(detail: EventDetail): EventDetail {
        val laps = detail.sessions.flatMap { session -> session.laps.map { it.timeMs } }
        val lapBestMs = laps.minOrNull()
        val bestMs = listOfNotNull(detail.event.bestTimeMs, lapBestMs).minOrNull()

        val consistency = LapStats.eventConsistency(
            detail.sessions.map { session -> session.laps.map { it.timeMs } },
        )

        // `eventHours`: the override wins; otherwise 3+ logged laps are the
        // time actually spent on track, and anything sparser is the 1h15m-per-day
        // estimate.
        val lapHours = laps.sumOf { it.toDouble() } / 3_600_000.0
        val override = detail.event.trackHours
        val hours = if (override != null && override > 0) {
            override
        } else if (laps.size >= 3) {
            lapHours
        } else {
            detail.event.days * HOURS_PER_DAY
        }

        // `eventCostCents`: the entered line items summed, null when there are none.
        val costCents = Costs.eventCostCents(
            detail.event.costEntryCents,
            detail.event.costFuelCents,
            detail.event.costTravelCents,
            detail.event.costMiscCents,
        )

        return detail.copy(
            event = detail.event.copy(
                lapCount = laps.size,
                sessionCount = detail.sessions.size,
                lapBestMs = lapBestMs,
                bestMs = bestMs,
                consistency = consistency,
                hours = JsMath.round(hours, 10.0),
                costCents = costCents,
            ),
        )
    }

    /**
     * The list-shaped row for an event, which is its detail minus the nested
     * sessions and setups — what `/events` returns.
     */
    public fun listRow(detail: EventDetail): Event = detail.event

    /** `DEFAULT_HOURS_PER_DAY` in `src/lib/wear.ts`. */
    private const val HOURS_PER_DAY = 1.25
}
