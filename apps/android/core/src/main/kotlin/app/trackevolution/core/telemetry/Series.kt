package app.trackevolution.core.telemetry

/**
 * One sample of a telemetry channel: a value on the recording's own clock.
 *
 * `{t, v}` in the JS, which is how every channel — the odometer, latitude,
 * speed, RPM — is carried between `pdr.js`, `pdr-laps.js` and `channels.js`.
 */
public data class ChannelPoint(
    /** Seconds on the recording's clock. */
    val t: Double,
    /** Raw or scaled value, depending on which channel this is. */
    val v: Double,
)

/**
 * Interpolating accessor over a sorted `[{t, v}]` series.
 *
 * A port of `series()` in `public/pdr.js`, with its test cases
 * (`test/unit/pdr.test.js` → `SeriesTest`). Everything downstream of the PDR
 * decoder is built on it: lap boundaries are odometer *distances* converted
 * back to times, and per-lap channel arrays are cut on a distance grid — both
 * of which are this type's [at] / [timeAt] pair.
 *
 * The binary search is the JS's, including `Math.max(1, lo)`: an index of 0
 * would make `arr[i - 1]` a negative subscript, so a query at or below the
 * first sample deliberately interpolates over the *first* interval rather than
 * clamping. Do not "fix" that — the lap maths depends on the extrapolation.
 */
public class Series(public val arr: List<ChannelPoint>) {

    public val n: Int get() = arr.size
    public val first: ChannelPoint get() = arr[0]
    public val last: ChannelPoint get() = arr[arr.size - 1]

    private inline fun idx(key: Double, get: (ChannelPoint) -> Double): Int {
        var lo = 0
        var hi = arr.size - 1
        while (lo < hi) {
            val m = (lo + hi) shr 1
            if (get(arr[m]) < key) lo = m + 1 else hi = m
        }
        return maxOf(1, lo)
    }

    /** The value at a time, linearly interpolated. */
    public fun at(t: Double): Double {
        val i = idx(t) { it.t }
        val a = arr[i - 1]
        val b = arr[i]
        return if (b.t == a.t) a.v else a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t)
    }

    /**
     * The time at a value — assumes `v` is monotonically non-decreasing, which
     * is true of the one series this is used on: the odometer.
     */
    public fun timeAt(v: Double): Double {
        val i = idx(v) { it.v }
        val a = arr[i - 1]
        val b = arr[i]
        return if (b.v == a.v) a.t else a.t + ((b.t - a.t) * (v - a.v)) / (b.v - a.v)
    }

    /** Central-difference slope at a time — the odometer's rate is speed in m/s. */
    public fun rate(t: Double, w: Double = 2.0): Double {
        val a = at(t - w)
        val b = at(t + w)
        return (b - a) / (2 * w)
    }
}

/**
 * `series(arr)`, spelled the way the JS spells it.
 *
 * The ports keep their originals' names so the copies diff by eye
 * (`docs/specs/native/README.md`), and this one reads at every call site
 * inside the parsers.
 */
public fun series(arr: List<ChannelPoint>): Series = Series(arr)
