package app.trackevolution.core.telemetry

import app.trackevolution.core.GeoTrace
import app.trackevolution.core.GpsPoint
import app.trackevolution.core.JsMath
import app.trackevolution.core.TracePoint
import app.trackevolution.core.model.ChannelMeta
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels

/**
 * Per-lap channel data for imported telemetry sessions: each lap's speed (and,
 * for PDR, RPM, lateral G, throttle, brake and steering angle) resampled onto a
 * uniform driven-distance grid, so laps overlay corner-for-corner in the
 * channel graphs regardless of lap time.
 *
 * A port of `public/js/import/channels.js` — same function names, same
 * constants — with its test cases (`test/unit/channels.test.js` →
 * `LapChannelsTest`). Built at import time because telemetry files never leave
 * the device, so anything to graph later has to be derived here and stored
 * with the session.
 *
 * The stored shape is [SessionChannels], validated server-side by
 * `sanitizeChannels` in `src/lib/validate.ts` — keep the two in sync. NS-24
 * already draws this; without it a clip imported on the phone would yield a
 * visibly poorer session than the same clip imported at a desk.
 */
public object TelemetryChannels {

    /** Grid spacing: ~100–600 points for real laps. */
    public const val D_STEP_M: Double = 20.0
    /** Guards degenerate "laps" (also capped server-side). */
    public const val MAX_LAP_POINTS: Int = 700
    /**
     * Mirror `sanitizeChannels`' budget (`src/lib/validate.ts`): rather than have
     * the server reject a whole session over its optional graph data, an
     * outsized session (marathon enduro) simply stores no channels.
     */
    public const val MAX_LAPS: Int = 80
    public const val MAX_TOTAL_VALUES: Int = 120_000

    /**
     * Every gridded channel a lap entry can carry, with its rounding factor
     * (decimal places worth keeping in the stored JSON).
     *
     * Order is load-bearing twice over. It is the stored/render order, so the
     * six original channels keep their positions and an existing session's
     * graphs are unchanged. And it is *priority* order: when a session overruns
     * [MAX_TOTAL_VALUES] the tail is dropped until it fits, so a driver loses
     * boost before losing speed. Anything new is appended, never inserted.
     */
    public val CHANNEL_NAMES: List<Pair<String, Double>> = listOf(
        "speed" to 10.0,
        "rpm" to 1.0,
        "latG" to 1000.0,
        "throttle" to 10.0,
        "brake" to 10.0,
        "steering" to 10.0,
        "longG" to 1000.0,
        "yaw" to 10.0,
        "gear" to 1.0,
        "wheelSlip" to 10.0,
        "boost" to 10.0,
        "flags" to 1.0,
    )

    /**
     * Two of those are states, not measurements, and the default sampler — the
     * interpolated value at the grid point — is wrong for both. `flags` is a
     * bitfield at ~45 Hz whose events are narrower than the 20 m spacing, so it
     * is sampled as the OR of everything in the window (which is `max` for
     * independent bits). `gear` is an enum at ~6.6 Hz; interpolating 3 and 4
     * yields 3.5, a gear no car has, so the last value at or before the point is
     * held.
     */
    public val WINDOW_MAX: List<String> = listOf("flags")
    public val STEP_HOLD: List<String> = listOf("gear")

    /** How a slow channel is reduced to one number per lap. */
    public enum class Reduce {
        /** Largest value inside the lap's own window. */
        MAX,

        /** Smallest value inside the lap's own window. */
        MIN,

        /**
         * The value as the lap finished — what you want for a tyre pressure or a
         * fuel level, and not what you want for an oil temperature.
         */
        END,
    }

    /**
     * Slow channels (0.5–1.4 Hz) reduced to one value per lap, with how to
     * reduce them and the rounding factor. `SCALAR_NAMES` in the JS.
     */
    public val SCALAR_NAMES: List<Triple<String, Reduce, Double>> = listOf(
        Triple("oilC", Reduce.MAX, 10.0),
        Triple("oilKpa", Reduce.MIN, 1.0),
        Triple("coolantC", Reduce.MAX, 10.0),
        Triple("transC", Reduce.MAX, 10.0),
        Triple("fuelPct", Reduce.END, 10.0),
        Triple("battV", Reduce.MIN, 10.0),
        Triple("tyreKpaLF", Reduce.END, 1.0),
        Triple("tyreKpaRF", Reduce.END, 1.0),
        Triple("tyreKpaLR", Reduce.END, 1.0),
        Triple("tyreKpaRR", Reduce.END, 1.0),
        Triple("tyreCLF", Reduce.MAX, 10.0),
        Triple("tyreCRF", Reduce.MAX, 10.0),
        Triple("tyreCLR", Reduce.MAX, 10.0),
        Triple("tyreCRR", Reduce.MAX, 10.0),
    )

    /** Session-level numbers, carried through to the stored blob's `meta`. */
    public val META_NAMES: List<Pair<String, Double>> = listOf(
        "ambientC" to 10.0,
        "intakeC" to 10.0,
        "elevationM" to 1.0,
        "odometerKm" to 1.0,
    )

    /** Index of the last sample at or before [t], or -1. [arr] is sorted by t. */
    internal fun holdIndex(arr: List<ChannelPoint>, t: Double): Int {
        var lo = 0
        var hi = arr.size - 1
        var best = -1
        while (lo <= hi) {
            val m = (lo + hi) ushr 1
            if (arr[m].t <= t) {
                best = m
                lo = m + 1
            } else {
                hi = m - 1
            }
        }
        return best
    }

    /**
     * Last value at or before [t] (the first sample's value before the series
     * starts) — the sampler for enum channels.
     */
    internal fun holdAt(arr: List<ChannelPoint>, t: Double): Double {
        val i = holdIndex(arr, t)
        return arr[if (i < 0) 0 else i].v
    }

    /**
     * Largest value in [t0, t1], falling back to the held value when the window
     * contains no sample — the sampler for flag channels.
     */
    internal fun maxIn(arr: List<ChannelPoint>, t0: Double, t1: Double): Double {
        var m = Double.NEGATIVE_INFINITY
        var i = Math.max(0, holdIndex(arr, t0))
        while (i < arr.size && arr[i].t <= t1) {
            if (arr[i].t >= t0 && arr[i].v > m) m = arr[i].v
            i++
        }
        return if (m == Double.NEGATIVE_INFINITY) holdAt(arr, t1) else m
    }

    /**
     * Where a lap's channel arrays are cut from: cumulative distance, plus
     * whichever value channels the source recorded.
     */
    public data class ChannelData(
        /** `[{t, v: metres}]` cumulative. */
        val dist: List<ChannelPoint>,
        /**
         * Speed km/h, latG/longG in G, throttle/brake/wheelSlip in %,
         * steering/yaw in degrees, boost in kPa, gear 0–8, flags a bitfield.
         */
        val series: ParsedTelemetry.CarChannels,
        /** The slow series, keyed by [SCALAR_NAMES]. */
        val scalars: Map<String, List<ChannelPoint>> = emptyMap(),
        /** Session-level numbers, stored as the blob's `meta`. */
        val meta: ParsedTelemetry.SessionMeta? = null,
    )

    /** Cumulative driven distance from a projected trace ([GeoTrace.projectTrace]). */
    public fun distFromTrace(projected: List<TracePoint>): List<ChannelPoint> {
        val out = ArrayList<ChannelPoint>(projected.size)
        var d = 0.0
        for (i in projected.indices) {
            if (i > 0) d += Math.hypot(projected[i].x - projected[i - 1].x, projected[i].y - projected[i - 1].y)
            out.add(ChannelPoint(t = projected[i].t, v = d))
        }
        return out
    }

    /**
     * Channel sources for a GPS-only import (GoPro, a beacon-less PDR via the
     * line picker, a phone recording): distance integrated from the projected
     * trace, speed from the source's own fixes (m/s) when present.
     */
    public fun traceChannelData(gps: List<GpsPoint>, projected: List<TracePoint>): ChannelData {
        val withV = gps.filter { it.v?.isFinite() == true }
        return ChannelData(
            dist = distFromTrace(projected),
            series = ParsedTelemetry.CarChannels(
                speed = if (withV.size >= gps.size * 0.8) withV.map { ChannelPoint(t = it.t, v = (it.v ?: 0.0) * 3.6) } else null,
            ),
        )
    }

    /**
     * Channel sources for any parsed import: PDR uses its odometer + car
     * channels (works with or without GPS, falling back to GPS distance when a
     * file lacks the odometer); everything else needs a GPS trace.
     */
    public fun channelDataFor(parsed: ParsedTelemetry): ChannelData? {
        fun fromTrace(): ChannelData? {
            val gps = parsed.gps ?: return null
            if (gps.size < 10) return null
            return traceChannelData(gps, GeoTrace.projectTrace(gps))
        }
        if (parsed.kind != ParsedTelemetry.Kind.PDR) return fromTrace()
        val car = parsed.carChannels
        val scalars = parsed.lapScalarChannels.filterValues { it.isNotEmpty() }
        val meta = parsed.sessionMeta
        val odo = parsed.channels?.odoPts
        if (odo != null && odo.size >= 10) {
            return ChannelData(dist = odo, series = car, scalars = scalars, meta = meta)
        }
        val base = fromTrace() ?: return null
        // `{...base.series, ...car}`: a present car channel wins, an absent one
        // leaves the trace-derived value in place.
        var merged = base.series
        for ((name, _) in CHANNEL_NAMES) car[name]?.let { merged = merged.with(name, it) }
        return ChannelData(dist = base.dist, series = merged, scalars = scalars, meta = meta)
    }

    /**
     * Compute and attach `lapChannels` to a parsed import. Called after parsing
     * and again whenever laps change (line pick, batch anchoring). Laps without
     * `startT`/`endT` windows contribute nothing.
     */
    public fun attachLapChannels(parsed: ParsedTelemetry): ParsedTelemetry {
        val data = if (parsed.laps.isEmpty()) null else channelDataFor(parsed)
        return parsed.copy(
            lapChannels = data?.let {
                buildLapChannels(parsed.laps, it.dist, it.series, D_STEP_M, it.scalars, it.meta)
            },
        )
    }

    /**
     * Cut per-lap channel arrays on the distance grid.
     *
     * Laps without a `startT`/`endT` window (hand-entered times) are skipped;
     * returns null when nothing survives, so callers can store the absence as-is.
     *   - [laps]: the parsed laps
     *   - [dist]: `[{t, v: metres}]` cumulative, on the same clock as the series
     *   - [chans]: the [CHANNEL_NAMES] channels in display units
     *   - [scalars]: the [SCALAR_NAMES] series, reduced to one value per lap
     *   - [meta]: session-level numbers, stored as the blob's `meta`
     */
    public fun buildLapChannels(
        laps: List<ParsedLap>,
        dist: List<ChannelPoint>,
        chans: ParsedTelemetry.CarChannels,
        dStepM: Double = D_STEP_M,
        scalars: Map<String, List<ChannelPoint>> = emptyMap(),
        meta: ParsedTelemetry.SessionMeta? = null,
    ): SessionChannels? {
        if (laps.isEmpty() || dist.size < 10) return null
        val distS = series(dist)
        // Names, order and rounding factors are the JS's CHANNEL_NAMES. Each
        // channel keeps its own sampler: interpolated by default, held for
        // enums, OR-ed across the window for flags.
        val chanS = CHANNEL_NAMES.mapNotNull { (name, f) ->
            val pts = chans[name]
            if (pts == null || pts.size < 10) return@mapNotNull null
            val s = series(pts)
            val sample: (Double, Double) -> Double = when {
                WINDOW_MAX.contains(name) -> { t, tNext -> maxIn(pts, t, tNext) }
                STEP_HOLD.contains(name) -> { t, _ -> holdAt(pts, t) }
                else -> { t, _ -> s.at(t) }
            }
            Chan(name = name, f = f, first = s.first, last = s.last, sample = sample)
        }
        val scalarS = SCALAR_NAMES.mapNotNull { (name, reduce, f) ->
            val pts = scalars[name]
            if (pts == null || pts.size < 2) null else Scalar(name, pts, reduce, f, series(pts))
        }

        val out = ArrayList<LapChannels>()
        for (i in laps.indices) {
            val lap = laps[i]
            val startT = lap.startT ?: continue
            val endT = lap.endT ?: continue
            if (endT <= startT) continue
            val d0 = distS.at(startT)
            val d1 = distS.at(endT)
            // `Math.floor` on a NaN is NaN in JS and every comparison against it
            // is false; here a degenerate window is dropped rather than turned
            // into empty arrays the server would refuse.
            val steps = Math.floor((d1 - d0) / dStepM)
            if (!steps.isFinite() || steps < 0 || steps >= MAX_LAP_POINTS) continue
            val n = steps.toInt() + 1
            if (n < 10 || n > MAX_LAP_POINTS) continue
            // Grid points as times, computed once and shared by every channel;
            // the last point's window closes at the lap's end.
            val ts = DoubleArray(n) { k -> distS.timeAt(d0 + k * dStepM) }
            fun tNext(k: Int): Double = if (k + 1 < n) ts[k + 1] else endT
            var entry = LapChannels(n = lap.lapNumber ?: (i + 1), timeMs = lap.timeMs)
            var any = false
            for (c in chanS) {
                if (startT < c.first.t - 5 || endT > c.last.t + 5) continue
                entry = entry.withChannel(
                    c.name,
                    List(n) { k -> JsMath.round(c.sample(ts[k], tNext(k)), c.f) },
                )
                any = true
            }
            // synthesized speed (from the distance slope) fills in when no source
            // speed channel exists — the graph is too useful to drop for that
            if (entry.speed == null) {
                entry = entry.copy(
                    speed = List(n) { k -> JsMath.round(Math.max(0.0, distS.rate(ts[k])) * 3.6, 10.0) },
                )
                any = true
            }
            for (c in scalarS) {
                val v = reduceScalar(c, startT, endT)
                if (v != null) entry = entry.withScalar(c.name, JsMath.round(v, c.f))
            }
            if (any) out.add(entry)
        }
        if (out.isEmpty() || out.size > MAX_LAPS) return null
        if (!trimToBudget(out)) return null
        return SessionChannels(v = 1, dStepM = dStepM, laps = out, meta = cleanMeta(meta))
    }

    private data class Chan(
        val name: String,
        val f: Double,
        val first: ChannelPoint,
        val last: ChannelPoint,
        val sample: (Double, Double) -> Double,
    )

    private data class Scalar(
        val name: String,
        val pts: List<ChannelPoint>,
        val reduce: Reduce,
        val f: Double,
        val s: Series,
    )

    /**
     * One number for one lap, by the channel's own rule. MAX/MIN run over the
     * samples inside the lap; a lap short enough to contain none of them (a
     * 0.5 Hz channel and a very fast lap) falls back to the interpolated value
     * at the finish, which is also what END always uses.
     */
    private fun reduceScalar(c: Scalar, startT: Double, endT: Double): Double? {
        if (c.reduce != Reduce.END) {
            var best: Double? = null
            var i = Math.max(0, holdIndex(c.pts, startT))
            while (i < c.pts.size && c.pts[i].t <= endT) {
                val p = c.pts[i]
                i++
                if (p.t < startT) continue
                if (best == null || (if (c.reduce == Reduce.MAX) p.v > best!! else p.v < best!!)) {
                    best = p.v
                }
            }
            if (best != null) return best
        }
        if (endT < c.s.first.t - 5 || startT > c.s.last.t + 5) return null
        return c.s.at(endT)
    }

    /**
     * Bring a session under [MAX_TOTAL_VALUES] by dropping whole channels from
     * the tail of [CHANNEL_NAMES] — the lowest-priority ones — rather than
     * storing nothing at all. Returns false only when even speed alone doesn't
     * fit, which is the marathon-enduro case the cap exists for. Mutates [out].
     */
    private fun trimToBudget(out: MutableList<LapChannels>): Boolean {
        fun total(): Int = out.sumOf { e -> CHANNEL_NAMES.sumOf { e.channel(it.first)?.size ?: 0 } }
        var i = CHANNEL_NAMES.size - 1
        while (i > 0 && total() > MAX_TOTAL_VALUES) {
            val name = CHANNEL_NAMES[i].first
            for (j in out.indices) out[j] = out[j].withChannel(name, null)
            i--
        }
        return total() <= MAX_TOTAL_VALUES
    }

    /**
     * Session numbers, rounded, with absent ones left out entirely; null when
     * the source had none, so the stored blob simply carries no `meta`.
     */
    private fun cleanMeta(meta: ParsedTelemetry.SessionMeta?): ChannelMeta? {
        if (meta == null) return null
        val source = ChannelMeta(
            ambientC = meta.ambientC,
            intakeC = meta.intakeC,
            elevationM = meta.elevationM,
            odometerKm = meta.odometerKm,
        )
        var out = ChannelMeta()
        for ((name, f) in META_NAMES) {
            val v = source[name]
            if (v != null && v.isFinite()) out = out.with(name, JsMath.round(v, f))
        }
        return if (out.isEmpty) null else out
    }
}
