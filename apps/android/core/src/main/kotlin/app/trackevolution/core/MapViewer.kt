package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.TraceGeo
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.model.TracePoint as StoredTracePoint

/**
 * The racing line on a real map (NS-53 ticket 3): the pure half of Android's
 * map viewer — the port of `public/js/map-viewer.js`' exported helpers under
 * the same names, with its test cases (`MapViewerTest`).
 *
 * What the viewer offers ([viewerPlan]) and the sentences that explain a
 * missing map are the web's word for word, so the three clients say the same
 * thing. The map itself is `:app`'s (Google Maps), behind a seam that keeps the
 * line drawable whenever the map is not.
 */
public object MapViewer {

    /** The three ways to show the line. `MAP_TYPES` in the JS. */
    public enum class MapType(public val key: String, public val label: String) {
        SATELLITE("satellite", "Satellite"),
        STANDARD("standard", "Map"),
        LINE("line", "Line");

        public companion object {
            public fun of(key: String?): MapType? = entries.firstOrNull { it.key == key }
        }
    }

    public val MAP_TYPES: List<MapType> = MapType.entries.toList()
    public val DEFAULT_MAP_TYPE: MapType = MapType.SATELLITE

    /** How close a tap has to land to the line to read it, in screen points (dp here). */
    public const val TAP_RADIUS_PX: Int = 24
    public const val SPEED_BUCKETS: Int = 16
    public const val FIT_PADDING_PX: Int = 48

    public const val NOTE_NO_ANCHOR: String =
        "This session was saved before its position was kept, so there is no map to lay it on yet. " +
            "Import or record another session at this track and it will borrow that one's place."
    public const val NOTE_NOT_SET_UP: String = "Map imagery isn't available here, so this is the line on its own."
    public const val NOTE_OFFLINE: String = "Map imagery needs a connection."
    public const val NOTE_APPROX: String = "Position estimated from another session here."

    /** What the viewer can offer: the types that work and the sentence that explains a missing one. */
    public data class Plan(val types: List<MapType>, val note: String?)

    /**
     * [mapsOn] is "this build can draw a map at all" (Play Services and a key on
     * Android, a key on the deployment on the web); [loadFailed] is the map not
     * arriving — offline, or refused. No anchor is the reason that stands,
     * whatever else is also true.
     */
    public fun viewerPlan(geo: TraceGeo?, mapsOn: Boolean, loadFailed: Boolean = false): Plan = when {
        geo == null -> Plan(listOf(MapType.LINE), NOTE_NO_ANCHOR)
        !mapsOn -> Plan(listOf(MapType.LINE), NOTE_NOT_SET_UP)
        loadFailed -> Plan(listOf(MapType.LINE), NOTE_OFFLINE)
        else -> Plan(MAP_TYPES, if (geo.approx == true) NOTE_APPROX else null)
    }

    /** The type to open on: the remembered one when the plan still offers it. */
    public fun startType(plan: Plan, remembered: MapType?): MapType =
        if (remembered != null && remembered in plan.types) remembered else plan.types.first()

    /**
     * A speed bucket's colour on the `--map-slow` → `--map-fast` ramp, at the
     * bucket's midpoint, as the drawn track map colours a segment. Colours are
     * `0xRRGGBB` (alpha ignored); the answer is opaque `0xFFRRGGBB`. The JS
     * answers `rgb(r,g,b)` with the same three numbers.
     */
    public fun rampColor(bucket: Int, buckets: Int, slow: Int, fast: Int): Int {
        val t = (bucket + 0.5) / buckets
        fun ch(shift: Int): Int {
            val s = (slow shr shift) and 0xFF
            val f = (fast shr shift) and 0xFF
            return JsMath.roundToInt(s + (f - s) * t)
        }
        return (0xFF shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
    }

    /** A coordinate back into the trace's metres — [GeoTrace.projectTrace] for one point. */
    public fun traceMetres(lat: Double, lon: Double, geo: TraceGeo): Point =
        Point(x = (lon - geo.lon) * GeoTrace.KX(geo.lat), y = (lat - geo.lat) * GeoTrace.KY)

    /** The direction of travel at a trace point, degrees clockwise from north. */
    public fun headingDeg(trace: List<StoredTracePoint>, idx: Int): Double {
        val a = trace[Math.max(0, idx - 1)]
        val b = trace[Math.min(trace.size - 1, idx + 1)]
        return (Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360
    }

    /**
     * A tap at ([lat], [lon]) with the map showing [metresPerPx]: the place on
     * the line it reads, or null when it landed too far off it.
     */
    public fun tapHit(
        trace: List<StoredTracePoint>,
        geo: TraceGeo,
        lat: Double,
        lon: Double,
        metresPerPx: Double,
    ): TraceHit? {
        val p = traceMetres(lat, lon, geo)
        return GeoTrace.nearestOnTrace(trace, p.x, p.y, TAP_RADIUS_PX * metresPerPx)
    }

    /** What a tap reads: speed in stored km/h (null without a channel entry) and driven metres. */
    public data class Place(val kph: Double?, val distM: Double)

    /**
     * The lap's own channel reading at a fraction of its distance. The trace's
     * third value is not used — its unit depends on the source — so with no
     * channel entry the read-out is the distance along the drawn line alone.
     */
    public fun placeAt(hit: TraceHit, entry: LapChannels?, dStepM: Double?): Place {
        val speed = entry?.speed
        if (speed == null || speed.size < 2 || dStepM == null || !(dStepM > 0)) {
            return Place(kph = null, distM = hit.alongM)
        }
        val k = hit.frac * (speed.size - 1)
        val i = Math.min(speed.size - 2, Math.floor(k).toInt())
        val f = k - i
        return Place(kph = speed[i] + (speed[i + 1] - speed[i]) * f, distM = k * dStepM)
    }

    /** "142 mph · 1.2 km", or the distance alone. */
    public fun readoutText(place: Place, units: UnitSystem): String {
        val dist = Units.fmtDist(Math.round(place.distM).toDouble(), units)
        return place.kph?.let { "${Units.fmtSpeedKph(it, units)} · $dist" } ?: dist
    }

    /** The point [alongM] metres down the line, in the trace's metres. */
    public fun pointAlong(trace: List<StoredTracePoint>, alongM: Double): Point {
        var cum = 0.0
        for (i in 0 until trace.size - 1) {
            val len = Math.hypot(trace[i + 1].x - trace[i].x, trace[i + 1].y - trace[i].y)
            if (cum + len >= alongM && len > 0) {
                val t = (alongM - cum) / len
                return Point(
                    x = trace[i].x + (trace[i + 1].x - trace[i].x) * t,
                    y = trace[i].y + (trace[i + 1].y - trace[i].y) * t,
                )
            }
            cum += len
        }
        val last = trace.last()
        return Point(last.x, last.y)
    }

    /**
     * The hit [steps] × 5 % of the lap from [from] — the "Next point / Previous
     * point" accessibility actions. Starts at the line when nothing is selected
     * and clamps at both ends.
     */
    public fun stepHit(trace: List<StoredTracePoint>, from: TraceHit?, steps: Int): TraceHit? {
        if (trace.size < 2) return null
        var total = 0.0
        for (i in 0 until trace.size - 1) total += Math.hypot(trace[i + 1].x - trace[i].x, trace[i + 1].y - trace[i].y)
        if (!(total > 0)) return null
        val frac = Math.max(0.0, Math.min(1.0, (from?.frac ?: 0.0) + steps * STEP_FRACTION))
        val p = pointAlong(trace, frac * total)
        return GeoTrace.nearestOnTrace(trace, p.x, p.y)?.copy(frac = frac, alongM = frac * total, offM = 0.0)
    }

    public const val STEP_FRACTION: Double = 0.05
}
