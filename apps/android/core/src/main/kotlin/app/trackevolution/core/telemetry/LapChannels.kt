package app.trackevolution.core.telemetry

import app.trackevolution.core.GeoTrace
import app.trackevolution.core.GpsPoint
import app.trackevolution.core.JsMath
import app.trackevolution.core.TracePoint
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
     * Every channel a lap entry can carry, with its rounding factor (decimal
     * places worth keeping in the stored JSON). Order is the stored/render order.
     */
    public val CHANNEL_NAMES: List<Pair<String, Double>> = listOf(
        "speed" to 10.0,
        "rpm" to 1.0,
        "latG" to 1000.0,
        "throttle" to 10.0,
        "brake" to 10.0,
        "steering" to 10.0,
    )

    /**
     * Where a lap's channel arrays are cut from: cumulative distance, plus
     * whichever value channels the source recorded.
     */
    public data class ChannelData(
        /** `[{t, v: metres}]` cumulative. */
        val dist: List<ChannelPoint>,
        /** Speed km/h, latG in G, throttle/brake in %, steering in degrees. */
        val series: ParsedTelemetry.CarChannels,
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
        val odo = parsed.channels?.odoPts
        if (odo != null && odo.size >= 10) return ChannelData(dist = odo, series = car)
        val base = fromTrace() ?: return null
        // `{...base.series, ...car}`: a present car channel wins, an absent one
        // leaves the trace-derived value in place.
        return ChannelData(
            dist = base.dist,
            series = ParsedTelemetry.CarChannels(
                speed = car.speed ?: base.series.speed,
                rpm = car.rpm ?: base.series.rpm,
                latG = car.latG ?: base.series.latG,
                throttle = car.throttle ?: base.series.throttle,
                brake = car.brake ?: base.series.brake,
                steering = car.steering ?: base.series.steering,
            ),
        )
    }

    /**
     * Compute and attach `lapChannels` to a parsed import. Called after parsing
     * and again whenever laps change (line pick, batch anchoring). Laps without
     * `startT`/`endT` windows contribute nothing.
     */
    public fun attachLapChannels(parsed: ParsedTelemetry): ParsedTelemetry {
        val data = if (parsed.laps.isEmpty()) null else channelDataFor(parsed)
        return parsed.copy(lapChannels = data?.let { buildLapChannels(parsed.laps, it.dist, it.series) })
    }

    /**
     * Cut per-lap channel arrays on the distance grid.
     *
     * Laps without a `startT`/`endT` window (hand-entered times) are skipped;
     * returns null when nothing survives, so callers can store the absence as-is.
     *   - [laps]: the parsed laps
     *   - [dist]: `[{t, v: metres}]` cumulative, on the same clock as the series
     *   - [chans]: speed km/h, latG in G, throttle/brake %, steering deg
     */
    public fun buildLapChannels(
        laps: List<ParsedLap>,
        dist: List<ChannelPoint>,
        chans: ParsedTelemetry.CarChannels,
        dStepM: Double = D_STEP_M,
    ): SessionChannels? {
        if (laps.isEmpty() || dist.size < 10) return null
        val distS = series(dist)
        // Names, order and rounding factors are the JS's CHANNEL_NAMES.
        val named = CHANNEL_NAMES.mapNotNull { (name, f) ->
            val pts = chans[name]
            if (pts != null && pts.size >= 10) Triple(name, pts, f) else null
        }
        val chanS = named.map { (name, pts, f) -> Triple(name, series(pts), f) }

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
            val values = HashMap<String, List<Double>>()
            var any = false
            for ((name, s, f) in chanS) {
                val t0 = s.first.t
                val t1 = s.last.t
                if (startT < t0 - 5 || endT > t1 + 5) continue
                values[name] = List(n) { k -> JsMath.round(s.at(distS.timeAt(d0 + k * dStepM)), f) }
                any = true
            }
            // synthesized speed (from the distance slope) fills in when no source
            // speed channel exists — the graph is too useful to drop for that
            if (values["speed"] == null) {
                values["speed"] = List(n) { k ->
                    JsMath.round(Math.max(0.0, distS.rate(distS.timeAt(d0 + k * dStepM))) * 3.6, 10.0)
                }
                any = true
            }
            if (any) {
                out.add(
                    LapChannels(
                        n = lap.lapNumber ?: (i + 1),
                        timeMs = lap.timeMs,
                        speed = values["speed"],
                        rpm = values["rpm"],
                        latG = values["latG"],
                        throttle = values["throttle"],
                        brake = values["brake"],
                        steering = values["steering"],
                    ),
                )
            }
        }
        if (out.isEmpty() || out.size > MAX_LAPS) return null
        val totalValues = out.sumOf { e ->
            (e.speed?.size ?: 0) + (e.rpm?.size ?: 0) + (e.latG?.size ?: 0) +
                (e.throttle?.size ?: 0) + (e.brake?.size ?: 0) + (e.steering?.size ?: 0)
        }
        return if (totalValues <= MAX_TOTAL_VALUES) SessionChannels(v = 1, dStepM = dStepM, laps = out) else null
    }
}
