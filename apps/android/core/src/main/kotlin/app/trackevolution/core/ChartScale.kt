package app.trackevolution.core

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * The scale maths behind the charts (NS-24) — the port of the non-drawing half
 * of `public/js/chart.js`.
 *
 * It lives in `:core` for the usual reason: the axis arithmetic is the part that
 * can be wrong in a way nobody notices, so it belongs where it unit-tests on the
 * JVM. The drawing is Compose's problem.
 *
 * **The reference is the web, not iOS.** iOS's `ChartScale` deliberately chose
 * different numbers — 4% y-padding rather than [Y_PAD_FRACTION]'s 12%, a
 * `max(low * 0.01, 500)` degenerate margin rather than a flat [Y_PAD_FLOOR_MS],
 * and `1` rather than `0.5` from [speedFraction] for a constant-speed trace.
 * This port follows `chart.js`, per the repo convention that a port is diffed
 * against its JS original; NS-24 asks for parity of *meaning* with iOS (same
 * data, same ordering, same downward-is-better convention), not identical
 * padding. The divergence is recorded here rather than quietly absorbed.
 */
public object ChartScale {

    /** A plotted value range, after padding. */
    public data class Domain(val low: Double, val high: Double) {
        public val span: Double get() = high - low
    }

    /** `chart.js`: `Math.max((y1 - y0) * 0.12, 500)`. */
    public const val Y_PAD_FRACTION: Double = 0.12

    /**
     * The floor under that padding, in milliseconds.
     *
     * It is what keeps a session of identical lap times from dividing by zero:
     * the domain becomes a 1000 ms window and the flat line sits mid-plot.
     */
    public const val Y_PAD_FLOOR_MS: Double = 500.0

    private val TIME_STEPS_MS = listOf(
        100.0, 200.0, 250.0, 500.0, 1000.0, 2000.0, 5000.0,
        10_000.0, 15_000.0, 30_000.0, 60_000.0, 120_000.0,
    )

    /** The step used when a span outruns [TIME_STEPS_MS] — five minutes. */
    private const val TIME_STEP_FALLBACK_MS = 300_000.0

    /**
     * Nice ticks for a plain numeric axis (speed, RPM, G, distance): 1/2/2.5/5
     * × 10^k steps.
     *
     * Used by the lap overlay rather than the lap-time chart, which has its own
     * table below — a time axis wants 15 s and 2 min, which this would never
     * produce.
     */
    public fun niceNumTicks(min: Double, max: Double, count: Int = 4): List<Double> {
        val span = max(1e-9, max - min)
        val raw = span / count
        val pow = 10.0.pow(floor(log10(raw)))
        val step = listOf(1.0, 2.0, 2.5, 5.0, 10.0).map { it * pow }.firstOrNull { it >= raw }
            ?: (10.0 * pow)

        val ticks = mutableListOf<Double>()
        var v = ceil(min / step - 1e-9) * step
        // The epsilon is the JS's, and it matters: without it a tick that lands
        // exactly on `max` is dropped by floating-point noise.
        while (v <= max + 1e-9) {
            ticks += JsMath.round(v, 1e6)
            v += step
        }
        return ticks
    }

    /**
     * Nice ticks for a lap-time axis, in milliseconds.
     *
     * Note the bound is `<= max` with no epsilon, unlike [niceNumTicks]. That
     * asymmetry is in the JS and is preserved rather than tidied, so the two
     * still diff by eye.
     */
    public fun niceTimeTicks(min: Double, max: Double, count: Int = 4): List<Double> {
        val span = max(1.0, max - min)
        val rawStep = span / count
        val step = TIME_STEPS_MS.firstOrNull { it >= rawStep } ?: TIME_STEP_FALLBACK_MS

        val ticks = mutableListOf<Double>()
        var v = ceil(min / step) * step
        while (v <= max) {
            ticks += v
            v += step
        }
        return ticks
    }

    /**
     * The padded y domain for a set of lap times, with the goal folded in.
     *
     * [goal] is clamped inside the range so the goal rule is always drawn, which
     * is the whole point of a goal you have not met yet.
     */
    public fun lapTimeDomain(values: List<Int>, goal: Int? = null): Domain? {
        if (values.isEmpty()) return null
        var low = values.min().toDouble()
        var high = values.max().toDouble()
        if (goal != null) {
            low = min(low, goal.toDouble())
            high = max(high, goal.toDouble())
        }
        val pad = max((high - low) * Y_PAD_FRACTION, Y_PAD_FLOOR_MS)
        return Domain(low - pad, high + pad)
    }

    /**
     * The x domain, widened when every point shares one x.
     *
     * A single event at a track is the common case for a new track page, and
     * without the widen it divides by zero.
     */
    public fun xDomain(values: List<Double>): Domain? {
        if (values.isEmpty()) return null
        val low = values.min()
        val high = values.max()
        return if (low == high) Domain(low - 1, high + 1) else Domain(low, high)
    }

    /**
     * Where a lap time sits in the plot, as a fraction **from the top**: 0 is
     * the top edge, 1 the bottom.
     *
     * This is the inversion, and it is the whole convention in one expression.
     * The largest (slowest) value maps to 0 and the smallest (fastest) to 1, so
     * faster laps sit lower and a season of improvement trends downward. Compose
     * canvases have y growing downward like SVG, so a caller multiplies this by
     * the plot height and adds the top inset — it must **not** be inverted a
     * second time.
     */
    public fun plottedFraction(value: Double, domain: Domain): Double {
        val span = domain.span
        if (span == 0.0) return 0.5
        return (domain.high - value) / span
    }

    /** The same mapping for an x value: 0 at the left edge, 1 at the right. */
    public fun horizontalFraction(value: Double, domain: Domain): Double {
        val span = domain.span
        if (span == 0.0) return 0.5
        return (value - domain.low) / span
    }

    /**
     * Where a speed sits on the trackmap's slow→fast ramp, 0..1.
     *
     * A constant-speed trace has no ramp to sit on, so it takes the middle —
     * `trackmap.js`'s choice. (iOS returns 1 for that case; see the class note.)
     */
    public fun speedFraction(speed: Double, slowest: Double, fastest: Double): Double =
        if (fastest > slowest) (speed - slowest) / (fastest - slowest) else 0.5

    /** The speed extremes of a stored trace, or null when it carries none. */
    public fun speedRange(samples: List<TraceSample>): Pair<Double, Double>? {
        if (samples.isEmpty()) return null
        return samples.minOf { it.v } to samples.maxOf { it.v }
    }

    /**
     * How many points are worth drawing. Comfortably more than the pixels across
     * any phone, so the polyline is pixel-identical to the full trace.
     */
    public const val MAX_DISPLAY_POINTS: Int = 1500

    /**
     * Stride a trace down to something drawable.
     *
     * A stored lap trace is already capped at [GeoTrace.LAP_TRACE_MAX_POINTS],
     * but the line picker draws the *raw* recording, and a 30-minute session at
     * 10 Hz is 20,000 fixes. Striding to [MAX_DISPLAY_POINTS] leaves the drawn
     * line unchanged at phone resolutions.
     *
     * **What the measurement actually said**, since it is easy to assume the
     * opposite: drawing all 20,000 points was *not* slow. A long polyline is one
     * `drawPath` call, and the emulator held a 16 ms median either way; striding
     * only tightened the tail (90th percentile 40 ms → 32 ms) and cut the
     * per-frame allocation. What genuinely costs is the **number of draw
     * calls** — the trackmap's per-segment speed ramp profiled at 600 ms a frame
     * before it was batched into colour bands. Point count is cheap; draw calls
     * are not.
     *
     * Hit-testing deliberately still runs against the **full** trace: the
     * start/finish pick has to land on an exact fix, and at racing speed one
     * stride is a few hundred metres of track.
     *
     * The final point is always kept, matching `GeoTrace.lapTrace` — a polyline
     * that stops short of where the lap ended looks like a dropout.
     */
    public fun downsampleForDisplay(
        trace: List<TracePoint>,
        max: Int = MAX_DISPLAY_POINTS,
    ): List<TracePoint> {
        if (trace.size <= max || max < 2) return trace
        val step = kotlin.math.max(1, ceil(trace.size.toDouble() / max).toInt())
        val out = ArrayList<TracePoint>(trace.size / step + 2)
        var i = 0
        while (i < trace.size) {
            out.add(trace[i])
            i += step
        }
        val lastIdx = trace.size - 1
        if (lastIdx % step != 0) out.add(trace[lastIdx])
        return out
    }
}
