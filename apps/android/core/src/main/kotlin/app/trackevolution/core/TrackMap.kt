package app.trackevolution.core

import app.trackevolution.core.model.TracePoint
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * The stored racing line, as a place you can point at.
 *
 * The port of `public/js/trackmap.js`'s pure half, under the same name. The
 * drawing is per platform — `TrackMap` in `:app`'s charts, `TrackMapView` on iOS
 * — and this is the one piece of it that is a *fact* rather than a rendering:
 * given a fraction of the way round a lap, which stored trace point is that?
 *
 * It exists because of the friction circle and the balance scatter. Both hand
 * over a sample as a fraction of the lap, and the answer to "which corner is this
 * dot" is a point on the map (NS-34 ticket 3).
 *
 * Not to be confused with [TraceMap] next to it, which is the *line picker's*
 * geometry — fit, hit-test and the y-flip that keeps north up. This is the racing
 * line's own arc-length, and nothing else.
 */
object TrackMap {

    /**
     * The index of the trace point [frac] of the way round the lap, by
     * **cumulative chord length**.
     *
     * Walking the *index* instead would be wrong by whole corners on any real
     * lap: a trace is denser where the car was slower, so a quarter of the
     * samples is nowhere near a quarter of the distance.
     * `contracts/logic/trackmap.json` pins exactly that difference.
     *
     * [frac] is clamped to 0..1. Null — rather than 0 — when there is nothing to
     * point at: fewer than two points, or a trace that never moved. A caller that
     * got 0 for a stationary trace would ring the start line and imply the dot
     * belonged there.
     */
    fun traceIndexAtFraction(points: List<TracePoint>, frac: Double): Int? {
        if (points.size < 2) return null
        val cum = DoubleArray(points.size)
        for (i in 1 until points.size) {
            cum[i] = cum[i - 1] + hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
        }
        val total = cum[points.size - 1]
        if (total <= 0.0) return null
        val target = max(0.0, min(1.0, frac)) * total
        var idx = 0
        while (idx < points.size - 1 && cum[idx] < target) idx++
        return idx
    }
}
