package app.trackevolution.core

import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The non-drawing half of `public/js/channel-graphs.js` (NS-24).
 *
 * Every lap of an imported session overlaid on one driven-distance axis, up to
 * three highlighted at a time and the rest a dim envelope. This object owns the
 * matching, the selection rules and the axis domains; the Compose layer owns
 * the paths.
 *
 * Names follow the JS so the two diff by eye — [matchLapsToChannels] most of
 * all, since it is the piece pinned by `contracts/logic/channels.json`.
 */
public object ChannelGraphs {

    /** Highlight slots. Three, because a fourth line stops being readable. */
    public const val SLOT_COUNT: Int = 3

    private const val KPH_TO_MPH = 0.621371

    /**
     * The channels a session can carry, in display order — `CHANNEL_DEFS` in
     * the JS, same order (speed, throttle, brake, steering, rpm, lateral G).
     *
     * [floorAtZero] is not cosmetic: lateral G, throttle and brake floor their
     * axis at zero so an idle pedal reads as idle and left/right G compare,
     * while speed and RPM would waste half the plot doing the same. Steering
     * is signed and pads both sides, like the JS's `floor0: false`.
     */
    public enum class Channel(
        public val key: String,
        public val label: String,
        public val unit: String,
        public val decimals: Int,
        public val floorAtZero: Boolean,
    ) {
        SPEED("speed", "Speed", "mph", 0, false),
        THROTTLE("throttle", "Throttle", "%", 0, true),
        BRAKE("brake", "Brake", "%", 0, true),
        STEERING("steering", "Steering", "°", 0, false),
        RPM("rpm", "RPM", "rpm", 0, false),
        LAT_G("latG", "Lateral G", "G", 2, true),
        ;

        /** Stored speed is kph; the app reads mph, as the web does. */
        public fun convert(raw: Double): Double = if (this == SPEED) raw * KPH_TO_MPH else raw

        /** This channel's series for one lap, or null when the lap lacks it. */
        public fun series(of: LapChannels): List<Double>? = when (this) {
            SPEED -> of.speed
            THROTTLE -> of.throttle
            BRAKE -> of.brake
            STEERING -> of.steering
            RPM -> of.rpm
            LAT_G -> of.latG
        }
    }

    /**
     * A session lap paired with its channel entry.
     *
     * [chIdx] is `-1` when the lap has no channel data — a lap with no distance
     * window at import, or one hand-added later. That sentinel is part of the
     * pinned contract, so it stays an index rather than becoming a nullable.
     */
    public data class LapMatch(val lap: Lap, val chIdx: Int) {
        public val hasChannels: Boolean get() = chIdx >= 0
    }

    /**
     * Pair the session's stored lap rows to the channel entries.
     *
     * Both come from the same parsed laps at import, so an **in-order greedy
     * match on the exact millisecond** is enough — and the in-order part is
     * load-bearing rather than an optimisation: two laps can share a time to
     * the millisecond, and a search that rewound would hand them both the same
     * channel entry. `j` never goes backwards.
     */
    public fun matchLapsToChannels(sessionLaps: List<Lap>, chLaps: List<LapChannels>): List<LapMatch> {
        var j = 0
        return sessionLaps.map { lap ->
            val k = (j until chLaps.size).firstOrNull { chLaps[it].timeMs == lap.timeMs }
            if (k == null) {
                LapMatch(lap, -1)
            } else {
                j = k + 1
                LapMatch(lap, k)
            }
        }
    }

    /** The channels some lap in this session actually carries, in display order. */
    public fun presentChannels(channels: SessionChannels): List<Channel> =
        Channel.entries.filter { ch -> channels.laps.any { ch.series(it) != null } }

    /**
     * What starts highlighted: the fastest lap that has channel data.
     *
     * Deliberately not simply the fastest lap — the session's best may have no
     * channels, and opening on an empty chart would look broken. Ties keep the
     * earlier lap, matching the JS's strict `<`.
     */
    public fun initialSelection(matches: List<LapMatch>): List<Int> {
        val best = matches.filter { it.hasChannels }.minByOrNull { it.lap.timeMs } ?: return emptyList()
        return listOf(best.chIdx)
    }

    /**
     * Toggle a lap in or out of the highlight slots.
     *
     * Past [SLOT_COUNT] the **oldest** selection is evicted rather than the tap
     * being refused: comparing a fourth lap is a normal thing to want, and a
     * dead chip would just look broken.
     */
    public fun toggle(chIdx: Int, lit: List<Int>): List<Int> {
        if (chIdx in lit) return lit - chIdx
        val next = lit + chIdx
        return if (next.size > SLOT_COUNT) next.drop(next.size - SLOT_COUNT) else next
    }

    /** Longest series across every lap carrying [channel] — the grid width. */
    public fun gridCount(channel: Channel, channels: SessionChannels): Int =
        channels.laps.mapNotNull { channel.series(it)?.size }.maxOrNull() ?: 0

    /**
     * The x extent in metres: the shared axis every lap is drawn against.
     *
     * One axis for all laps is what makes them line up corner-for-corner; a
     * lap that ran a shorter distance simply stops early.
     */
    public fun distanceSpan(channel: Channel, channels: SessionChannels): Double {
        val n = gridCount(channel, channels)
        return if (n <= 0) 0.0 else (n - 1) * channels.dStepM
    }

    /**
     * The **unpadded** min and max a channel actually reaches, converted.
     *
     * Distinct from [valueDomain] on purpose. The domain is padded so the trace
     * does not touch the frame, and that padding can push it somewhere the data
     * never goes — 8% below a speed of zero is a *negative speed*, which is fine
     * as an axis bound and nonsense as a description. Anything that reports the
     * range in words (a read-out, a screen-reader summary) wants this one.
     */
    public fun valueExtent(channel: Channel, channels: SessionChannels): Pair<Double, Double>? {
        var low = Double.POSITIVE_INFINITY
        var high = Double.NEGATIVE_INFINITY
        var seen = false
        for (lap in channels.laps) {
            val series = channel.series(lap) ?: continue
            for (raw in series) {
                val v = channel.convert(raw)
                seen = true
                if (v < low) low = v
                if (v > high) high = v
            }
        }
        return if (seen) low to high else null
    }

    /**
     * The padded y domain for a channel across every lap that carries it.
     *
     * 8% padding, and the asymmetry is the JS's: a [Channel.floorAtZero]
     * channel pads only the top, so the zero line stays exactly at zero.
     */
    public fun valueDomain(channel: Channel, channels: SessionChannels): ChartScale.Domain? {
        val (extentLow, high) = valueExtent(channel, channels) ?: return null
        var low = extentLow

        if (channel.floorAtZero) low = min(0.0, low)
        val pad = max((high - low) * 0.08, 1e-6)
        return ChartScale.Domain(
            low = if (channel.floorAtZero) low else low - pad,
            high = high + pad,
        )
    }

    /** One converted sample, or null when that lap has no such grid point. */
    public fun value(channel: Channel, lapIndex: Int, gridIndex: Int, channels: SessionChannels): Double? {
        val series = channels.laps.getOrNull(lapIndex)?.let { channel.series(it) } ?: return null
        val raw = series.getOrNull(gridIndex) ?: return null
        return channel.convert(raw)
    }

    /** The grid index nearest a driven distance — the read-out's lookup. */
    public fun gridIndex(atDistance: Double, channel: Channel, channels: SessionChannels): Int {
        if (channels.dStepM <= 0.0) return 0
        val n = gridCount(channel, channels)
        val k = (atDistance / channels.dStepM).roundToInt()
        return k.coerceIn(0, max(0, n - 1))
    }

    /** `1500` → `"1.5 km"`, `800` → `"800 m"`. */
    public fun fmtDist(metres: Double): String {
        val m = metres.roundToInt()
        if (m < 1000) return "$m m"
        val km = m / 1000.0
        // A whole number of kilometres drops the decimal, as the JS does.
        return if (m % 1000 == 0) "${km.roundToInt()} km" else "${(km * 10).roundToInt() / 10.0} km"
    }

    // ---- lap delta ----------------------------------------------------------

    /**
     * A 0 km/h sample would make its grid cell take near-forever; clamp the
     * cell average to walking pace instead. The end-scale to the timed lap
     * absorbs the error. `DELTA_MIN_KPH` in the JS.
     */
    public const val DELTA_MIN_KPH: Double = 3.0

    /**
     * Cumulative elapsed seconds at each grid point (d = 0, dStepM, 2·dStepM…)
     * from a lap's speed samples (km/h): trapezoidal dt per cell, then scaled
     * so the last point equals `timeMs / 1000` when a timed duration is given
     * — the integral alone drifts, and the timer is ground truth.
     *
     * `lapTimeSeries` in the JS, pinned by `contracts/logic/lap-delta.json`.
     */
    public fun lapTimeSeries(speedKph: List<Double>, dStepM: Double, timeMs: Int?): List<Double> {
        if (speedKph.isEmpty()) return emptyList()
        val t = DoubleArray(speedKph.size)
        for (k in 1 until speedKph.size) {
            val vAvg = max(DELTA_MIN_KPH, (speedKph[k - 1] + speedKph[k]) / 2) / 3.6 // m/s
            t[k] = t[k - 1] + dStepM / vAvg
        }
        val total = t.last()
        if (timeMs != null && total > 0) {
            val scale = timeMs / 1000.0 / total
            for (k in t.indices) t[k] = t[k] * scale
        }
        return t.toList()
    }

    /**
     * Delta seconds (lap − ref, positive = the lap is slower) at each shared
     * grid point, over the points both laps cover. Null when either lap has no
     * speed data or the overlap is too short to mean anything.
     *
     * `deltaSeries` in the JS, pinned by `contracts/logic/lap-delta.json`.
     */
    public fun deltaSeries(lap: LapChannels, ref: LapChannels, dStepM: Double): List<Double>? {
        val lapSpeed = lap.speed ?: return null
        val refSpeed = ref.speed ?: return null
        val a = lapTimeSeries(lapSpeed, dStepM, lap.timeMs)
        val b = lapTimeSeries(refSpeed, dStepM, ref.timeMs)
        val n = min(a.size, b.size)
        if (n < 10) return null
        return List(n) { a[it] - b[it] }
    }

    /**
     * The reference the delta measures against: the fastest of the highlight
     * selection. Null until two or more laps are highlighted — a delta of one
     * lap against itself says nothing.
     */
    public fun deltaReference(lit: List<Int>, channels: SessionChannels): Int? {
        if (lit.size < 2) return null
        return lit.minByOrNull { channels.laps.getOrNull(it)?.timeMs ?: Int.MAX_VALUE }
    }

    /**
     * The y window for a delta chart: always includes zero (the reference lap
     * *is* the zero line), padded by 8% of the range with the JS's 0.05 s
     * floor so a near-identical pair of laps still draws a readable band.
     */
    public fun deltaDomain(deltas: List<List<Double>>): ChartScale.Domain? {
        if (deltas.isEmpty()) return null
        var low = 0.0
        var high = 0.0
        for (series in deltas) {
            for (v in series) {
                if (v < low) low = v
                if (v > high) high = v
            }
        }
        val pad = max((high - low) * 0.08, 0.05)
        return ChartScale.Domain(low = low - pad, high = high + pad)
    }
}
