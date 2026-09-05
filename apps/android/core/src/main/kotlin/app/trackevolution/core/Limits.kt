package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import kotlinx.serialization.Serializable
import kotlin.math.hypot
import kotlin.math.min

/**
 * Where the car is at its limit (#188) — the port of `public/js/limits.js`.
 *
 * Same function and constant names as the JS original so the two diff by eye,
 * that file's test cases come with it (`LimitsTest`), and the output is pinned
 * against the web implementation by `contracts/logic/limits.json`.
 *
 * Two of a PDR import's stored channels answer a question that is spatial
 * rather than temporal. `wheelSlip` is (driven − non-driven) wheelspeed as a
 * percent — positive under wheelspin, negative under lockup — and `flags` packs
 * ABS (bit 0), traction control (bit 1) and stability control (bit 2), OR-ed
 * across each 20 m grid window so a half-second ABS event isn't missed between
 * samples. Nobody wants a line chart of either; what a driver wants is *where*
 * the car let go, which is a handful of specific places on the track — so this
 * reduces both channels to runs of grid points per kind, and places those runs
 * on the stored best-lap trace by matching driven distance.
 *
 * Colour is by kind, not severity: a corner where traction control cuts is a
 * throttle problem, one where ABS cuts is a braking problem, and the driver
 * needs to know which. And the read-out reports rather than scolds — "ABS
 * active" is a fact; "you're braking too hard" is a guess. A session whose
 * systems never fired says "no interventions": TC/VSC read zero all day with
 * the systems switched off, which is normal on track, and "off" and "never
 * needed" are indistinguishable.
 */
public object Limits {

    /**
     * Display semantics, not physics: slip above this is wheelspin, below the
     * negative one is lockup. Tune against real footage.
     */
    public const val WHEELSPIN_PCT: Double = 2.0
    public const val LOCKUP_PCT: Double = -2.0

    public const val FLAG_ABS: Int = 1
    public const val FLAG_TC: Int = 2
    public const val FLAG_VSC: Int = 4

    /**
     * Runs of one kind separated by at most this many clear grid points are one
     * place — an ABS pulse train across a braking zone is one braking zone, not
     * four. 2 points = 40 m at the 20 m grid.
     */
    public const val MERGE_GAP_POINTS: Int = 2

    /**
     * Which colour a kind draws in. Braking-side events (ABS, lockup) share one
     * hue, power-side (traction control, wheelspin) another, stability its own.
     */
    public enum class Side { BRAKE, POWER, STABILITY }

    /**
     * The second encoding beside colour, so the two events of one side are never
     * colour-alone.
     */
    public enum class Shape { CIRCLE, TRIANGLE, DIAMOND }

    /**
     * One kind of limit event. [channel] is the chart whose trace the kind's
     * bands shade.
     */
    public data class Kind(
        val key: String,
        val label: String,
        val side: Side,
        val shape: Shape,
        val filled: Boolean,
        val channel: ChannelGraphs.Channel,
    )

    /** The kinds, in render and report order. */
    public val LIMIT_KINDS: List<Kind> = listOf(
        Kind("abs", "ABS", Side.BRAKE, Shape.CIRCLE, true, ChannelGraphs.Channel.BRAKE),
        Kind("lockup", "Lockup", Side.BRAKE, Shape.CIRCLE, false, ChannelGraphs.Channel.BRAKE),
        Kind("tc", "Traction control", Side.POWER, Shape.TRIANGLE, true, ChannelGraphs.Channel.THROTTLE),
        Kind("wheelspin", "Wheelspin", Side.POWER, Shape.TRIANGLE, false, ChannelGraphs.Channel.THROTTLE),
        Kind("vsc", "Stability control", Side.STABILITY, Shape.DIAMOND, true, ChannelGraphs.Channel.STEERING),
    )

    public fun kindDef(key: String): Kind? = LIMIT_KINDS.firstOrNull { it.key == key }

    /** True when the lap stored something this module can read. */
    public fun hasLimitData(entry: LapChannels): Boolean = entry.flags != null || entry.wheelSlip != null

    /**
     * Whether [kind] is active at grid point [k] of a lap; null when the lap
     * doesn't carry the channel the kind reads.
     */
    public fun limitAt(entry: LapChannels, kind: String, k: Int): Boolean? = when (kind) {
        "abs", "tc", "vsc" -> {
            val f = entry.flags
            if (f == null || k >= f.size) {
                null
            } else {
                val bit = when (kind) {
                    "abs" -> FLAG_ABS
                    "tc" -> FLAG_TC
                    else -> FLAG_VSC
                }
                (jsInt32(f[k]) and bit) != 0
            }
        }
        "wheelspin", "lockup" -> {
            val s = entry.wheelSlip
            if (s == null || k >= s.size) {
                null
            } else if (kind == "wheelspin") {
                s[k] > WHEELSPIN_PCT
            } else {
                s[k] < LOCKUP_PCT
            }
        }
        else -> null
    }

    /** JavaScript's ToInt32, which is what `and` does to a number before masking. */
    private fun jsInt32(value: Double): Int {
        if (!value.isFinite()) return 0
        val truncated = if (value < 0) kotlin.math.ceil(value) else kotlin.math.floor(value)
        return truncated.toLong().toInt()
    }

    /** An inclusive run of grid points. */
    @Serializable
    public data class Run(val k0: Int, var k1: Int)

    /**
     * Runs of true in a boolean series, merged across gaps of at most [mergeGap]
     * false points.
     */
    public fun booleanRuns(series: List<Boolean>, mergeGap: Int = MERGE_GAP_POINTS): List<Run> {
        val out = mutableListOf<Run>()
        var k0 = -1
        for (k in 0..series.size) {
            val on = k < series.size && series[k]
            if (on) {
                if (k0 < 0) k0 = k
            } else if (k0 >= 0) {
                // Merge with the previous run when the gap between them is short.
                val prev = out.lastOrNull()
                if (prev != null && k0 - prev.k1 - 1 <= mergeGap) prev.k1 = k - 1 else out.add(Run(k0, k - 1))
                k0 = -1
            }
        }
        return out
    }

    /** One limit event: an inclusive run of grid points of a single kind. */
    @Serializable
    public data class LimitRun(val kind: String, val k0: Int, val k1: Int)

    /**
     * Every limit event in one stored lap, in [LIMIT_KINDS] order then by
     * distance. Kinds whose channel the lap lacks contribute nothing.
     */
    public fun limitRuns(entry: LapChannels, mergeGap: Int = MERGE_GAP_POINTS): List<LimitRun> {
        val out = mutableListOf<LimitRun>()
        for (kind in LIMIT_KINDS) {
            val n = if (kind.key == "wheelspin" || kind.key == "lockup") {
                entry.wheelSlip?.size ?: 0
            } else {
                entry.flags?.size ?: 0
            }
            if (n == 0) continue
            val series = (0 until n).map { limitAt(entry, kind.key, it) == true }
            for (run in booleanRuns(series, mergeGap)) out.add(LimitRun(kind.key, run.k0, run.k1))
        }
        return out
    }

    /** The kinds active at grid point [k] of a lap, as labels — the read-out suffix. */
    public fun activeLimitLabels(entry: LapChannels, k: Int): List<String> =
        LIMIT_KINDS.filter { limitAt(entry, it.key, k) == true }.map { it.label }

    /**
     * One kind's tally across a session. [places] is the number of distinct
     * stretches of track where *any* lap hit that kind (the union across laps,
     * merged like a single lap's runs), [laps] how many laps did.
     */
    @Serializable
    public data class KindTally(val kind: String, val places: Int, val laps: Int)

    /**
     * A session's limit events reduced per kind, for every kind the session could
     * read.
     */
    @Serializable
    public data class SessionLimits(
        val kinds: List<KindTally>,
        val hasFlags: Boolean,
        val hasSlip: Boolean,
    )

    /** Null when no lap stored flags or slip. */
    public fun sessionLimits(channels: SessionChannels, mergeGap: Int = MERGE_GAP_POINTS): SessionLimits? {
        val laps = channels.laps.filter { hasLimitData(it) }
        if (laps.isEmpty()) return null
        val hasFlags = laps.any { it.flags != null }
        val hasSlip = laps.any { it.wheelSlip != null }
        val kinds = mutableListOf<KindTally>()
        for (kind in LIMIT_KINDS) {
            val isSlip = kind.key == "wheelspin" || kind.key == "lockup"
            if (if (isSlip) !hasSlip else !hasFlags) continue
            val n = laps.maxOf { (if (isSlip) it.wheelSlip?.size else it.flags?.size) ?: 0 }
            val union = BooleanArray(n)
            var lapCount = 0
            for (l in laps) {
                var hit = false
                for (k in 0 until n) {
                    if (limitAt(l, kind.key, k) == true) {
                        union[k] = true
                        hit = true
                    }
                }
                if (hit) lapCount++
            }
            kinds.add(KindTally(kind.key, booleanRuns(union.toList(), mergeGap).size, lapCount))
        }
        return SessionLimits(kinds = kinds, hasFlags = hasFlags, hasSlip = hasSlip)
    }

    /**
     * The noun a kind's places are counted in, by side. A bare "in 8 places"
     * invites comparison with the track's corner count, which is a different and
     * much larger number: ABS fires in the braking zones, and VIR's 17 turns
     * hold about 8 of those — the rest are flat or lift-only. Naming the
     * activity is what stops the count reading as a corner tally, and it has to
     * be per side, since "wheelspin in 10 braking zones" is nonsense. Singular;
     * callers add the "s" the way they did for "place".
     */
    public val ZONE_NOUNS: Map<Side, String> = mapOf(
        Side.BRAKE to "braking zone",
        Side.POWER to "acceleration zone",
        Side.STABILITY to "corner",
    )

    public fun zoneNoun(kind: String): String = kindDef(kind)?.side?.let { ZONE_NOUNS[it] } ?: "place"

    /**
     * One line for the session stats: "ABS in 3 braking zones, wheelspin in 2
     * acceleration zones" — or "no interventions" when the systems never fired
     * and the wheels never slipped. Null when the session stored neither channel.
     */
    public fun limitSummary(channels: SessionChannels): String? {
        val sl = sessionLimits(channels) ?: return null
        val parts = sl.kinds
            .filter { it.places > 0 }
            .map { "${sentenceLabel(it.kind)} in ${it.places} ${zoneNoun(it.kind)}${if (it.places == 1) "" else "s"}" }
        return if (parts.isEmpty()) "no interventions" else parts.joinToString(", ")
    }

    /** A kind's label as it reads mid-sentence: acronyms keep their case. */
    public fun sentenceLabel(kind: String): String {
        val label = kindDef(kind)?.label ?: return kind
        return if (label == label.uppercase()) label else label.lowercase()
    }

    /** A limit run placed on the stored trace: [idx] indexes the trace points. */
    @Serializable
    public data class Marker(val kind: String, val k0: Int, val k1: Int, val idx: Int)

    /**
     * Place one lap's limit runs on a stored trace (the best lap's racing line,
     * time-sampled) by driven distance: each run's mid-point is taken as a
     * fraction of the lap's grid length and looked up along the trace's
     * cumulative length. The trace is the best lap only, so callers pass the best
     * lap's channel entry — matching another lap's runs onto it would put marks
     * where that lap never was.
     */
    public fun limitMarkers(entry: LapChannels, dStepM: Double, trace: List<TraceSample>?): List<Marker> {
        if (trace == null || trace.size < 2) return emptyList()
        val runs = limitRuns(entry)
        if (runs.isEmpty()) return emptyList()
        val n = maxOf(entry.speed?.size ?: 0, entry.flags?.size ?: 0, entry.wheelSlip?.size ?: 0)
        val lapLen = (n - 1) * dStepM
        if (lapLen <= 0) return emptyList()
        val cum = DoubleArray(trace.size)
        for (i in 1 until trace.size) {
            cum[i] = cum[i - 1] + hypot(trace[i].x - trace[i - 1].x, trace[i].y - trace[i - 1].y)
        }
        val total = cum[trace.size - 1]
        if (total <= 0) return emptyList()
        return runs.map { r ->
            val target = min(1.0, ((r.k0 + r.k1) / 2.0 * dStepM) / lapLen) * total
            var idx = 0
            while (idx < trace.size - 1 && cum[idx] < target) idx++
            Marker(kind = r.kind, k0 = r.k0, k1 = r.k1, idx = idx)
        }
    }
}
