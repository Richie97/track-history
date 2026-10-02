package app.trackevolution.core

import java.time.LocalDate
import java.time.temporal.ChronoUnit

/**
 * The dates a review's *Save to a new event* (#344) hands the New Event form.
 *
 * Native-only — the web review has no such hand-off — so there is no JS
 * original or fixture; iOS carries the same rule. The sessions being handed
 * over already say when they happened, so the form starts on the earliest of
 * their local dates (the date each review card shows) and spans to the latest:
 * a single-day recording is a one-day event, not the form's default two. Only
 * this hand-off applies it; the form's own "Add laps" import leaves a date the
 * driver may already have typed alone.
 */
public object NewEventDates {

    /** A new event's start date (`yyyy-MM-dd`) and length in days. */
    public data class Span(val startDate: String, val days: Int)

    /**
     * The span covering [dates] — each a session's local `yyyy-MM-dd`, or null
     * when its source carried none. Null when no date parses, so the form
     * keeps today and its default length.
     */
    public fun span(dates: List<String?>): Span? {
        val parsed = dates.mapNotNull { d -> d?.let { runCatching { LocalDate.parse(it.trim()) }.getOrNull() } }
        val first = parsed.minOrNull() ?: return null
        val last = parsed.maxOrNull() ?: first
        return Span(startDate = first.toString(), days = ChronoUnit.DAYS.between(first, last).toInt() + 1)
    }
}
