package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.pow
import kotlin.math.round
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Session health (#190) — the port of the pure half of `public/js/health.js`.
 *
 * Same function and constant names as the JS original so the two diff by eye,
 * that file's test cases come with it ([HealthTest]), and the output is pinned
 * against the web implementation by `contracts/logic/health.json`. Only the
 * maths crosses over: the cards, sparklines and per-lap table are each
 * platform's own, and `HealthStrip` draws the phone's.
 *
 * Every PDR import stores fourteen numbers per lap that are not lap-time data —
 * peak oil / coolant / transmission temperature, minimum oil pressure, fuel and
 * the four tyre pressures as the lap ended, peak tyre temperature on each
 * corner, minimum battery voltage — plus a `boost` trace whose per-lap peak is
 * a heat-soak signal rather than a driving one. They answer "is the car okay,
 * and is it set up right", which is the other half of a track day, and they fill
 * the panel's Car tab.
 *
 * Three rules shape everything here and this port inherits all of them.
 *
 * **The reduction is the importer's, never re-derived.** A stored `oilC` is the
 * lap's peak, `oilKpa` its minimum, a tyre pressure the value as the lap
 * finished; [HEALTH_DEFS] restates each rule only so the view can *say* it
 * ("peak", "min", "at lap end"). Boost is the one figure not stored as a scalar
 * — it is a gridded trace — so its per-lap peak is derived here, and that is the
 * only derivation.
 *
 * **Thresholds shade, they don't alarm.** Each figure with a line has a `watch`
 * level and an `over` level in the stored unit, and the two statuses are the
 * garage's own wear vocabulary — `low` (approaching) and `due` (past the line) —
 * so the strip reuses the part cards' colours rather than inventing a second
 * scale. Both bounds are inclusive, and a `low` column's hazard is *below* its
 * lines rather than above them: get that backwards and the shading marks the
 * wrong half of the session.
 *
 * **Values stay in the stored units** (°C, kPa, V, %) throughout, with display
 * conversion a separate step ([displayValue]), so the fixture pins numbers
 * rather than a locale. The web shows °F and psi; the phones do too, through
 * [Units.US].
 *
 * The **tyre-pressure loop** — the setup sheet's cold pressures and a
 * per-vehicle target turning the import's hot pressures into the cold pressure
 * to start from next time — is web-only, because the setup notebook is. What
 * ports is the arithmetic under it ([hotPressures], [suggestCold]) and nothing
 * that needs a sheet: `pressureLoop` has no counterpart here.
 */
public object Health {

    /** How the importer reduced a channel to one number per lap. */
    @Serializable
    public enum class Reduce {
        /** The lap's peak. */
        @SerialName("max")
        MAX,

        /** The lap's minimum. */
        @SerialName("min")
        MIN,

        /** The value as the lap finished. */
        @SerialName("end")
        END,
    }

    /**
     * One column of the strip. [low] means the hazard is *below* the lines;
     * [derived] means the figure is reduced here from a gridded trace rather
     * than read from a stored scalar. Thresholds are in the stored unit.
     */
    @Serializable
    public data class Def(
        val key: String,
        val label: String,
        val group: String,
        val unit: String,
        val reduce: Reduce,
        val low: Boolean = false,
        val watch: Double? = null,
        val over: Double? = null,
        val derived: Boolean = false,
    )

    /** The strip's groups, in display order. */
    public val HEALTH_GROUPS: List<Pair<String, String>> = listOf(
        "temps" to "Temperatures",
        "pressures" to "Pressures",
        "electrical" to "Fuel & electrical",
    )

    /** The strip's columns, grouped, in display order. */
    public val HEALTH_DEFS: List<Def> = listOf(
        Def("oilC", "Oil temp", "temps", "°C", Reduce.MAX, watch = 120.0, over = 130.0),
        Def("coolantC", "Coolant", "temps", "°C", Reduce.MAX, watch = 110.0, over = 120.0),
        Def("transC", "Transmission", "temps", "°C", Reduce.MAX, watch = 110.0, over = 125.0),
        Def("tyreCLF", "Tyre LF", "temps", "°C", Reduce.MAX),
        Def("tyreCRF", "Tyre RF", "temps", "°C", Reduce.MAX),
        Def("tyreCLR", "Tyre LR", "temps", "°C", Reduce.MAX),
        Def("tyreCRR", "Tyre RR", "temps", "°C", Reduce.MAX),
        Def("oilKpa", "Oil pressure", "pressures", "kPa", Reduce.MIN, low = true, watch = 200.0, over = 120.0),
        Def("boost", "Boost", "pressures", "kPa", Reduce.MAX, derived = true),
        Def("tyreKpaLF", "Tyre LF", "pressures", "kPa", Reduce.END),
        Def("tyreKpaRF", "Tyre RF", "pressures", "kPa", Reduce.END),
        Def("tyreKpaLR", "Tyre LR", "pressures", "kPa", Reduce.END),
        Def("tyreKpaRR", "Tyre RR", "pressures", "kPa", Reduce.END),
        Def("fuelPct", "Fuel", "electrical", "%", Reduce.END, low = true, watch = 20.0, over = 10.0),
        Def("battV", "Battery", "electrical", "V", Reduce.MIN, low = true, watch = 13.0, over = 12.5),
    )

    /**
     * The four corners in the order the strip and the setup sheet both use, with
     * the sheet's key for each.
     */
    public val TYRE_CORNERS: List<Pair<String, String>> = listOf(
        "LF" to "fl", "RF" to "fr", "LR" to "rl", "RR" to "rr",
    )

    public const val KPA_PER_PSI: Double = 6.894757
    public fun kpaToPsi(kpa: Double): Double = kpa / KPA_PER_PSI
    public fun psiToKpa(psi: Double): Double = psi * KPA_PER_PSI
    public fun cToF(c: Double): Double = c * 1.8 + 32

    /** Fewer than this many fuel drops and a burn rate is one lap's noise. */
    public const val MIN_FUEL_DROPS: Int = 2

    /** Cold-pressure suggestions land on the setup sheet's own step. */
    public const val PSI_STEP: Double = 0.5

    /**
     * A cross-corner spread worth shading, in stored units: 10 °C across an axle
     * or between axles is a camber or balance question; 2 psi is a corner that
     * has done more work than its neighbour.
     */
    public const val SPREAD_WATCH_C: Double = 10.0
    public val SPREAD_WATCH_KPA: Double = 2 * KPA_PER_PSI

    public fun defFor(key: String): Def? = HEALTH_DEFS.firstOrNull { it.key == key }

    /**
     * A lap's figure for one column: the stored scalar, or for the derived
     * `boost` column the peak of the stored trace. Null when the lap has
     * neither.
     */
    public fun lapValue(entry: LapChannels?, key: String): Double? {
        if (entry == null) return null
        if (defFor(key)?.derived == true) {
            val arr = entry.channel(key) ?: return null
            var m = Double.NEGATIVE_INFINITY
            for (v in arr) if (v.isFinite() && v > m) m = v
            return if (m == Double.NEGATIVE_INFINITY) null else m
        }
        val v = entry.scalar(key) ?: return null
        return if (v.isFinite()) v else null
    }

    /**
     * True when the lap carries at least one health figure. A session of
     * hand-entered laps carries none, and the strip is then absent, not empty.
     */
    public fun hasHealthData(entry: LapChannels?): Boolean =
        HEALTH_DEFS.any { lapValue(entry, it.key) != null }

    /** One readable lap of a session, keeping its channel index. */
    public data class HealthLap(val chIdx: Int, val entry: LapChannels)

    /** The laps of a session with anything to show. */
    public fun healthLaps(channels: SessionChannels?): List<HealthLap> =
        (channels?.laps ?: emptyList()).mapIndexedNotNull { chIdx, entry ->
            if (hasHealthData(entry)) HealthLap(chIdx, entry) else null
        }

    /** One lap's value of one column. */
    @Serializable
    public data class SeriesPoint(val chIdx: Int, val v: Double)

    /** One column across the session, for the laps that carry it, in lap order. */
    public fun scalarSeries(channels: SessionChannels?, key: String): List<SeriesPoint> =
        (channels?.laps ?: emptyList()).mapIndexedNotNull { chIdx, entry ->
            lapValue(entry, key)?.let { SeriesPoint(chIdx, it) }
        }

    /**
     * Shading for one value. Both bounds are inclusive; a `low` column reads
     * downward.
     */
    @Serializable
    public enum class Status {
        @SerialName("ok")
        OK,

        /** Approaching the line. */
        @SerialName("low")
        LOW,

        /** Past it. */
        @SerialName("due")
        DUE,
    }

    /** Null when the column has no line. */
    public fun healthStatus(def: Def?, v: Double?): Status? {
        if (def?.watch == null || def.over == null || v == null) return null
        return if (def.low) {
            if (v <= def.over) Status.DUE else if (v <= def.watch) Status.LOW else Status.OK
        } else {
            if (v >= def.over) Status.DUE else if (v >= def.watch) Status.LOW else Status.OK
        }
    }

    /**
     * The session's figure for a column, by its own rule: the worst case across
     * laps — the maximum for a peak or an end-of-lap reading, the minimum for a
     * minimum.
     */
    public fun sessionExtreme(reduce: Reduce, series: List<SeriesPoint>): SeriesPoint? {
        var best = series.firstOrNull() ?: return null
        for (s in series) {
            if (if (reduce == Reduce.MIN) s.v < best.v else s.v > best.v) best = s
        }
        return best
    }

    /** One column of the reduced strip. */
    public data class Column(
        val key: String,
        val series: List<SeriesPoint>,
        val extreme: SeriesPoint,
        val status: Status?,
    )

    /** One lap's row of the strip's table. */
    public data class Row(val chIdx: Int, val values: Map<String, Double>)

    /** The whole strip, reduced. */
    public data class SessionHealth(val laps: List<Row>, val columns: List<Column>)

    /** Null when no lap carries anything. */
    public fun sessionHealth(channels: SessionChannels?): SessionHealth? {
        val laps = healthLaps(channels)
        if (laps.isEmpty()) return null
        val columns = ArrayList<Column>()
        for (def in HEALTH_DEFS) {
            val series = scalarSeries(channels, def.key)
            val extreme = sessionExtreme(def.reduce, series) ?: continue
            columns.add(Column(def.key, series, extreme, healthStatus(def, extreme.v)))
        }
        val rows = laps.map { lap ->
            val values = LinkedHashMap<String, Double>()
            for (c in columns) lapValue(lap.entry, c.key)?.let { values[c.key] = it }
            Row(lap.chIdx, values)
        }
        return SessionHealth(rows, columns)
    }

    /** Left minus right on each axle, and front minus rear as the axle means. */
    @Serializable
    public data class Spread(val front: Double, val rear: Double, val axle: Double)

    /**
     * Cross-corner spread for one lap and one kind of reading (`"tyreC"` or
     * `"tyreKpa"`). Null unless all four corners are present — three corners and
     * a guess is not a spread.
     */
    public fun tyreSpread(entry: LapChannels?, kind: String = "tyreC"): Spread? {
        val c = HashMap<String, Double>()
        for ((corner, _) in TYRE_CORNERS) {
            val v = lapValue(entry, "$kind$corner") ?: return null
            c[corner] = v
        }
        return Spread(
            front = c["LF"]!! - c["RF"]!!,
            rear = c["LR"]!! - c["RR"]!!,
            axle = (c["LF"]!! + c["RF"]!!) / 2 - (c["LR"]!! + c["RR"]!!) / 2,
        )
    }

    /** One lap's spread, with its channel index. */
    @Serializable
    public data class LapSpread(
        val chIdx: Int,
        val front: Double,
        val rear: Double,
        val axle: Double,
    )

    /** The spread per lap across the session. */
    public fun sessionSpread(channels: SessionChannels?, kind: String = "tyreC"): List<LapSpread> =
        (channels?.laps ?: emptyList()).mapIndexedNotNull { chIdx, entry ->
            tyreSpread(entry, kind)?.let { LapSpread(chIdx, it.front, it.rear, it.axle) }
        }

    /** The burn rate and what is left at it. */
    @Serializable
    public data class FuelBurn(
        val perLapPct: Double,
        val lastPct: Double,
        val lapsRemaining: Int,
        val drops: Int,
    )

    /**
     * Fuel burn from the per-lap fuel level: the median of the drops between
     * consecutive fuel-carrying laps (an increase is a refuel or sensor slosh and
     * is skipped), and the laps left at that rate. Null below [MIN_FUEL_DROPS]
     * drops — one drop is one lap's noise.
     */
    public fun fuelBurn(channels: SessionChannels?): FuelBurn? {
        val s = scalarSeries(channels, "fuelPct")
        val drops = ArrayList<Double>()
        for (i in 1 until s.size) {
            val d = s[i - 1].v - s[i].v
            if (d > 0) drops.add(d)
        }
        if (drops.size < MIN_FUEL_DROPS) return null
        drops.sort()
        val mid = drops.size / 2
        val perLapPct = if (drops.size % 2 == 1) drops[mid] else (drops[mid - 1] + drops[mid]) / 2
        val lastPct = s[s.size - 1].v
        return FuelBurn(
            perLapPct = perLapPct,
            lastPct = lastPct,
            lapsRemaining = floor(lastPct / perLapPct).toInt(),
            drops = drops.size,
        )
    }

    /** One corner's hot pressure, in kPa as stored. */
    @Serializable
    public data class HotPressure(val peakKpa: Double, val peakChIdx: Int, val lastKpa: Double)

    /**
     * Hot tyre pressures for the session, per corner: the highest end-of-lap
     * reading (the pressure the tyre reached) with the lap it came from, and the
     * last lap's reading. Null when no lap stored any corner.
     */
    public fun hotPressures(channels: SessionChannels?): Map<String, HotPressure>? {
        val out = LinkedHashMap<String, HotPressure>()
        for ((corner, _) in TYRE_CORNERS) {
            val s = scalarSeries(channels, "tyreKpa$corner")
            val peak = sessionExtreme(Reduce.MAX, s) ?: continue
            out[corner] = HotPressure(peak.v, peak.chIdx, s.last().v)
        }
        return if (out.isEmpty()) null else out
    }

    /** Round to the setup sheet's own step. */
    public fun roundPsi(psi: Double): Double = jsRound(psi / PSI_STEP) * PSI_STEP

    /**
     * JavaScript's `Math.round`: halves go *up*, not away from zero, so −0.25
     * rounds to −0 rather than −1 — which is where Kotlin's [round] differs.
     */
    private fun jsRound(v: Double): Double = floor(v + 0.5)

    /** What [suggestCold] works out. */
    @Serializable
    public data class ColdSuggestion(
        val coldPsi: Double,
        val hotPsi: Double,
        val targetPsi: Double,
        val suggestedPsi: Double,
        val deltaPsi: Double,
    )

    /**
     * The one arithmetic the web's pressure loop rests on: a tyre that grew from
     * `cold` to `hot` gains the same amount next time, so to land on `target`
     * hot, start from cold minus the overshoot. Rounded to the sheet's step.
     * Null unless all three are known.
     *
     * The loop *around* this — reading the day's setup sheet and writing the
     * next day's — is web-only, because the setup notebook is.
     */
    public fun suggestCold(coldPsi: Double?, hotPsi: Double?, targetPsi: Double?): ColdSuggestion? {
        if (coldPsi == null || hotPsi == null || targetPsi == null) return null
        val suggested = roundPsi(coldPsi - (hotPsi - targetPsi))
        return ColdSuggestion(coldPsi, hotPsi, targetPsi, suggested, suggested - coldPsi)
    }

    /**
     * Two unit systems: [METRIC] is the stored one, [US] is what every client
     * shows, since the rest of the logbook is in °F, mph and psi.
     */
    public enum class Units { METRIC, US }

    private data class UnitSpec(val unit: String, val conv: (Double) -> Double, val dp: Int)

    private fun unitSpec(def: Def, units: Units): UnitSpec = when {
        def.unit == "°C" && units == Units.US -> UnitSpec("°F", ::cToF, 0)
        def.unit == "°C" -> UnitSpec("°C", { it }, 0)
        def.unit == "kPa" && units == Units.US -> UnitSpec("psi", ::kpaToPsi, 1)
        def.unit == "kPa" -> UnitSpec("kPa", { it }, 0)
        def.unit == "V" -> UnitSpec("V", { it }, 1)
        else -> UnitSpec("%", { it }, 0)
    }

    /**
     * A value formatted the way JavaScript's `toFixed` does — half away from
     * zero — and in [Locale.ROOT], so a device set to a comma-decimal locale
     * doesn't render "14,5 psi" against a fixture that says "14.5 psi".
     */
    private fun fixed(value: Double, dp: Int): String {
        val scale = 10.0.pow(dp)
        val rounded = if (value < 0) -round(abs(value) * scale) / scale else round(value * scale) / scale
        return String.format(Locale.ROOT, "%.${dp}f", rounded)
    }

    /** A stored value in the given unit system. */
    @Serializable
    public data class Display(val value: Double, val unit: String, val dp: Int, val text: String)

    public fun displayValue(def: Def, v: Double, units: Units = Units.METRIC): Display {
        val u = unitSpec(def, units)
        val value = u.conv(v)
        return Display(value, u.unit, u.dp, "${fixed(value, u.dp)} ${u.unit}")
    }

    /**
     * A delta (spread) in the given unit system, signed. Temperature deltas
     * scale but don't offset — +10 °C is +18 °F, not 50.
     */
    @Serializable
    public data class DisplayDelta(val value: Double, val unit: String, val text: String)

    public fun displayDelta(def: Def, d: Double, units: Units = Units.METRIC): DisplayDelta {
        val u = unitSpec(def, units)
        val value = if (def.unit == "°C") d * (if (units == Units.US) 1.8 else 1.0) else u.conv(d)
        val dp = if (def.unit == "°C") 0 else u.dp
        return DisplayDelta(value, u.unit, "${if (value > 0) "+" else ""}${fixed(value, dp)} ${u.unit}")
    }

    /**
     * The stats-line sentence: every column past its watch line, worst first,
     * plus the fuel outlook when there is one. Factual, no scolding. Null when
     * nothing is past a line and there is no fuel figure.
     */
    public fun healthSummary(channels: SessionChannels?, units: Units = Units.METRIC): String? {
        val sh = sessionHealth(channels) ?: return null
        val parts = ArrayList<String>()
        // A stable sort, as the JS's is: `due` first, otherwise column order.
        val flagged = sh.columns.filter { it.status == Status.DUE || it.status == Status.LOW }
        val ordered = flagged.filter { it.status == Status.DUE } + flagged.filter { it.status == Status.LOW }
        for (c in ordered) {
            val def = defFor(c.key) ?: continue
            parts.add("${def.label.lowercase(Locale.ROOT)} ${displayValue(def, c.extreme.v, units).text}")
        }
        fuelBurn(channels)?.let {
            parts.add("≈${it.lapsRemaining} lap${if (it.lapsRemaining == 1) "" else "s"} of fuel at this rate")
        }
        return if (parts.isEmpty()) null else "car: ${parts.joinToString(", ")}"
    }
}
