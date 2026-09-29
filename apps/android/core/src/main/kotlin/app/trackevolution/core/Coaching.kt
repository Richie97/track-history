package app.trackevolution.core

import app.trackevolution.core.model.Student

/**
 * Share with a coach (NS-38): the words the Coaching page and a coach's
 * Students list say about a grant — the port of `public/js/coaching.js`, under
 * the same names, pinned case for case by `contracts/logic/coaching.json` (the
 * fixture the iOS Kit asserts against too).
 *
 * Dateless in the way ported logic here is: anything that says a calendar date
 * takes the client's own formatter, so the fixture pins the wording and not a
 * locale.
 *
 * Not to be confused with `model.Coaching`, the `GET /api/coaching` response —
 * the two share a name because the JS module and the route do.
 */
public object Coaching {

    private const val HOUR_MS: Long = 60L * 60 * 1000
    private const val DAY_MS: Long = 24 * HOUR_MS

    private fun plural(n: Long, one: String, many: String = "${one}s"): String =
        "$n ${if (n == 1L) one else many}"

    /**
     * A student row's one line: how much there is to read, and when they were
     * last out. [fmtDate] turns the ISO date into the client's own wording.
     */
    public fun studentLine(student: Student, fmtDate: (String) -> String): String {
        if (student.eventCount == 0) return "No track days yet"
        val count = plural(student.eventCount.toLong(), "event")
        val last = student.lastEventDate
        return if (last != null) "$count · last out ${fmtDate(last)}" else count
    }

    /**
     * When a coach last read the logbook, for the student's list of coaches.
     * The server touches it at most once an hour, so nothing finer is said.
     */
    public fun lastViewedText(lastViewedAt: Long?, now: Long): String {
        if (lastViewedAt == null) return "hasn't looked yet"
        val ago = maxOf(0L, now - lastViewedAt)
        return when {
            ago < HOUR_MS -> "viewed in the last hour"
            ago < DAY_MS -> "viewed ${plural(ago / HOUR_MS, "hour")} ago"
            ago < 14 * DAY_MS -> "viewed ${plural(ago / DAY_MS, "day")} ago"
            ago < 60 * DAY_MS -> "viewed ${plural(ago / (7 * DAY_MS), "week")} ago"
            else -> "not viewed for over two months"
        }
    }

    /**
     * An open invite's remaining life. Days round rather than floor, so a link
     * minted a second ago reads "7 days", not "6". `Math.round` on a positive
     * value, so JavaScript's tie rule and Kotlin's agree here.
     */
    public fun inviteExpiryText(expiresAt: Long, now: Long): String {
        val left = expiresAt - now
        return when {
            left <= 0 -> "expired"
            left < HOUR_MS -> "expires within the hour"
            left < DAY_MS -> "expires in ${plural(left / HOUR_MS, "hour")}"
            else -> "expires in ${plural(Math.round(left.toDouble() / DAY_MS), "day")}"
        }
    }
}
