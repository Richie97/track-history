package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.UnitSystem
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * The channel panel's x-axis and cursor — the port of `public/js/lap-axis.js`
 * under the same names, pinned by `contracts/logic/lap-axis.json`.
 *
 * Every stored channel lap is gridded on driven distance, so distance is the
 * axis the traces are kept on. The panel can also lay them out against each
 * lap's own elapsed time: [ChannelGraphs.lapTimeSeries] already knows how long
 * each lap took to reach each grid point. Overlaid against time, laps drift
 * apart around the track, and that drift is the gap; against distance they line
 * up corner for corner, which is why distance is the default.
 *
 * The cursor is a place picked on the axis by a tap or a pointer. [axisPlaces]
 * turns it into where each lit lap was at that axis value: its fractional grid
 * index (the read-outs and the chart dots) and its fraction of its own lap (the
 * dot on the track map, placed by driven distance).
 *
 * The JS's "web drawing" half (`axisFrame`) is not ported — the Compose charts
 * do their own layout from these.
 */
public object LapAxis {

    /** The two axes a lap can be plotted against — `AXIS_MODES` in the JS. */
    public enum class AxisMode(public val key: String) {
        DISTANCE("distance"),
        TIME("time"),
        ;

        public companion object {
            /** The mode for a key, or null for one this build doesn't know. */
            public fun of(key: String?): AxisMode? = entries.firstOrNull { it.key == key }
        }
    }

    public val AXIS_MODES: List<AxisMode> = AxisMode.entries.toList()
    public val DEFAULT_AXIS: AxisMode = AxisMode.DISTANCE

    /** The step sizes a time axis may tick at, in seconds. */
    public val TIME_TICK_STEPS: List<Int> = listOf(1, 2, 5, 10, 15, 20, 30, 60, 120, 300)

    /** About this many ticks across a chart, as the distance axis aims for. */
    public const val TIME_TICK_TARGET: Int = 6

    /** Where one lap was at an axis value: grid index and fraction of its lap. */
    public data class Place(val chIdx: Int, val k: Double, val frac: Double)

    /** One time-axis tick: seconds, and the m:ss it says. */
    public data class TimeTick(val s: Double, val label: String)

    /**
     * The axis value at each grid point of a stored channel lap. Distance is
     * k × dStepM in metres; time is the lap's elapsed seconds (scaled to the
     * timed lap). A lap with no grid has no series, and on time a lap with no
     * speed trace has none either.
     */
    public fun lapAxisSeries(entry: LapChannels?, dStepM: Double, mode: AxisMode): List<Double>? {
        if (entry == null) return null
        if (mode == AxisMode.TIME) {
            val speed = entry.speed
            if (speed == null || speed.size < 2) return null
            return ChannelGraphs.lapTimeSeries(speed, dStepM, entry.timeMs)
        }
        val n = entry.speed?.size
            ?: listOf(entry.throttle, entry.brake, entry.steering, entry.rpm, entry.latG, entry.yaw, entry.gear)
                .maxOf { it?.size ?: 0 }
        if (n < 2) return null
        return List(n) { it * dStepM }
    }

    /** The largest last value of any lap's series, 0 when no lap has one. */
    public fun axisExtent(laps: List<LapChannels>, dStepM: Double, mode: AxisMode): Double {
        var x1 = 0.0
        for (l in laps) {
            val xs = lapAxisSeries(l, dStepM, mode) ?: continue
            if (xs.last() > x1) x1 = xs.last()
        }
        return x1
    }

    /**
     * The fractional index at which a rising series reaches [e] — `gridAtElapsed`
     * in `public/js/video-sync.js`, which this module imports there. Clamped.
     */
    public fun gridAtElapsed(t: List<Double>, e: Double): Double {
        val last = t.size - 1
        if (last <= 0 || !(e > t[0])) return 0.0
        if (e >= t[last]) return last.toDouble()
        var lo = 0
        var hi = last
        while (hi - lo > 1) {
            val mid = (lo + hi) ushr 1
            if (t[mid] <= e) lo = mid else hi = mid
        }
        return lo + (e - t[lo]) / (t[hi] - t[lo])
    }

    /**
     * A lap's fractional grid index at axis value [x], or null when the value
     * is off the lap (before its start or past its end).
     */
    public fun gridAtAxis(xs: List<Double>?, x: Double?): Double? {
        if (xs == null || xs.size < 2 || x == null || !x.isFinite()) return null
        if (x < xs[0] || x > xs[xs.size - 1]) return null
        return gridAtElapsed(xs, x)
    }

    /** The axis value at a fractional grid index, the index clamped. */
    public fun axisAtGrid(xs: List<Double>?, k: Double?): Double? {
        if (xs.isNullOrEmpty() || k == null || !k.isFinite()) return null
        val last = xs.size - 1
        val kk = max(0.0, min(last.toDouble(), k))
        val i0 = floor(kk).toInt()
        if (i0 >= last) return xs[last]
        return xs[i0] + (xs[i0 + 1] - xs[i0]) * (kk - i0)
    }

    /**
     * Where each lap in [lapIdxs] (indexes into [laps], in the caller's order)
     * was at axis value [x]. A lap the value is off is left out; frac is k over
     * the lap's own last grid index.
     */
    public fun axisPlaces(
        laps: List<LapChannels>,
        dStepM: Double,
        mode: AxisMode,
        x: Double?,
        lapIdxs: List<Int>,
    ): List<Place> {
        val out = mutableListOf<Place>()
        for (chIdx in lapIdxs) {
            val xs = lapAxisSeries(laps.getOrNull(chIdx), dStepM, mode)
            val k = gridAtAxis(xs, x) ?: continue
            out.add(Place(chIdx, k, k / (xs!!.size - 1)))
        }
        return out
    }

    /** m:ss for a time-axis tick; ticks land on whole seconds. */
    public fun fmtAxisSeconds(s: Double): String {
        val whole = java.lang.Math.round(s)
        return "${floorDiv(whole, 60)}:${(whole % 60).toString().padStart(2, '0')}"
    }

    /**
     * Ticks for a time axis from 0 to [x1] seconds: the smallest step in
     * [TIME_TICK_STEPS] that keeps the count at or under [TIME_TICK_TARGET], the
     * largest otherwise.
     */
    public fun timeAxisTicks(x1: Double): List<TimeTick> {
        if (!x1.isFinite() || x1 <= 0) return emptyList()
        val step = TIME_TICK_STEPS.firstOrNull { x1 / it <= TIME_TICK_TARGET } ?: TIME_TICK_STEPS.last()
        val out = mutableListOf<TimeTick>()
        var s = 0.0
        while (s <= x1 + 1e-9) {
            out.add(TimeTick(s, fmtAxisSeconds(s)))
            s += step
        }
        return out
    }

    /**
     * The cursor's place as the read-out says it: a distance in the user's
     * units, or the elapsed time to a tenth (m:ss.s).
     */
    public fun fmtAxisValue(x: Double?, mode: AxisMode, units: UnitSystem): String {
        if (x == null || !x.isFinite()) return "—"
        if (mode != AxisMode.TIME) return Units.fmtDist(java.lang.Math.round(x).toDouble(), units)
        val tenths = java.lang.Math.round(max(0.0, x) * 10)
        val sec = (tenths % 600) / 10.0
        return "${tenths / 600}:${if (sec < 10) "0" else ""}${Units.toFixed(sec, 1)}"
    }

    /** The axis's name in a chart's title and description ("distance" / "time"). */
    public fun axisWord(mode: AxisMode): String = if (mode == AxisMode.TIME) "time" else "distance"

    private fun floorDiv(a: Long, b: Long): Long = Math.floorDiv(a, b)
}
