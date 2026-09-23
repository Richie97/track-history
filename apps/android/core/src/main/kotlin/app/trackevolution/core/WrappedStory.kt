package app.trackevolution.core

import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.model.Wrapped
import java.time.LocalDate

/**
 * Season Wrapped's presentation rules (NS-36) — the port of the pure half of
 * `public/js/wrapped.js` under the same names, pinned to it by
 * `contracts/logic/wrapped.json`, the fixture the iOS Kit asserts against too.
 *
 * The numbers are the server's (`GET /api/wrapped/:year`, `src/lib/wrapped.ts`)
 * and arrive already computed in a [Wrapped]; nothing here recomputes them.
 * What ports is only what the story decides: the dashboard hero's window, which
 * cards a season gets, and the poster's words.
 *
 * One signature differs from the JS, and has to: `wrappedCards` there tells the
 * public share from a free account by whether the payload *has* a `pro` key,
 * and the model reads an absent key and a `null` alike as `null`. The app only
 * ever shows its own account's season, where `null` means locked, so the share
 * case is the explicit `shared` flag the fixture's shared season passes.
 */
public object WrappedStory {
    public const val KM_PER_MILE: Double = 1.609344

    /**
     * The year the dashboard promotes, or null outside the reveal: the running
     * year from 1 November to 31 December, the one just ended through 31 January.
     * [today] is an ISO date (`yyyy-MM-dd`).
     */
    public fun wrappedSeason(today: String): Int? {
        val parts = today.split("-")
        val year = parts.getOrNull(0)?.toIntOrNull() ?: return null
        val month = parts.getOrNull(1)?.toIntOrNull() ?: return null
        return when {
            month >= 11 -> year
            month == 1 -> year - 1
            else -> null
        }
    }

    /** The same, for the viewer's local day. */
    public fun wrappedSeason(today: LocalDate): Int? = wrappedSeason(today.toString())

    /** The card kinds, spelled as the JS spells them. */
    public enum class Kind(public val id: String) {
        COVER("cover"), NUMBERS("numbers"), MOST_DRIVEN("most_driven"), IMPROVEMENT("improvement"),
        FASTEST("fastest"), NEW_TRACKS("new_tracks"), HOURS("hours"), HOTTEST("hottest"),
        TIRE("tire"), TOP_SPEED("top_speed"), POSTER("poster"),
    }

    /** One card. [locked] marks a Pro card on a free account, drawn with the upsell rather than skipped. */
    public data class Card(val kind: Kind, val locked: Boolean = false)

    /**
     * The ordered card list for one season. A card with no data is left out,
     * never drawn empty. The two Pro cards follow `data.pro`: null (a free
     * account) draws them locked, an object draws whichever has data, and a
     * [shared] season has no Pro cards at all.
     */
    public fun wrappedCards(data: Wrapped, shared: Boolean = false): List<Card> {
        val cards = mutableListOf(Card(Kind.COVER), Card(Kind.NUMBERS))
        if (data.mostDriven != null) cards += Card(Kind.MOST_DRIVEN)
        if (data.improvement != null) cards += Card(Kind.IMPROVEMENT)
        if (data.fastest != null) cards += Card(Kind.FASTEST)
        if (data.newTracks.isNotEmpty()) cards += Card(Kind.NEW_TRACKS)
        cards += Card(Kind.HOURS)
        if (data.hottest != null) cards += Card(Kind.HOTTEST)
        if (!shared) {
            val pro = data.pro
            if (pro == null) {
                cards += Card(Kind.TIRE, locked = true)
                cards += Card(Kind.TOP_SPEED, locked = true)
            } else {
                if (pro.tire != null) cards += Card(Kind.TIRE)
                if (pro.topSpeed != null) cards += Card(Kind.TOP_SPEED)
            }
        }
        cards += Card(Kind.POSTER)
        return cards
    }

    /** `CARD_TITLES` — what each card is called, for the progress dots and TalkBack. */
    public val CARD_TITLES: Map<Kind, String> = mapOf(
        Kind.COVER to "Cover",
        Kind.NUMBERS to "The numbers",
        Kind.MOST_DRIVEN to "Most driven",
        Kind.IMPROVEMENT to "Biggest improvement",
        Kind.FASTEST to "Fastest lap",
        Kind.NEW_TRACKS to "New tracks",
        Kind.HOURS to "Hours behind the wheel",
        Kind.HOTTEST to "Hottest day",
        Kind.TIRE to "Favourite tyre",
        Kind.TOP_SPEED to "Top speed",
        Kind.POSTER to "Your season",
    )

    // ---- the words ---------------------------------------------------------

    /** `Math.round(n).toLocaleString("en-US")`: ties toward +∞, thousands separated by commas. */
    internal fun int(n: Double): String = "%,d".format(java.util.Locale.US, JsMath.roundToInt(n))

    public fun plural(n: Double, one: String, many: String = "${one}s"): String = if (n == 1.0) one else many

    /** Track days are REAL — a half day is 0.5 — so they show one decimal only when they aren't whole. */
    public fun fmtDays(d: Double): String = if (d == Math.floor(d)) int(d) else Units.toFixed(d, 1)

    public data class Distance(val value: String, val unit: String)

    /** "4,281" and its unit, in the account's system. */
    public fun trackDistance(miles: Double, units: UnitSystem): Distance {
        val metric = Units.isMetric(units)
        return Distance(int(if (metric) miles * KM_PER_MILE else miles), if (metric) "track km" else "track miles")
    }

    /** Seconds found, as the card says it: "4.83 s". */
    public fun fmtGain(ms: Int): String = "${Units.toFixed(ms / 1000.0, 2)} s"

    /** The hours card's figure: one decimal only when it isn't whole. */
    public fun fmtHoursWord(h: Double): String {
        val v = JsMath.round(h, 10.0)
        return if (v == Math.floor(v)) int(v) else Units.toFixed(v, 1)
    }

    public data class Poster(val title: String, val headline: List<String>, val rows: List<Pair<String, String>>)

    /**
     * The poster's lines — the summary card and the share image draw the same
     * rows, so the two never disagree about what a season said. The owner's own
     * poster says "My"; a shared one names the driver.
     */
    public fun posterLines(data: Wrapped, units: UnitSystem, share: Boolean = false): Poster {
        val t = data.totals
        val dist = trackDistance(t.miles, units)
        val headline = buildList {
            add("${fmtDays(t.trackDays)} ${plural(t.trackDays, "track day")}")
            add("${int(t.tracks.toDouble())} ${plural(t.tracks.toDouble(), "track")}")
            add("${int(t.laps.toDouble())} ${plural(t.laps.toDouble(), "lap")}")
            if (t.milesTracksCounted != 0) add("${dist.value} ${dist.unit}")
        }
        val rows = buildList {
            data.mostDriven?.let { add("Most driven" to it.trackName) }
            data.improvement?.let { add("Biggest improvement" to "${it.trackName}, −${fmtGain(it.gainMs)}") }
            data.fastest?.let { add("Fastest lap" to "${it.trackName}, ${LapTime.fmtMs(it.bestMs)}") }
            data.pro?.tire?.let { add("Favourite tyre" to it.name) }
        }
        val who = if (share) "${data.name?.takeIf { it.isNotEmpty() } ?: "A driver"}'s" else "My"
        return Poster("$who ${data.year} Track Evolution", headline, rows)
    }
}
