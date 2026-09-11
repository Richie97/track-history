package app.trackevolution.core

import app.trackevolution.core.model.ChannelMeta
import app.trackevolution.core.model.Session
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Session conditions (#191) — the port of the pure half of
 * `public/js/conditions.js`.
 *
 * Same function and constant names as the JS original so the two diff by eye,
 * that file's test cases come with it ([SessionConditionsTest]), and the output
 * is pinned against the web implementation by `contracts/logic/conditions.json`.
 * The name is the one deliberate difference, shared with the iOS port:
 * `Conditions` is already the dry/damp/wet enum on `Event`.
 *
 * Lap times across a day are confounded by air temperature. A morning session
 * and an afternoon session are not comparable, and a progress chart that plots
 * them as if they were invites the wrong conclusion: a line that ticks upward
 * after lunch reads as "I got worse" when what happened is that the track got
 * hotter.
 *
 * Three rules shape everything here and this port inherits all of them.
 *
 * **Recorded beats typed, and never overwrites it.** Every video telemetry
 * import stores `meta.ambientC`, which migration 0020 lifts into
 * `sessions.ambient_c` and the event query aggregates into `ambient_lo_c` /
 * `ambient_hi_c`. Events also carry a manual `temp_f` the driver typed.
 * [eventAmbient] prefers the recorded value and falls back to the typed one, and
 * nothing anywhere writes one from the other.
 *
 * **Per session, only what was measured.** A session's chip shows the ambient
 * that session's own recording saw, never the event's typed figure repeated down
 * the page. The manual fallback is an *event*-level idea because that is the
 * level it was entered at.
 *
 * **Context is a band, not a series.** Behind the progress chart the temperature
 * is a faint wash per event, deepening with heat. A second line would read as a
 * comparison — "lap time versus temperature" — which is not the claim; the claim
 * is only that these two events were not run in the same air. That is also why
 * [conditionsBand] returns null under [BAND_MIN_SPAN_C]: a uniform wash shows
 * nothing and implies something.
 *
 * Temperatures are °C and elevations metres throughout, with display conversion
 * a separate step ([tempText], [elevationText]), so the fixture pins numbers
 * rather than a locale.
 */
public object SessionConditions {

    /**
     * Which unit system the text comes out in. Its own enum rather than
     * [Health.Units] — the two analyses share a vocabulary, not a type.
     */
    public enum class Units { METRIC, US }

    // ---- constants ---------------------------------------------------------

    /** Fewer known events than this in view and there is nothing to compare. */
    public const val BAND_MIN_EVENTS: Int = 2

    /** A spread under this many °C is weather noise, not a hot afternoon. */
    public const val BAND_MIN_SPAN_C: Double = 3.0

    /**
     * The wash, coolest to hottest. Faint on purpose: it sits *behind* the lap
     * times and must never compete with the line for attention.
     */
    public const val BAND_MIN_ALPHA: Double = 0.05
    public const val BAND_MAX_ALPHA: Double = 0.3

    // ---- conversion --------------------------------------------------------

    public fun cToF(c: Double): Double = c * 1.8 + 32

    public fun fToC(f: Double): Double = (f - 32) / 1.8

    public fun mToFt(m: Double): Double = m / 0.3048

    /**
     * JavaScript's `Math.round`: ties go **up**, toward +infinity, so -12.5
     * rounds to -12. Kotlin's [kotlin.math.round] is half *away from zero* and
     * gives -13 — a one-degree disagreement with the web on every freezing
     * morning, which is why the fixture probes the negative halves. Landing in
     * `Int` also keeps a rounded -0.5 from printing as "-0".
     */
    internal fun roundHalfUp(v: Double): Int = floor(v + 0.5).toInt()

    /**
     * The opacity of one band cell. Linear in the normalized temperature, so the
     * coolest event in view is barely tinted and the hottest unmistakable.
     */
    public fun bandAlpha(intensity: Double): Double =
        BAND_MIN_ALPHA + (BAND_MAX_ALPHA - BAND_MIN_ALPHA) * min(1.0, max(0.0, intensity))

    // ---- inputs ------------------------------------------------------------

    /**
     * The minimum an event needs for these rules. An interface rather than the
     * concrete `Event` so tests can express a case in four fields, mirroring the
     * JS, which duck-types the same way.
     */
    public interface AmbientEvent {
        /** The coolest and hottest ambient this event's sessions recorded, °C. */
        public val ambientLoC: Double?
        public val ambientHiC: Double?

        /** The largest elevation range recorded at it, metres. */
        public val elevationM: Double?

        /** The temperature the driver typed, °F. */
        public val tempF: Int?
    }

    // ---- reading -----------------------------------------------------------

    /**
     * The ambient a session's own telemetry recorded, °C, or null.
     *
     * The column (migration 0020) is the denormalization of the blob, so it is
     * read first and the blob is the fallback — which matters for a response
     * cached before the column existed, and for a free account, whose `channels`
     * are stripped while the column is not.
     */
    public fun sessionAmbientC(ambientC: Double?, meta: ChannelMeta?): Double? =
        ambientC ?: meta?.ambientC

    public fun sessionAmbientC(session: Session?): Double? =
        sessionAmbientC(session?.ambientC, session?.channels?.meta)

    /**
     * The elevation *range* a session's recording saw, metres — max minus min
     * altitude, i.e. how much the track climbs and falls, not its height above
     * the sea.
     */
    public fun sessionElevationM(elevationM: Double?, meta: ChannelMeta?): Double? =
        elevationM ?: meta?.elevationM

    public fun sessionElevationM(session: Session?): Double? =
        sessionElevationM(session?.elevationM, session?.channels?.meta)

    /**
     * An event's ambient temperature, reconciled: the range its sessions
     * recorded if any did, else the number the driver typed, else nothing.
     * `loC == hiC` for a single session and for the manual case.
     */
    public fun eventAmbient(event: AmbientEvent?): Ambient? {
        if (event == null) return null
        val lo = event.ambientLoC
        val hi = event.ambientHiC
        if (lo != null && hi != null) {
            return Ambient(min(lo, hi), max(lo, hi), Source.RECORDED)
        }
        val f = event.tempF ?: return null
        val c = fToC(f.toDouble())
        return Ambient(c, c, Source.MANUAL)
    }

    /**
     * The midpoint of an event's ambient range — the single number the band
     * shades by, where the text keeps the range.
     */
    public fun ambientMidC(ambient: Ambient?): Double? =
        ambient?.let { (it.loC + it.hiC) / 2 }

    /**
     * The largest elevation range recorded at a track, metres, over its events.
     * A range, so the figure is a maximum rather than a sum: two events at one
     * track saw the same hill.
     */
    public fun trackElevationM(events: List<AmbientEvent>?): Double? =
        events.orEmpty().mapNotNull { it.elevationM }.maxOrNull()

    // ---- words -------------------------------------------------------------

    /** A temperature in the given system, whole degrees: "84 °F". */
    public fun tempText(c: Double, units: Units = Units.METRIC): String {
        val v = if (units == Units.US) cToF(c) else c
        return "${roundHalfUp(v)} ${if (units == Units.US) "°F" else "°C"}"
    }

    /**
     * An event's ambient as words: one figure, or the day's range when its
     * sessions disagree. Rounding collapses the range first, so 21.4–21.8 °C
     * reads as one number rather than "71–71 °F".
     */
    public fun ambientText(ambient: Ambient?, units: Units = Units.METRIC): String {
        if (ambient == null) return ""
        val unit = if (units == Units.US) "°F" else "°C"
        val lo = roundHalfUp(if (units == Units.US) cToF(ambient.loC) else ambient.loC)
        val hi = roundHalfUp(if (units == Units.US) cToF(ambient.hiC) else ambient.hiC)
        return if (lo == hi) "$lo $unit" else "$lo–$hi $unit"
    }

    /** The elevation line. Context, not coaching — one line, and no more. */
    public fun elevationText(m: Double?, units: Units = Units.METRIC): String {
        if (m == null) return ""
        val v = if (units == Units.US) mToFt(m) else m
        return "${roundHalfUp(v)} ${if (units == Units.US) "ft" else "m"} of elevation change"
    }

    /**
     * The chart's spoken description of the shading — the part a screen-reader
     * user cannot see, same reason the charts say which way the trend goes.
     */
    public fun bandLabel(band: Band?, units: Units = Units.METRIC): String {
        if (band == null) return ""
        return "shaded by ambient temperature, ${tempText(band.loC, units)} to ${tempText(band.hiC, units)}"
    }

    // ---- the band ----------------------------------------------------------

    /**
     * The band behind the progress chart, aligned one cell per plotted event, in
     * the order given. A cell is null where that event has no temperature at all
     * — an unknown day must draw nothing, not the coolest shade, which would
     * claim a measurement that was never made.
     *
     * Null overall when fewer than [BAND_MIN_EVENTS] carry a temperature or they
     * span less than [BAND_MIN_SPAN_C].
     */
    public fun conditionsBand(events: List<AmbientEvent>?): Band? {
        val mids = events.orEmpty().map { ambientMidC(eventAmbient(it)) }
        val known = mids.filterNotNull()
        if (known.size < BAND_MIN_EVENTS) return null
        val loC = known.min()
        val hiC = known.max()
        if (hiC - loC < BAND_MIN_SPAN_C) return null
        return Band(
            loC = loC,
            hiC = hiC,
            cells = mids.map { c ->
                if (c == null) {
                    null
                } else {
                    val intensity = (c - loC) / (hiC - loC)
                    BandCell(c = c, intensity = intensity, alpha = bandAlpha(intensity))
                }
            },
        )
    }

    // ---- types -------------------------------------------------------------

    /**
     * Where an event's temperature came from. The view can say so rather than
     * presenting a typed number as a measurement.
     */
    public enum class Source { RECORDED, MANUAL }

    public data class Ambient(val loC: Double, val hiC: Double, val source: Source)

    /** One event's cell of the wash. [c] is the midpoint it was shaded by. */
    public data class BandCell(val c: Double, val intensity: Double, val alpha: Double)

    /** [cells] is one per plotted event, null where nothing was known. */
    public data class Band(val loC: Double, val hiC: Double, val cells: List<BandCell?>)
}
