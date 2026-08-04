package app.trackevolution.core

import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.temporal.ChronoUnit

/**
 * Event dates, countdowns, and the prep-checklist default — the Kotlin side of
 * what iOS calls `EventDates`.
 *
 * `LapTime` deliberately skipped the date half of `public/js/format.js` on the
 * grounds that it had no meaning outside a browser. The logbook screens (NS-26)
 * are where it acquires one.
 *
 * **Dates here are calendar dates, never instants.** An event's `start_date` is
 * a date the driver wrote down, not a moment: it is `2026-05-01` at the track
 * regardless of the phone's time zone, and turning it into a timestamp is how
 * "Today" becomes "Tomorrow" for anyone east of UTC. Everything below is
 * [LocalDate] arithmetic for that reason, which also makes it DST-proof for
 * free — a day either side of a transition is still one day.
 */
public object EventDates {

    /** The phone's local calendar date, as the API spells dates. */
    public fun todayIso(today: LocalDate = LocalDate.now()): String = today.toString()

    /**
     * Is this event still ahead? Strictly after today, matching the web's
     * `start_date > todayISO()` — an event that starts today is happening, not
     * upcoming, and the dashboard says so with "Today".
     */
    public fun isUpcoming(startDate: String, today: LocalDate = LocalDate.now()): Boolean =
        parse(startDate)?.isAfter(today) ?: false

    /** Whole days from today to [startDate]; negative once it is past. */
    public fun daysUntil(startDate: String, today: LocalDate = LocalDate.now()): Int? {
        val date = parse(startDate) ?: return null
        return ChronoUnit.DAYS.between(today, date).toInt()
    }

    /** "Today" · "Tomorrow" · "In 5 days", matching the web's wording. */
    public fun fmtCountdown(startDate: String, today: LocalDate = LocalDate.now()): String {
        val days = daysUntil(startDate, today) ?: return EM_DASH
        return when {
            days <= 0 -> "Today"
            days == 1 -> "Tomorrow"
            else -> "In $days days"
        }
    }

    /**
     * "May 1, 2026" — localized, so it follows the phone's region rather than
     * the developer's.
     */
    public fun fmtDate(startDate: String?): String {
        val date = startDate?.let { parse(it) } ?: return EM_DASH
        return date.format(MEDIUM)
    }

    /**
     * The date as a chart x coordinate: days since the epoch.
     *
     * **Days, not an instant.** The web chart plots `new Date(start_date).getTime()`
     * and iOS plots a `timeIntervalSince1970`; both are the same axis scaled
     * differently, and `ChartScale` only ever normalises a range, so the unit is
     * free. Days is the one that cannot drift: a calendar date turned into a
     * timestamp acquires a time zone, and an event would move a day either side of
     * midnight depending on where the phone is. What matters — that a two-year gap
     * between events *looks* like a gap rather than the next point along — is
     * preserved exactly.
     */
    public fun epochDay(startDate: String?): Double? =
        startDate?.let { parse(it) }?.toEpochDay()?.toDouble()

    /** "2 days" / "1 day" / "1.5 days", the way the event tiles read. */
    public fun fmtDays(days: Double): String {
        val whole = days.toInt()
        val text = if (days == whole.toDouble()) whole.toString() else days.toString()
        return "$text ${if (days == 1.0) "day" else "days"}"
    }

    /**
     * The prep list a new event's checklist starts from.
     *
     * Pinned to `public/js/checklist.js` by `contracts/logic/checklist.json`,
     * the same fixture iOS asserts against — two hand-maintained copies of one
     * product decision drift the first time either is edited.
     *
     * Only the fallback: a user who edits the list in Settings gets their own,
     * stored server-side and served by `GET /api/me`.
     */
    public val DEFAULT_CHECKLIST: List<String> = listOf(
        // First because it is the only item with a deadline days before the
        // event rather than the morning of it.
        "Purchase Track insurance",
        "Tech inspection",
        "Torque lug nuts",
        "Check brake pads & fluid",
        "Set tire pressures",
        "Top off fuel",
        "Pack helmet & gloves",
        "Empty the car — remove loose items",
        "Charge camera / lap timer",
    )

    private val MEDIUM: DateTimeFormatter = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)

    private const val EM_DASH = "—"

    /** Null rather than throwing: a malformed date must not take out a list. */
    private fun parse(iso: String): LocalDate? = runCatching { LocalDate.parse(iso) }.getOrNull()
}
