package app.trackevolution.core.offline

import app.trackevolution.core.JsMath
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.EventDetail
import kotlin.math.max
import kotlin.math.sqrt

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
 * | [recomputeDetail] | `recomputeDetail` in `offline.js` | `OfflineMirrors.recomputeDetail` | `withComputed` in `src/lib/stats.ts` (+ `eventHours` in `src/lib/wear.ts`) |
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
     *  - [Event.consistency] is the coefficient of variation, and **null below 3
     *    laps** — not zero. Two laps say nothing about consistency.
     *  - [Event.hours] is the manual override when set, else
     *    `max(days × 2h, logged lap time)`, rounded to 1dp. It is never null.
     */
    public fun recomputeDetail(detail: EventDetail): EventDetail {
        val laps = detail.sessions.flatMap { session -> session.laps.map { it.timeMs } }
        val lapBestMs = laps.minOrNull()
        val bestMs = listOfNotNull(detail.event.bestTimeMs, lapBestMs).minOrNull()

        // Doubles throughout: a lap time squared is ~1.4e10, which overflows Int
        // silently and would make consistency garbage rather than wrong-looking.
        val consistency = if (laps.size >= 3) {
            val n = laps.size.toDouble()
            val mean = laps.sumOf { it.toDouble() } / n
            val meanOfSquares = laps.sumOf { it.toDouble() * it.toDouble() } / n
            sqrt(max(0.0, meanOfSquares - mean * mean)) / mean
        } else {
            null
        }

        // `eventHours`: the override wins; otherwise the greater of the
        // 2h-per-day estimate and the time actually spent on track.
        val lapHours = laps.sumOf { it.toDouble() } / 3_600_000.0
        val override = detail.event.trackHours
        val hours = if (override != null && override > 0) {
            override
        } else {
            max(detail.event.days * HOURS_PER_DAY, lapHours)
        }

        return detail.copy(
            event = detail.event.copy(
                lapCount = laps.size,
                sessionCount = detail.sessions.size,
                lapBestMs = lapBestMs,
                bestMs = bestMs,
                consistency = consistency,
                hours = JsMath.round(hours, 10.0),
            ),
        )
    }

    /**
     * The list-shaped row for an event, which is its detail minus the nested
     * sessions and setups — what `/events` returns.
     */
    public fun listRow(detail: EventDetail): Event = detail.event

    /** `DEFAULT_HOURS_PER_DAY` in `src/lib/wear.ts`. */
    private const val HOURS_PER_DAY = 2.0
}
