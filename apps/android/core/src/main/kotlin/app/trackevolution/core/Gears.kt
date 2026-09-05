package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import kotlinx.serialization.Serializable
import kotlin.math.abs
import kotlin.math.floor

/**
 * Gear ribbon and shift points (#187) — the port of `public/js/gears.js`.
 *
 * Same function and constant names as the JS original so the two diff by eye,
 * that file's test cases come with it (`GearsTest`), and the output is pinned
 * against the web implementation by `contracts/logic/gears.json` — this port
 * asserts against the reference, never against the Swift one.
 *
 * A PDR import stores `gear` per lap on the driven-distance grid
 * ([app.trackevolution.core.telemetry.LapChannels]) — 1–8, with 0 meaning
 * clutch-in / no gear, sampled by holding the last value because it is an enum,
 * not a measurement. Wrong gear in a corner is the most common correctable
 * mistake an amateur makes and it is invisible in a lap time; as a step change
 * on the distance axis it is instantly visible, and against a second lap it
 * becomes a sentence: "T5 in 3rd on the best lap, 4th on this one".
 *
 * [gearSegments] cuts a lap into runs of one gear (the ribbon's blocks);
 * [lapShifts] finds where the gear steps and reads the rpm at the sample
 * *before* the step — mind the 20 m grid: a shift takes ~0.3 s, about one grid
 * point at speed, so the figure is a touch low and is labelled approximate;
 * [shiftPoints] reduces a session's upshifts to min / median / max rpm per
 * gear, which is what turns short-shifting and bouncing off the limiter into a
 * number each. [gearDisagreements] is the comparison rule.
 */
public object Gears {

    /**
     * A run of differing gears shorter than this (3 points = 60 m at the 20 m
     * grid) is a shift that landed on a different sample, not a different gear
     * choice. Display semantics, not physics — tune against real footage.
     */
    public const val MIN_DISAGREE_POINTS: Int = 3

    /**
     * An upshift more than this many rpm below the session's highest per-gear
     * median is worth a sentence ("shifting earlier from 4th than from 2nd").
     */
    public const val SHORT_SHIFT_RPM: Double = 500.0

    /**
     * A gear whose latest upshift comes within this of the session's highest
     * rpm sample was taken to the top of the rev range.
     */
    public const val REV_LIMIT_MARGIN_RPM: Double = 100.0

    /** Fewer upshifts than this from one gear is not a pattern. */
    public const val MIN_SHIFTS_FOR_NOTE: Int = 2

    // ---------------------------------------------------------------- format

    /** "3rd", "4th" … — gear 0 is "no gear". */
    public fun ordinal(gear: Double): String {
        if (gear <= 0) return "no gear"
        val g = gear.toInt()
        val s = when {
            g % 10 == 1 && g != 11 -> "st"
            g % 10 == 2 && g != 12 -> "nd"
            g % 10 == 3 && g != 13 -> "rd"
            else -> "th"
        }
        return "$g$s"
    }

    /**
     * Whole rpm with thousands separators, locale-independent so tests and the
     * fixture are deterministic — `String.format` would insert whatever the
     * device's locale calls a group separator.
     */
    public fun fmtRpm(value: Double): String {
        val rounded = jsRound(value)
        var digits = abs(rounded).toString()
        var out = ""
        while (digits.length > 3) {
            out = "," + digits.takeLast(3) + out
            digits = digits.dropLast(3)
        }
        return (if (rounded < 0) "-" else "") + digits + out
    }

    // -------------------------------------------------------------- segments

    /** A run of one gear along a lap's grid, [k0]..[k1] inclusive grid indexes. */
    @Serializable
    public data class GearRun(val gear: Double, val k0: Int, val k1: Int)

    /**
     * Runs of one gear along a lap's grid, in order and covering every point.
     * Gear 0 runs are kept — the ribbon renders them as gaps, and the
     * disagreement rule needs to know they are there.
     */
    public fun gearSegments(gear: List<Double>?): List<GearRun> {
        if (gear.isNullOrEmpty()) return emptyList()
        val out = mutableListOf<GearRun>()
        var k0 = 0
        for (k in 1..gear.size) {
            if (k == gear.size || gear[k] != gear[k0]) {
                out.add(GearRun(gear[k0], k0, k - 1))
                k0 = k
            }
        }
        return out
    }

    // ---------------------------------------------------------------- shifts

    /**
     * One gear change in a stored lap: [k] is the first grid point in the new
     * gear, [rpm] the reading at the last point in the old gear (null when the
     * lap stored no rpm).
     */
    @Serializable
    public data class Shift(
        val k: Int,
        val from: Double,
        val to: Double,
        val up: Boolean,
        val rpm: Double? = null,
    )

    /**
     * Every gear change in one stored lap. A clutch-in stretch (gear 0) between
     * two gears is skipped over, so 3 → 0 → 4 is one shift from 3rd to 4th,
     * read at the last sample that was still in 3rd.
     */
    public fun lapShifts(entry: LapChannels): List<Shift> {
        val gear = entry.gear ?: return emptyList()
        val rpm = entry.rpm
        val out = mutableListOf<Shift>()
        var last = 0.0
        var lastK = -1
        for (k in gear.indices) {
            val g = gear[k]
            if (g <= 0) continue
            if (last > 0 && g != last) {
                val reading = rpm
                    ?.takeIf { lastK in it.indices && it[lastK].isFinite() }
                    ?.get(lastK)
                out.add(Shift(k = k, from = last, to = g, up = g > last, rpm = reading))
            }
            last = g
            lastK = k
        }
        return out
    }

    /** One gear's upshift rpm across a session. */
    @Serializable
    public data class GearShifts(
        val gear: Double,
        val count: Int,
        val minRpm: Double,
        val medianRpm: Int,
        val maxRpm: Double,
    )

    /**
     * A session's upshifts reduced to rpm per gear. [maxRpm] is the highest rpm
     * sample in any lap with gear data — the top of the rev range *seen today*,
     * which is not the same claim as the car's limiter.
     */
    @Serializable
    public data class SessionShifts(
        val gears: List<GearShifts>,
        val medianRpm: Int,
        val maxRpm: Double? = null,
    )

    private fun median(sorted: List<Double>): Double {
        val m = sorted.size shr 1
        return if (sorted.size % 2 == 1) sorted[m] else (sorted[m - 1] + sorted[m]) / 2
    }

    /**
     * Only laps carrying both `gear` and `rpm` count; null when none does or
     * none of them upshifts. Rounded to whole rpm — the stored samples are, and
     * a median of two is the only place a half can appear.
     */
    public fun shiftPoints(channels: SessionChannels): SessionShifts? {
        // Insertion-ordered rather than a map keyed by a Double, which would
        // order the gears by hash.
        val byGear = mutableListOf<Pair<Double, MutableList<Double>>>()
        val all = mutableListOf<Double>()
        var maxRpm: Double? = null
        for (l in channels.laps) {
            if (l.gear == null) continue
            val rpm = l.rpm ?: continue
            for (v in rpm) if (v.isFinite() && (maxRpm == null || v > maxRpm!!)) maxRpm = v
            for (s in lapShifts(l)) {
                val r = s.rpm
                if (!s.up || r == null) continue
                all.add(r)
                val slot = byGear.firstOrNull { it.first == s.from }
                if (slot != null) slot.second.add(r) else byGear.add(s.from to mutableListOf(r))
            }
        }
        if (all.isEmpty()) return null
        val gears = byGear
            .sortedBy { it.first }
            .map { (gear, rpms) ->
                val sorted = rpms.sorted()
                GearShifts(
                    gear = gear,
                    count = sorted.size,
                    minRpm = sorted.first(),
                    medianRpm = jsRound(median(sorted)),
                    maxRpm = sorted.last(),
                )
            }
        return SessionShifts(gears = gears, medianRpm = jsRound(median(all.sorted())), maxRpm = maxRpm)
    }

    /**
     * What the shift points say, as short factual sentences — facts about this
     * session, never a verdict: "ABS active" is a fact, "you're braking too
     * hard" is a guess (#188), and the same rule holds here. Two patterns are
     * worth a line each: a gear taken to the top of the rev range seen today,
     * and a gear shifted out of markedly earlier than the gear shifted latest.
     */
    public fun shiftNotes(sp: SessionShifts?): List<String> {
        if (sp == null || sp.gears.isEmpty()) return emptyList()
        val notes = mutableListOf<String>()
        val counted = sp.gears.filter { it.count >= MIN_SHIFTS_FOR_NOTE }
        if (counted.isEmpty()) return notes
        // First maximum wins a tie, matching the JS's strict `>`.
        var topIndex = 0
        counted.forEachIndexed { i, g -> if (g.medianRpm > counted[topIndex].medianRpm) topIndex = i }
        val top = counted[topIndex]
        val sessionMax = sp.maxRpm
        if (sessionMax != null) {
            val atLimit = counted.filter { it.maxRpm >= sessionMax - REV_LIMIT_MARGIN_RPM }
            if (atLimit.isNotEmpty()) {
                val which = atLimit.joinToString(" and ") { ordinal(it.gear) }
                notes.add(
                    "Upshifts from $which run to the top of the rev range seen today " +
                        "(≈${fmtRpm(sessionMax)} rpm).",
                )
            }
        }
        counted.forEachIndexed { i, g ->
            if (i == topIndex) return@forEachIndexed
            val gap = (top.medianRpm - g.medianRpm).toDouble()
            if (gap >= SHORT_SHIFT_RPM) {
                notes.add(
                    "Upshifts from ${ordinal(g.gear)} come ≈${fmtRpm(gap)} rpm earlier " +
                        "than from ${ordinal(top.gear)}.",
                )
            }
        }
        return notes
    }

    // -------------------------------------------------------- disagreements

    /** A stretch of grid where the highlighted laps sit in different gears. */
    @Serializable
    public data class Disagreement(val k0: Int, val k1: Int)

    /**
     * Grid runs where two or more laps sit in different gears, over one array
     * per lap. A point counts only where at least two laps report a gear above 0
     * and those gears aren't all equal; runs shorter than [minRun] points are
     * dropped (see [MIN_DISAGREE_POINTS]) — a shift landing a point later on one
     * lap is not a different gear choice.
     */
    public fun gearDisagreements(
        gears: List<List<Double>?>,
        minRun: Int = MIN_DISAGREE_POINTS,
    ): List<Disagreement> {
        val arrs = gears.filterNotNull()
        if (arrs.size < 2) return emptyList()
        val n = arrs.maxOf { it.size }
        val out = mutableListOf<Disagreement>()
        var k0 = -1
        for (k in 0..n) {
            var differs = false
            if (k < n) {
                var seen = 0.0
                for (a in arrs) {
                    val g = a.getOrNull(k) ?: continue
                    if (g <= 0) continue
                    if (seen != 0.0 && g != seen) differs = true
                    if (seen == 0.0) seen = g
                }
            }
            if (differs) {
                if (k0 < 0) k0 = k
            } else if (k0 >= 0) {
                if (k - k0 >= minRun) out.add(Disagreement(k0, k - 1))
                k0 = -1
            }
        }
        return out
    }

    /** JavaScript's `Math.round`: half rounds up (toward +∞). */
    private fun jsRound(value: Double): Int = floor(value + 0.5).toInt()
}
