package app.trackevolution.core

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot

/**
 * Live lap timing for the in-app GPS recorder: lap counts, lap times and a
 * predictive delta while the car is still on track — before the review
 * screen's line picker has ever run.
 *
 * A direct port of `public/js/record/live-timing.js`. **Function names,
 * constant names and constant values are deliberately identical to the
 * JavaScript original** so the implementations diff by eye, and every derived
 * value is pinned against the web implementation by
 * `contracts/logic/live-timing.json` — a gate anchored one fix later, or a
 * delta interpolated differently, shows the driver a different number at
 * 130 mph. Fix a genuine bug in the JavaScript first.
 *
 * The recorder doesn't know the start/finish line during a session, so live
 * timing anchors its own gate at the first fix at track pace — in practice
 * the pit exit, which is on the racing line, so the car re-crosses it every
 * lap. Times shown live are therefore "unofficial": the saved laps still come
 * from the review line pick.
 *
 * Feed every fix the recording *accepted* ([Recording.addFix] returned true),
 * in order. Recovery after a process death is a replay:
 * [liveTimingFromFixes].
 */
public class LiveTiming {

    public companion object {
        /** Track pace: the gate anchors at the first fix at/above this (m/s). */
        public const val ARM_MPS: Double = 15.0

        /** Gate half-width in meters, same as the review line picker's default. */
        public const val GATE_HALF_WIDTH_M: Double = 20.0

        /** Same lap-plausibility window as `lapsFromCrossings`. */
        public const val MIN_LAP_S: Double = 30.0
        public const val MAX_LAP_S: Double = 3600.0

        /** Crossings closer than this are GPS jitter, as in `gateCrossings`. */
        public const val MIN_CROSS_GAP_S: Double = 5.0

        /** The anchor fix must be at least this far (m) from the previous fix. */
        public const val MIN_HEADING_M: Double = 2.0

        /** Replay a whole recording's fix list — same result as feeding one at a time. */
        public fun liveTimingFromFixes(fixes: List<Fix>): LiveTiming {
            val lt = LiveTiming()
            for (f in fixes) lt.addTimingFix(f)
            return lt
        }
    }

    /** The anchored timing gate, in the session's local meter frame. */
    public data class Gate(
        val hx: Double,
        val hy: Double,
        val x1: Double,
        val y1: Double,
        val x2: Double,
        val y2: Double,
    )

    private data class Origin(val lat: Double, val lon: Double, val kx: Double, val ky: Double)

    private data class Projected(val t: Double, val x: Double, val y: Double)

    /** The running lap's samples: cumulative meters + seconds since lap start. */
    private class LapSamples {
        val dist = ArrayList<Double>()
        val time = ArrayList<Double>()
        var d: Double = 0.0
    }

    private var origin: Origin? = null
    private var prev: Projected? = null
    private var lastCrossT: Double? = null
    private var lapStartT: Double? = null
    private var best: LapSamples? = null
    private var cur: LapSamples? = null

    public var gate: Gate? = null
        private set

    /** Completed, plausible laps. */
    public var lapCount: Int = 0
        private set

    public var lastLapMs: Int? = null
        private set

    public var bestLapMs: Int? = null
        private set

    /** Current predictive delta in seconds (positive = slower), or null. */
    public var deltaS: Double? = null
        private set

    private fun project(f: Fix): Projected {
        val o = origin ?: Origin(
            lat = f.lat,
            lon = f.lon,
            kx = 111320.0 * cos(f.lat * PI / 180.0),
            ky = 110540.0,
        ).also { origin = it }
        return Projected(t = f.t, x = (f.lon - o.lon) * o.kx, y = (f.lat - o.lat) * o.ky)
    }

    /**
     * Where (in time) the segment a→b crosses the gate, or null. Direction-
     * filtered by the gate heading — the same rule as `gateCrossings`.
     */
    private fun crossingT(gate: Gate, a: Projected, b: Projected): Double? {
        val dx = b.x - a.x
        val dy = b.y - a.y
        if (dx * gate.hx + dy * gate.hy <= 0) return null
        val gx = gate.x2 - gate.x1
        val gy = gate.y2 - gate.y1
        val denom = dx * gy - dy * gx
        if (denom == 0.0) return null
        val wx = gate.x1 - a.x
        val wy = gate.y1 - a.y
        val s = (wx * gy - wy * gx) / denom
        val u = (wx * dy - wy * dx) / denom
        if (s < 0 || s > 1 || u < 0 || u > 1) return null
        return a.t + s * (b.t - a.t)
    }

    /** Time at `d` meters into the best lap, linearly interpolated; null outside its range. */
    private fun bestTimeAt(best: LapSamples, d: Double): Double? {
        val dist = best.dist
        val time = best.time
        if (dist.isEmpty() || d < dist[0] || d > dist[dist.size - 1]) return null
        var lo = 0
        var hi = dist.size - 1
        while (hi - lo > 1) {
            val mid = (lo + hi) / 2
            if (dist[mid] <= d) lo = mid else hi = mid
        }
        val span = dist[hi] - dist[lo]
        val f = if (span > 0) (d - dist[lo]) / span else 0.0
        return time[lo] + f * (time[hi] - time[lo])
    }

    /** Feed one accepted fix. Call in fix order — `addFix` drops out-of-order fixes. */
    public fun addTimingFix(f: Fix) {
        val p = project(f)
        val prevP = prev
        prev = p
        if (prevP == null) return

        // Anchor the gate at the first track-pace fix with a usable heading.
        val g = gate
        if (g == null) {
            val v = f.speed
            if (v != null && v >= ARM_MPS) {
                val hx = p.x - prevP.x
                val hy = p.y - prevP.y
                val len = hypot(hx, hy)
                if (len >= MIN_HEADING_M) {
                    val ux = hx / len
                    val uy = hy / len
                    gate = Gate(
                        hx = ux,
                        hy = uy,
                        x1 = p.x + uy * GATE_HALF_WIDTH_M,
                        y1 = p.y - ux * GATE_HALF_WIDTH_M,
                        x2 = p.x - uy * GATE_HALF_WIDTH_M,
                        y2 = p.y + ux * GATE_HALF_WIDTH_M,
                    )
                    // Timing starts here, explicitly: the anchor fix sits exactly
                    // on the gate, so whether the next segment registers a
                    // crossing would be floating-point luck otherwise. Lap 1 is
                    // the out lap from this point around to it again.
                    lastCrossT = p.t
                    lapStartT = p.t
                    cur = LapSamples()
                }
            }
            return
        }

        // Advance the running lap by this segment.
        val c = cur
        val startT = lapStartT
        if (c != null && startT != null) {
            c.d += hypot(p.x - prevP.x, p.y - prevP.y)
            c.dist.add(c.d)
            c.time.add(p.t - startT)
            val b = best
            deltaS = if (b != null) bestTimeAt(b, c.d)?.let { (p.t - startT) - it } else null
        }

        val tc = crossingT(g, prevP, p) ?: return
        val lastT = lastCrossT
        if (lastT != null && tc - lastT < MIN_CROSS_GAP_S) return
        lastCrossT = tc

        if (startT != null) {
            val lapS = tc - startT
            if (lapS >= MIN_LAP_S && lapS <= MAX_LAP_S) {
                lapCount += 1
                val lapMs = JsMath.roundToInt(lapS * 1000)
                lastLapMs = lapMs
                if (bestLapMs == null || lapMs < bestLapMs!!) {
                    bestLapMs = lapMs
                    best = c
                }
            }
            // Out of the plausible window (a pit stop, a red flag): not a lap,
            // but the crossing still starts a fresh one.
        }
        lapStartT = tc
        cur = LapSamples()
        deltaS = null
    }

    /** What a record screen shows. [nowS] is the recording clock (same axis as fix `t`). */
    public fun liveTimingDisplay(nowS: Double): LiveTimingDisplay = LiveTimingDisplay(
        lapCount = lapCount,
        currentLapS = lapStartT?.let { maxOf(0.0, nowS - it) },
        lastLapMs = lastLapMs,
        bestLapMs = bestLapMs,
        deltaS = deltaS,
    )
}

/** The record screen's live-timing readout. Null [currentLapS] = not yet at track pace. */
public data class LiveTimingDisplay(
    val lapCount: Int,
    val currentLapS: Double?,
    val lastLapMs: Int?,
    val bestLapMs: Int?,
    val deltaS: Double?,
)
