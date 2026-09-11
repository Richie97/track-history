package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.serialization.Serializable

/**
 * Rotation — understeer or oversteer (#189) — the port of the pure half of
 * `public/js/balance.js`.
 *
 * Same function and constant names as the JS original so the two diff by eye,
 * that file's test cases come with it ([BalanceTest]), and the output is pinned
 * against the web implementation by `contracts/logic/balance.json`. Only the
 * maths crosses over: the SVG scatter, the HTML table and the hover wiring are
 * the web's, and `BalanceScatter` draws the phone's version.
 *
 * A PDR import stores `yaw` (yaw rate, °/s, signed) and `steering`
 * (steering-wheel angle, °, signed) per lap on the driven-distance grid. Alone
 * the yaw trace is another squiggle. Against the steering trace it is a balance
 * diagnosis: in a neutral car the rotation follows the steering; when the driver
 * adds steering and the car does not rotate to match, the front is washing out
 * — understeer; when the car rotates more than the steering asked for, the rear
 * is coming round — oversteer. Amateurs nearly always believe they are
 * oversteering when they are understeering, because understeer feels like
 * nothing happening, and this view exists to settle that argument with the car's
 * own numbers.
 *
 * The rigorous version is the bicycle model: expected yaw rate = v·δ/L, with δ
 * the *road-wheel* angle (steering-wheel angle ÷ steering ratio) and L the
 * wheelbase. Neither the ratio nor the wheelbase is stored, and the ratio is
 * non-linear with lock on some cars, so v1 is deliberately **relative**: the
 * session's own median yaw-per-degree-per-metre-per-second over every cornering
 * sample is taken as this car's typical response ([referenceGain], which absorbs
 * 1/(L·ratio)), and each corner is read against it. The consequence is stated
 * wherever the figures are shown: a car that pushes in every corner reads
 * neutral in every corner. What the view does find is the corner that behaves
 * differently from the rest — which is the one worth taking to the setup sheet.
 *
 * Two data facts shape everything here, and this port inherits both. The sign
 * conventions of `yaw` and `steering` are the recorder's, not ours, and nothing
 * guarantees they agree — so the alignment is *measured* per session ([yawSign],
 * the sign of Σ steering·yaw over the cornering samples) rather than assumed.
 * And the 20 m grid smooths transients: yaw builds a beat after the steering
 * goes on at entry and decays a beat after it comes off at exit, so single
 * samples scatter around the line and only the sum over a whole corner is a
 * reading. The read-out therefore works per corner, never per sample, and the
 * scatter is there to show the shape.
 */
public object Balance {
    /**
     * Below this steering-wheel angle the yaw-per-degree ratio is noise divided
     * by noise; such samples plot but never count. Display semantics, tune
     * against real footage.
     */
    public const val MIN_STEER_DEG: Double = 10.0

    /** Below this speed the car is in the pits or the paddock, not cornering. */
    public const val MIN_SPEED_KPH: Double = 30.0

    /**
     * A corner whose rotation sits within this much of the reference reads
     * neutral; beyond [SLIGHT_PCT] the word drops its "slight".
     */
    public const val NEUTRAL_PCT: Double = 8.0
    public const val SLIGHT_PCT: Double = 20.0

    private const val KPH_TO_MPS = 1.0 / 3.6

    /** True when the lap stored the three channels the diagnosis reads. */
    public fun hasBalanceData(entry: LapChannels?): Boolean =
        entry?.yaw != null && entry.steering != null && entry.speed != null

    /** One readable lap of a session, keeping its channel index. */
    public data class BalanceLap(val chIdx: Int, val entry: LapChannels)

    /** The laps of a session that can be read. */
    public fun balanceLaps(channels: SessionChannels?): List<BalanceLap> =
        (channels?.laps ?: emptyList()).mapIndexedNotNull { chIdx, entry ->
            if (hasBalanceData(entry)) BalanceLap(chIdx, entry) else null
        }

    /** The grid points a lap covers with all three channels. */
    private fun usableLength(entry: LapChannels): Int {
        val yaw = entry.yaw ?: return 0
        val steering = entry.steering ?: return 0
        val speed = entry.speed ?: return 0
        return minOf(yaw.size, steering.size, speed.size)
    }

    /**
     * Whether grid point [k] of a lap counts toward a reading: enough steering
     * to divide by, and moving.
     */
    public fun usableAt(entry: LapChannels?, k: Int): Boolean {
        if (entry == null || !hasBalanceData(entry) || k < 0 || k >= usableLength(entry)) return false
        return abs(entry.steering!![k]) >= MIN_STEER_DEG && entry.speed!![k] >= MIN_SPEED_KPH
    }

    /**
     * Which way the recorder's yaw runs relative to its steering: +1 when a
     * positive steering angle produces a positive yaw rate, -1 when the two
     * conventions oppose. Measured over every usable sample of every readable
     * lap; +1 when there is nothing to measure. See the file's documentation.
     */
    public fun yawSign(channels: SessionChannels?): Double {
        var sum = 0.0
        for (lap in balanceLaps(channels)) {
            for (k in 0 until usableLength(lap.entry)) {
                if (usableAt(lap.entry, k)) sum += lap.entry.steering!![k] * lap.entry.yaw!![k]
            }
        }
        return if (sum < 0) -1.0 else 1.0
    }

    /**
     * One sample's yaw gain: aligned yaw rate per degree of steering per metre
     * per second — the bicycle model's 1/(L·ratio), in 1/m. Null when the sample
     * is not usable.
     */
    public fun yawGain(entry: LapChannels?, k: Int, sign: Double = 1.0): Double? {
        if (entry == null || !usableAt(entry, k)) return null
        return (entry.yaw!![k] * sign) / (entry.speed!![k] * KPH_TO_MPS * entry.steering!![k])
    }

    /** The median of a list, or null for an empty one. */
    public fun median(values: List<Double>): Double? {
        if (values.isEmpty()) return null
        val s = values.sorted()
        val mid = s.size / 2
        return if (s.size % 2 == 1) s[mid] else (s[mid - 1] + s[mid]) / 2
    }

    /**
     * This car's typical response today: the median yaw gain over every usable
     * sample of every readable lap. Null when there is none.
     */
    public fun referenceGain(channels: SessionChannels?, sign: Double = yawSign(channels)): Double? {
        val gains = ArrayList<Double>()
        for (lap in balanceLaps(channels)) {
            for (k in 0 until usableLength(lap.entry)) {
                yawGain(lap.entry, k, sign)?.let { gains.add(it) }
            }
        }
        return median(gains)
    }

    /**
     * One scatter point: [steer] the steering angle as stored, [rot] the aligned
     * yaw rate ÷ speed (°/m — the curvature the car actually took) and [speed]
     * in km/h. [usable] is false for a sample that plots but doesn't count
     * toward a reading.
     */
    @Serializable
    public data class Point(
        val k: Int,
        val steer: Double,
        val rot: Double,
        val speed: Double,
        val usable: Boolean,
    )

    /**
     * One lap as scatter points — one per grid sample carrying all three
     * channels. A stationary sample has no rotation per metre and is skipped.
     */
    public fun balancePoints(entry: LapChannels?, sign: Double = 1.0): List<Point> {
        if (entry == null || !hasBalanceData(entry)) return emptyList()
        val out = ArrayList<Point>()
        for (k in 0 until usableLength(entry)) {
            val v = entry.speed!![k] * KPH_TO_MPS
            if (v <= 0) continue
            out.add(
                Point(
                    k = k,
                    steer = entry.steering!![k],
                    rot = (entry.yaw!![k] * sign) / v,
                    speed = entry.speed!![k],
                    usable = usableAt(entry, k),
                ),
            )
        }
        return out
    }

    /**
     * How one lap took one corner: the sum over its usable samples of the
     * rotation the steering asked for ([expected], |refGain·v·δ|) and the
     * rotation the car delivered projected onto it ([actual]), their [ratio],
     * and [pct] = (ratio − 1)·100 — negative is understeer. Sums rather than a
     * mean of per-sample ratios, so a barely-steering sample can't blow the
     * reading up.
     */
    @Serializable
    public data class Reading(
        val expected: Double,
        val actual: Double,
        val samples: Int,
        val ratio: Double,
        val pct: Double,
    )

    private fun withPct(expected: Double, actual: Double, samples: Int) =
        Reading(
            expected = expected,
            actual = actual,
            samples = samples,
            ratio = actual / expected,
            pct = (actual / expected - 1) * 100,
        )

    /**
     * Null when the corner holds no usable sample of this lap, the reference
     * isn't positive, or the lap can't be read.
     */
    public fun cornerBalance(
        entry: LapChannels?,
        corner: Corners.Corner,
        refGain: Double,
        sign: Double = 1.0,
    ): Reading? {
        if (entry == null || !hasBalanceData(entry) || refGain <= 0) return null
        var expected = 0.0
        var actual = 0.0
        var samples = 0
        val n = usableLength(entry)
        var k = corner.k0
        while (k <= corner.k1 && k < n) {
            if (usableAt(entry, k)) {
                val e = refGain * entry.speed!![k] * KPH_TO_MPS * entry.steering!![k]
                expected += abs(e)
                // JavaScript's Math.sign: 0 for a zero expectation, which
                // contributes nothing rather than flipping the projection.
                actual += entry.yaw!![k] * sign * (if (e > 0) 1.0 else if (e < 0) -1.0 else 0.0)
                samples++
            }
            k++
        }
        if (samples == 0 || expected <= 0) return null
        return withPct(expected, actual, samples)
    }

    /** The word for a reading. Negative [pct] is the front washing out. */
    public fun balanceLabel(pct: Double): String {
        val a = abs(pct)
        if (a < NEUTRAL_PCT) return "neutral"
        val word = if (pct < 0) "understeer" else "oversteer"
        return if (a < SLIGHT_PCT) "slight $word" else word
    }

    /**
     * The word with its magnitude: "understeer 14%", "slight oversteer 9%",
     * "neutral".
     */
    public fun fmtBalance(pct: Double): String {
        val label = balanceLabel(pct)
        return if (label == "neutral") label else "$label ${abs(pct).roundToInt()}%"
    }

    /** One lap's reading of one corner. */
    @Serializable
    public data class LapReading(
        val chIdx: Int,
        val expected: Double,
        val actual: Double,
        val samples: Int,
        val ratio: Double,
        val pct: Double,
    )

    /**
     * One corner's row in the read-out: the corner, one reading per readable lap
     * in channel order, and the same sums pooled across every readable lap.
     */
    public data class CornerBalance(
        val corner: Corners.Corner,
        val laps: List<LapReading>,
        val all: Reading,
    )

    /** A session reduced for the read-out. */
    public data class SessionBalance(
        val sign: Double,
        val refGain: Double,
        val corners: List<CornerBalance>,
    )

    /**
     * Null when no lap stored the three channels, no lap stored `latG` to find
     * corners in, or the reference can't be established.
     */
    public fun sessionBalance(channels: SessionChannels?): SessionBalance? {
        val laps = balanceLaps(channels)
        if (laps.isEmpty()) return null
        val corners = Corners.sessionCorners(channels)
        if (corners.isEmpty()) return null
        val sign = yawSign(channels)
        val refGain = referenceGain(channels, sign)
        if (refGain == null || refGain <= 0) return null
        val rows = ArrayList<CornerBalance>()
        for (c in corners) {
            val perLap = ArrayList<LapReading>()
            var expected = 0.0
            var actual = 0.0
            var samples = 0
            for (lap in laps) {
                val cb = cornerBalance(lap.entry, c, refGain, sign) ?: continue
                perLap.add(
                    LapReading(
                        chIdx = lap.chIdx,
                        expected = cb.expected,
                        actual = cb.actual,
                        samples = cb.samples,
                        ratio = cb.ratio,
                        pct = cb.pct,
                    ),
                )
                expected += cb.expected
                actual += cb.actual
                samples += cb.samples
            }
            if (perLap.isEmpty()) continue
            rows.add(CornerBalance(corner = c, laps = perLap, all = withPct(expected, actual, samples)))
        }
        return if (rows.isEmpty()) null else SessionBalance(sign = sign, refGain = refGain, corners = rows)
    }

    /**
     * Corners named when there are a few, counted when there are many —
     * "T1, T4" reads; "T1, T3, T5, T7, T9, T11" doesn't.
     */
    private const val MAX_NAMED_CORNERS = 3

    private fun namedOrCounted(corners: List<CornerBalance>): String =
        if (corners.size <= MAX_NAMED_CORNERS) {
            corners.joinToString(", ") { Corners.cornerLabel(it.corner) }
        } else {
            "${corners.size} corners"
        }

    /**
     * One line for the session stats: "understeer in T1, T4 and oversteer in
     * T10", one half when only one side shows, "balance neutral" when every
     * corner reads neutral against the reference. Null when the session can't be
     * read. Pooled across laps, like the rest of the stats line.
     */
    public fun balanceSummary(channels: SessionChannels?): String? {
        val sb = sessionBalance(channels) ?: return null
        val us = sb.corners.filter { it.all.pct <= -NEUTRAL_PCT }
        val os = sb.corners.filter { it.all.pct >= NEUTRAL_PCT }
        val parts = ArrayList<String>()
        if (us.isNotEmpty()) parts.add("understeer in ${namedOrCounted(us)}")
        if (os.isNotEmpty()) parts.add("oversteer in ${namedOrCounted(os)}")
        return if (parts.isEmpty()) "balance neutral" else parts.joinToString(" and ")
    }
}
