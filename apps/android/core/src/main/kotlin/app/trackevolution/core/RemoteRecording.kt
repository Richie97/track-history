package app.trackevolution.core

import java.time.LocalDate

/**
 * Which event a recording started away from the phone attaches itself to.
 *
 * A port of `public/js/record/remote.js`, keeping its names, and it brings
 * `test/unit/record-remote.test.js`'s cases with it. The same rule runs on
 * iOS (`RemoteRecording.swift`), and all three are pinned to
 * `contracts/logic/remote-attach.json` — because the phone, the head unit and
 * the web app disagreeing about which event a session landed in is a bug
 * nobody would notice until the logbook was already wrong.
 *
 * The rule is **deliberately conservative**: it attaches to an event whose day
 * range covers today, and it never guesses beyond that. The reason is
 * asymmetric cost. A recording that lands in last month's event is worse than
 * one that waits, unattached, for its event to be created at review time — an
 * unattached recording is offered on the dashboard and adopted by the first
 * event whose record screen it is opened from, so nothing is lost. A
 * misattached one silently corrupts a logbook entry. If a "closest event" or
 * "most likely event" heuristic starts to look appealing, that trade is the
 * answer.
 */
public object RemoteRecording {

    /**
     * The minimum an event needs for the rule to apply.
     *
     * An interface rather than the concrete `Event` so a test can express a
     * case in two fields, mirroring the JS, which duck-types the same way.
     * `Event` implements it, so the logbook's own rows can be passed straight in.
     */
    public interface EventCandidate {
        /** ISO `yyyy-mm-dd`. */
        public val startDate: String

        public val days: Double
    }

    /**
     * Today as the **phone's local calendar date** — track time is phone time.
     *
     * Delegates to [EventDates.todayIso], which is already local. The iOS port
     * needs its own implementation because *its* `EventDates.todayISO` is UTC,
     * mirroring JS's `toISOString()`; Kotlin's is `LocalDate.now()`, so the two
     * would be the same function. Kept under the JS name anyway, so the three
     * implementations line up when read side by side.
     */
    public fun localTodayIso(today: LocalDate = LocalDate.now()): String =
        EventDates.todayIso(today)

    /**
     * The event a remote "start recording" attaches to, or null to record
     * unattached.
     *
     * Ties — overlapping events — go to the one that started most recently,
     * which is almost always the specific day inside a longer entry.
     */
    public fun <E : EventCandidate> pickRecordingEvent(events: List<E>?, todayIso: String): E? =
        events.orEmpty()
            .filter { candidate ->
                if (candidate.startDate.isEmpty()) return@filter false
                val lastDay = addDays(candidate.startDate, spanDays(candidate.days) - 1)
                    ?: return@filter false
                // ISO dates compare correctly as strings, which is what the JS
                // relies on.
                candidate.startDate <= todayIso && todayIso <= lastDay
            }
            // Descending by start date. `sortedByDescending` is stable, so equal
            // starts keep their input order — matching the JS comparator, which
            // returns 0 for a tie.
            .sortedByDescending { it.startDate }
            .firstOrNull()

    /**
     * How many whole calendar days an event covers.
     *
     * **Fractional days truncate**, so a 1.5-day event covers only its start
     * date. That is not a decision made here: `addDays` in the JS passes
     * `days - 1` to `Date.UTC`, which floors it. The clients have to agree on
     * which event a car-started recording lands in, so this mirrors the
     * reference rather than quietly improving on it.
     */
    private fun spanDays(days: Double): Int =
        maxOf(1.0, if (days.isFinite()) days else 1.0).toInt()

    /**
     * Date-only arithmetic, so a DST transition cannot skip or repeat a
     * calendar day — an hour lost in March must not shorten a race weekend.
     *
     * The JS does this in UTC to *simulate* a date without a time zone;
     * [LocalDate] has no time zone to begin with, which is the same guarantee
     * arrived at more directly. Null rather than throwing: a malformed date
     * must drop one event out of the list, not take out the pick.
     */
    private fun addDays(iso: String, n: Int): String? =
        runCatching { LocalDate.parse(iso).plusDays(n.toLong()).toString() }.getOrNull()
}
