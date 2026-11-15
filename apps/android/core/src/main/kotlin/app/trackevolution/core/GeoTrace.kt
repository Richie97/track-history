package app.trackevolution.core

import app.trackevolution.core.model.TraceGeo
import app.trackevolution.core.model.TracePoint as StoredTracePoint

/**
 * GPS trace geometry: project lat/lon traces to local meters and derive lap
 * times from start/finish line crossings.
 *
 * A direct port of `public/js/import/geo.js`. **Function names, parameter names
 * and default values are deliberately identical to the JavaScript original** so
 * the three implementations can be diffed by eye — see
 * `docs/specs/native/NS-14-android-lap-geometry.md`.
 *
 * This was the first piece of the telemetry-import code ported to native, and
 * it is not really part of the import feature: [RecorderCore.toParsed] emits
 * `needsLine = true`, meaning a live recording has no lap markers and its laps
 * are timed by the user picking a start/finish line. Without this, a native
 * recording could not become laps at all. The video parsers (PDR, GoPro) followed
 * in `telemetry/` (NS-32) and time line-picked laps through this same code; the
 * `.vbo` parser deliberately stays web-only.
 *
 * Sign conventions do not matter. Everything here is relative geometry within
 * one trace, so a self-consistent source works unchanged — including Racelogic's
 * west-positive longitude. Do **not** add hemisphere "corrections"; the web
 * parser handles that at its own layer and this code is deliberately agnostic.
 */
public object GeoTrace {

    /** Half-width in meters of a gate built by [buildGate]: 20 m either side. */
    public const val GATE_HALF_WIDTH_M: Double = 20.0

    /** Crossings closer together than this are GPS jitter, not two laps. */
    public const val MIN_GAP_S: Double = 5.0

    /** Below this, a "lap" is a jitter double-count. */
    public const val MIN_LAP_S: Double = 30.0

    /** Above this, the gap is a pit stop or a session break, not a lap. */
    public const val MAX_LAP_S: Double = 3600.0

    /** Point budget for a stored lap polyline. */
    public const val LAP_TRACE_MAX_POINTS: Int = 300

    // -----------------------------------------------------------------------
    // projection
    // -----------------------------------------------------------------------

    /**
     * Projects a lat/lon trace to local meters (equirectangular — fine at track
     * scale).
     *
     * [origin] lets several traces share one coordinate frame, which is how one
     * picked start/finish line applies to a whole import batch. It defaults to
     * the first point.
     *
     * Deliberate divergence: the JavaScript throws on an empty trace (it reads
     * `points[0].lat`). Returning an empty list is strictly safer and no caller
     * depends on the throw.
     */
    public fun projectTrace(points: List<GpsPoint>, origin: GpsPoint? = null): List<TracePoint> {
        if (points.isEmpty()) return emptyList()
        val o = origin ?: points[0]
        val kx = 111_320.0 * Math.cos(o.lat * Math.PI / 180.0)
        val ky = 110_540.0
        return points.map { p ->
            TracePoint(t = p.t, x = (p.lon - o.lon) * kx, y = (p.lat - o.lat) * ky, v = p.v)
        }
    }

    // -----------------------------------------------------------------------
    // gates
    // -----------------------------------------------------------------------

    /**
     * Builds a start/finish gate from a picked point on a projected trace: a
     * segment through `trace[idx]`, perpendicular to the direction of travel
     * there.
     *
     * The heading window **widens (3 → 6 → 12 → 24 samples) until the
     * displacement across it exceeds 2 m.** That widening is what makes picking a
     * point in a slow corner work — at a tight hairpin the immediate neighbours
     * are nearly coincident and would give a meaningless heading. Returns null if
     * the widest window still finds no movement (the car was stationary at the
     * picked point).
     */
    public fun buildGate(
        trace: List<TracePoint>,
        idx: Int,
        halfWidth: Double = GATE_HALF_WIDTH_M,
    ): Gate? {
        if (idx !in trace.indices) return null
        val p = trace[idx]
        var w = 3
        while (w <= 24) {
            val a = trace[Math.max(0, idx - w)]
            val b = trace[Math.min(trace.size - 1, idx + w)]
            val hx = b.x - a.x
            val hy = b.y - a.y
            val len = Math.hypot(hx, hy)
            if (len >= 2.0) {
                val ux = hx / len
                val uy = hy / len
                // unit perpendicular
                val px = -uy
                val py = ux
                return Gate(
                    x = p.x,
                    y = p.y,
                    hx = ux,
                    hy = uy,
                    x1 = p.x - px * halfWidth,
                    y1 = p.y - py * halfWidth,
                    x2 = p.x + px * halfWidth,
                    y2 = p.y + py * halfWidth,
                )
            }
            w *= 2
        }
        return null
    }

    /**
     * A gate from two explicit endpoints (e.g. a VBO `[laptiming]` start line).
     * No heading, so crossings in **either** direction count.
     */
    public fun gateFromSegment(p1: Point, p2: Point): Gate = Gate(
        x = (p1.x + p2.x) / 2,
        y = (p1.y + p2.y) / 2,
        hx = null,
        hy = null,
        x1 = p1.x,
        y1 = p1.y,
        x2 = p2.x,
        y2 = p2.y,
    )

    // -----------------------------------------------------------------------
    // crossings and laps
    // -----------------------------------------------------------------------

    /**
     * Times (seconds, on the trace clock) at which the trace crosses the gate
     * segment.
     *
     * The crossing time is **interpolated within the trace segment that crosses**
     * (`t = a.t + s·(b.t − a.t)`), which is why GPS-derived laps are accurate to
     * roughly ±0.1–0.3 s between 10–18 Hz fixes rather than to the sample
     * interval.
     *
     * Direction-filtered when the gate has a heading, so only crossings in the
     * racing direction count; crossings closer than [minGapS] apart are jitter.
     */
    public fun gateCrossings(
        trace: List<TracePoint>,
        gate: Gate,
        minGapS: Double = MIN_GAP_S,
    ): List<Double> {
        val gx = gate.x2 - gate.x1
        val gy = gate.y2 - gate.y1
        val out = ArrayList<Double>()
        for (i in 1 until trace.size) {
            val a = trace[i - 1]
            val b = trace[i]
            val dx = b.x - a.x
            val dy = b.y - a.y
            val hx = gate.hx
            if (hx != null && dx * hx + dy * gate.hy!! <= 0.0) continue
            val denom = dx * gy - dy * gx
            if (denom == 0.0) continue
            // a + s*(b-a) intersects gate.p1 + u*(p2-p1) with s, u in [0, 1]
            val wx = gate.x1 - a.x
            val wy = gate.y1 - a.y
            val s = (wx * gy - wy * gx) / denom
            val u = (wx * dy - wy * dx) / denom
            if (s < 0.0 || s > 1.0 || u < 0.0 || u > 1.0) continue
            val t = a.t + s * (b.t - a.t)
            if (out.isNotEmpty() && t - out.last() < minGapS) continue
            out.add(t)
        }
        return out
    }

    /**
     * Laps between consecutive crossings. Deltas outside `[minLapS, maxLapS]` are
     * dropped: jitter double-counts below, pit stops and session gaps above.
     *
     * GPS-derived timing is interpolation between fixes, so every lap is flagged
     * [Lap.estimated] — the UI renders those with a `~` prefix. Do not drop the
     * flag; it is user-visible honesty about precision.
     */
    public fun lapsFromCrossings(
        crossings: List<Double>,
        minLapS: Double = MIN_LAP_S,
        maxLapS: Double = MAX_LAP_S,
    ): List<Lap> {
        val laps = ArrayList<Lap>()
        for (i in 1 until crossings.size) {
            val s = crossings[i] - crossings[i - 1]
            if (s < minLapS || s > maxLapS) continue
            laps.add(
                Lap(
                    timeMs = JsMath.roundToInt(s * 1000.0),
                    estimated = true,
                    startT = crossings[i - 1],
                    endT = crossings[i],
                )
            )
        }
        return laps
    }

    public fun deriveLaps(
        trace: List<TracePoint>,
        gate: Gate,
        minGapS: Double = MIN_GAP_S,
        minLapS: Double = MIN_LAP_S,
        maxLapS: Double = MAX_LAP_S,
    ): List<Lap> = lapsFromCrossings(gateCrossings(trace, gate, minGapS), minLapS, maxLapS)

    // -----------------------------------------------------------------------
    // best-lap trace extraction
    // -----------------------------------------------------------------------

    /**
     * Slices a projected trace to `[t0, t1]` and downsamples to at most [max]
     * points, as `[x, y, v]` triples — the speed-painted racing line stored on
     * the session row and rendered on the event page.
     *
     * Speed comes from the source when present, else from distance/time to the
     * neighbouring sample; the renderer only uses it relatively, so units do not
     * matter. Returns null when the window holds too few points to draw a line.
     */
    public fun lapTrace(
        trace: List<TracePoint>,
        t0: Double,
        t1: Double,
        max: Int = LAP_TRACE_MAX_POINTS,
    ): List<TraceSample>? {
        val pts = trace.filter { it.t >= t0 && it.t <= t1 }
        if (pts.size < 10) return null

        fun speedAt(i: Int): Double {
            val v = pts[i].v
            if (v != null && v.isFinite()) return v
            val a = pts[Math.max(0, i - 1)]
            val b = pts[Math.min(pts.size - 1, i + 1)]
            val dt = b.t - a.t
            return if (dt > 0.0) Math.hypot(b.x - a.x, b.y - a.y) / dt else 0.0
        }

        fun sample(i: Int) = TraceSample(
            x = JsMath.round(pts[i].x, 10.0),
            y = JsMath.round(pts[i].y, 10.0),
            v = JsMath.round(speedAt(i), 100.0),
        )

        val step = Math.max(1, Math.ceil(pts.size.toDouble() / max).toInt())
        val out = ArrayList<TraceSample>(pts.size / step + 2)
        var i = 0
        while (i < pts.size) {
            out.add(sample(i))
            i += step
        }
        // Always land on the final point, so the polyline reaches the gate even
        // when the stride skips past it.
        val lastIdx = pts.size - 1
        if (lastIdx % step != 0) out.add(sample(lastIdx))
        return out
    }

    /**
     * The fastest valid lap's trace, using the same gate crossings and the same
     * jitter/min/max filtering that timed the laps.
     */
    public fun bestLapTrace(
        trace: List<TracePoint>,
        gate: Gate,
        minGapS: Double = MIN_GAP_S,
        minLapS: Double = MIN_LAP_S,
        maxLapS: Double = MAX_LAP_S,
        max: Int = LAP_TRACE_MAX_POINTS,
    ): List<TraceSample>? {
        val crossings = gateCrossings(trace, gate, minGapS)
        var bestS = Double.MAX_VALUE
        var bestT0 = 0.0
        var bestT1 = 0.0
        var found = false
        for (i in 1 until crossings.size) {
            val s = crossings[i] - crossings[i - 1]
            if (s < minLapS || s > maxLapS) continue
            if (!found || s < bestS) {
                found = true
                bestS = s
                bestT0 = crossings[i - 1]
                bestT1 = crossings[i]
            }
        }
        return if (found) lapTrace(trace, bestT0, bestT1, max) else null
    }

    // -----------------------------------------------------------------------
    // where a trace lies on Earth (NS-53)
    // -----------------------------------------------------------------------
    //
    // A stored trace is local metres from the origin projectTrace was given,
    // and that origin is saved beside it as the session's `trace_geo`. These are
    // the pure half of drawing the line on a real map: the anchor a save sends,
    // the way back to degrees, and what the map viewer needs to fit, hit-test
    // and colour the line. Pinned by `contracts/logic/geo-anchor.json`, the
    // fixture the iOS Kit's `Geo` asserts against too.

    /**
     * Metres per degree of latitude — [projectTrace]'s constant. **The inverse
     * must use the same two numbers**: they are approximations, but the
     * projection is then its own exact inverse.
     */
    public const val KY: Double = 110_540.0

    /** Metres per degree of longitude at [lat] — [projectTrace]'s other constant. */
    public fun KX(lat: Double): Double = 111_320.0 * Math.cos(lat * Math.PI / 180.0)

    private fun round7(v: Double): Double = JsMath.round(v, 1e7)

    /**
     * The anchor to save with a trace: the origin its points were projected
     * from — `gps[0]` unless [projectTrace] was handed another. Null for
     * anything that isn't a real coordinate ((0, 0) is a GPS with no fix), so a
     * save sends null rather than a place the line never was.
     */
    public fun traceOrigin(gps: List<GpsPoint>?, origin: GpsPoint? = null): TraceGeo? {
        val o = origin ?: gps?.firstOrNull() ?: return null
        return traceOrigin(o.lat, o.lon)
    }

    /** [traceOrigin] for a bare coordinate. */
    public fun traceOrigin(lat: Double, lon: Double): TraceGeo? {
        if (!lat.isFinite() || !lon.isFinite()) return null
        if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return null
        if (Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01) return null
        return TraceGeo(lat = round7(lat), lon = round7(lon))
    }

    /** A stored `[x, y, v]` trace back to degrees. */
    public fun unprojectTrace(trace: List<StoredTracePoint>, geo: TraceGeo): List<GeoPoint> {
        val kx = KX(geo.lat)
        return trace.map { GeoPoint(lat = geo.lat + it.y / KY, lon = geo.lon + it.x / kx, v = it.v) }
    }

    /** The trace's bounding box in degrees — what the map's first camera fits. Null when empty. */
    public fun traceGeoBounds(trace: List<StoredTracePoint>, geo: TraceGeo): GeoBounds? {
        if (trace.isEmpty()) return null
        var x0 = Double.POSITIVE_INFINITY
        var x1 = Double.NEGATIVE_INFINITY
        var y0 = Double.POSITIVE_INFINITY
        var y1 = Double.NEGATIVE_INFINITY
        for (p in trace) {
            if (p.x < x0) x0 = p.x
            if (p.x > x1) x1 = p.x
            if (p.y < y0) y0 = p.y
            if (p.y > y1) y1 = p.y
        }
        val kx = KX(geo.lat)
        return GeoBounds(
            south = geo.lat + y0 / KY,
            west = geo.lon + x0 / kx,
            north = geo.lat + y1 / KY,
            east = geo.lon + x1 / kx,
        )
    }

    /**
     * The point on the line nearest ([x], [y]), all in the trace's metres — a
     * tap's hit test. `idx` is the nearer end of the segment hit, `alongM` the
     * driven distance to the nearest point, `frac` that as a fraction of the
     * trace's length (by cumulative chord length: a trace is denser where the
     * car was slower, so an index is not a place), `offM` how far the tap was
     * from the line. Null when nothing is within [maxM]. Ties keep the earlier
     * segment.
     */
    public fun nearestOnTrace(
        trace: List<StoredTracePoint>,
        x: Double,
        y: Double,
        maxM: Double = Double.POSITIVE_INFINITY,
    ): TraceHit? {
        if (trace.size < 2) return null
        var bestIdx = 0
        var bestAlong = 0.0
        var bestOff = Double.NaN
        var cum = 0.0
        for (i in 0 until trace.size - 1) {
            val ax = trace[i].x
            val ay = trace[i].y
            val dx = trace[i + 1].x - ax
            val dy = trace[i + 1].y - ay
            val len = Math.hypot(dx, dy)
            val t = if (len > 0) ((x - ax) * dx + (y - ay) * dy) / (len * len) else 0.0
            val tc = if (len > 0) Math.max(0.0, Math.min(1.0, t)) else 0.0
            val off = Math.hypot(x - (ax + dx * tc), y - (ay + dy * tc))
            if (bestOff.isNaN() || off < bestOff) {
                bestIdx = if (tc < 0.5) i else i + 1
                bestAlong = cum + len * tc
                bestOff = off
            }
            cum += len
        }
        if (!(cum > 0) || bestOff > maxM) return null
        return TraceHit(idx = bestIdx, frac = bestAlong / cum, alongM = bestAlong, offM = bestOff)
    }

    /**
     * The line cut into runs of one speed colour, point indexes inclusive,
     * `bucket` 0 (slowest) … `buckets − 1`. Speed is normalised over the
     * trace's own range, as the drawn track map does, and a segment takes the
     * bucket of the point it starts at. The map viewer builds its gradient spans
     * from these, so every client colours the same metres the same.
     */
    public fun speedRuns(trace: List<StoredTracePoint>, buckets: Int = 16): List<SpeedRun> {
        if (trace.size < 2) return emptyList()
        var vMin = Double.POSITIVE_INFINITY
        var vMax = Double.NEGATIVE_INFINITY
        for (p in trace) {
            if (p.v < vMin) vMin = p.v
            if (p.v > vMax) vMax = p.v
        }
        fun bucketAt(i: Int): Int {
            if (!(vMax > vMin)) return buckets / 2
            return Math.min(buckets - 1, Math.floor((trace[i].v - vMin) / (vMax - vMin) * buckets).toInt())
        }
        val runs = ArrayList<SpeedRun>()
        for (i in 0 until trace.size - 1) {
            val bucket = bucketAt(i)
            val last = runs.lastOrNull()
            if (last != null && last.bucket == bucket) runs[runs.size - 1] = last.copy(to = i + 1)
            else runs.add(SpeedRun(from = i, to = i + 1, bucket = bucket))
        }
        return runs
    }
}

/** One point of a trace back in degrees ([GeoTrace.unprojectTrace]). */
public data class GeoPoint(val lat: Double, val lon: Double, val v: Double)

/** A bounding box in degrees ([GeoTrace.traceGeoBounds]). */
public data class GeoBounds(val south: Double, val west: Double, val north: Double, val east: Double)

/** Where a tap landed on the line ([GeoTrace.nearestOnTrace]). */
public data class TraceHit(val idx: Int, val frac: Double, val alongM: Double, val offM: Double)

/** A run of one speed colour ([GeoTrace.speedRuns]); `from`/`to` are point indexes, inclusive. */
public data class SpeedRun(val from: Int, val to: Int, val bucket: Int)

/** A plain 2D point in projected meters. */
public data class Point(val x: Double, val y: Double)

/** A trace sample in projected meters. `v` is the source's speed when it had one. */
public data class TracePoint(val t: Double, val x: Double, val y: Double, val v: Double? = null)

/**
 * A start/finish line in projected meters: the segment `(x1,y1)–(x2,y2)`, with
 * `(x,y)` its midpoint (or the picked point). [hx]/[hy] is the unit direction of
 * travel when the gate was built from a trace, and null for an explicit
 * two-point gate — null means crossings count in both directions.
 */
public data class Gate(
    val x: Double,
    val y: Double,
    val hx: Double?,
    val hy: Double?,
    val x1: Double,
    val y1: Double,
    val x2: Double,
    val y2: Double,
)

/**
 * One derived lap. [timeMs] is integer milliseconds, as everywhere in this
 * codebase. [estimated] is always true for GPS-derived laps and is surfaced to
 * the user as a `~` prefix. [startT]/[endT] are on the trace clock, so per-lap
 * channel data can be cut from the same telemetry.
 */
public data class Lap(
    val timeMs: Int,
    val estimated: Boolean,
    val startT: Double,
    val endT: Double,
)

/** One point of a stored lap polyline: `[x, y, v]` in the JSON wire format. */
public data class TraceSample(val x: Double, val y: Double, val v: Double)
