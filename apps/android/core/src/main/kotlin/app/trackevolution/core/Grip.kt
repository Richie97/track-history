package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import kotlinx.serialization.Serializable
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * The friction circle (#186) — the port of `public/js/grip.js`.
 *
 * Same function and constant names as the JS original so the two diff by eye,
 * that file's test cases come with it (`GripTest`), and the output is pinned
 * against the web implementation by `contracts/logic/grip.json`.
 *
 * A PDR import stores `latG` and `longG` per lap on the driven-distance grid.
 * Neither says much alone — a longitudinal-G trace is the brake trace with
 * extra steps — but plotted against each other they draw the one picture in
 * amateur telemetry that says what to do differently rather than only where the
 * time went. The tyre has one grip budget, spent in any direction: brake in a
 * straight line, release, turn, then accelerate and the samples draw a cross;
 * trail the brake into the corner and feed the throttle out of it and they fill
 * the circle. The empty space between the two is the lost time.
 *
 * Two properties of the stored data shape everything here.
 *
 * **`latG` is a magnitude, not a signed value.** `pdr.js` stores
 * `abs(lateral acceleration)` (and `sanitizeChannels` clamps the channel at 0),
 * so left and right are indistinguishable in the blob. The side is recovered
 * from the sign of the `steering` trace at the same grid point — steering angle
 * *is* turn direction — and a lap that stored no steering plots on the
 * right-hand side alone. That is a derivation, so it is named ([latSign]),
 * one-sided output is a legitimate outcome, and the read-out never depends on
 * it: the quadrant shares use the magnitude.
 *
 * **The 20 m grid smooths peaks.** A grid point every 20 m is about 0.3 s at
 * 250 km/h, so a spike is averaged away and these figures are the *shape* of
 * grip usage rather than peak G. The peaks are the session's max lateral and
 * braking G, taken from the full-rate series at import.
 */
public object Grip {

    /**
     * Combined G below this is the car coasting, not the tyre working. It is the
     * denominator of the read-out: "of the time you were actually using the
     * tyre, how much of it was combined" is the question that trends across a
     * day, and one long straight would otherwise decide the answer.
     */
    public const val MIN_LOAD_G: Double = 0.3

    /**
     * One axis below this is not meaningfully doing that thing, so the sample is
     * not combined cornering. Display semantics, not physics — tune against real
     * footage, like [Limits.WHEELSPIN_PCT].
     */
    public const val COMBINED_MIN_G: Double = 0.2

    /**
     * The reference arc is the session's own peak combined G at this percentile,
     * not its maximum: one kerb strike should not set the envelope for the day.
     */
    public const val PEAK_PERCENTILE: Double = 0.99

    /** True when the lap stored both halves of the picture. */
    public fun hasGripData(entry: LapChannels?): Boolean =
        entry?.latG != null && entry.longG != null

    /** One plottable lap of a session, keeping its channel index. */
    public data class GripLap(val chIdx: Int, val entry: LapChannels)

    /** The laps of a session that can be plotted. */
    public fun gripLaps(channels: SessionChannels?): List<GripLap> =
        channels?.laps.orEmpty().mapIndexedNotNull { chIdx, entry ->
            if (hasGripData(entry)) GripLap(chIdx, entry) else null
        }

    /**
     * Which way the car was turning at grid point [k]: the sign of the steering
     * angle, or +1 for a lap that stored no steering (so its samples land on one
     * side rather than being dropped). The stored `latG` carries no side of its
     * own — see the class documentation.
     */
    public fun latSign(entry: LapChannels?, k: Int): Double {
        val s = entry?.steering ?: return 1.0
        if (k >= s.size) return 1.0
        return if (s[k] < 0) -1.0 else 1.0
    }

    /**
     * One scatter point: [lat] signed by [latSign], [long] signed as stored
     * (negative under braking) and [g] the combined magnitude.
     */
    @Serializable
    public data class Point(val k: Int, val lat: Double, val long: Double, val g: Double)

    /** One lap as scatter points — one per grid sample carrying both channels. */
    public fun gripPoints(entry: LapChannels?): List<Point> {
        val latG = entry?.latG ?: return emptyList()
        val longG = entry.longG ?: return emptyList()
        val n = min(latG.size, longG.size)
        return (0 until n).map { k ->
            val lat = abs(latG[k])
            val long = longG[k]
            Point(k = k, lat = lat * latSign(entry, k), long = long, g = hypot(lat, long))
        }
    }

    /**
     * How a lap (or a whole session) spent its grip budget: the share of
     * *loaded* samples that were cornering while braking and cornering while on
     * the power. A cross scores near zero on both, a filled circle scores high.
     */
    @Serializable
    public data class Shares(
        val samples: Int,
        val loaded: Int,
        val trailBrake: Int,
        val powerDown: Int,
        val trailPct: Double,
        val powerPct: Double,
    )

    /** Null when the lap has no loaded sample. */
    public fun gripShares(entry: LapChannels?): Shares? = sharesOf(gripPoints(entry))

    /**
     * The shares of an already-built point list, so a caller holding the points
     * doesn't walk the lap twice.
     */
    private fun sharesOf(pts: List<Point>): Shares? {
        var loaded = 0
        var trailBrake = 0
        var powerDown = 0
        for (p in pts) {
            if (p.g < MIN_LOAD_G) continue
            loaded++
            if (abs(p.lat) < COMBINED_MIN_G) continue
            if (p.long <= -COMBINED_MIN_G) {
                trailBrake++
            } else if (p.long >= COMBINED_MIN_G) {
                powerDown++
            }
        }
        if (loaded == 0) return null
        return Shares(
            samples = pts.size,
            loaded = loaded,
            trailBrake = trailBrake,
            powerDown = powerDown,
            trailPct = trailBrake.toDouble() / loaded * 100,
            powerPct = powerDown.toDouble() / loaded * 100,
        )
    }

    /**
     * The session's peak combined G at [pct], over every sample of every lap that
     * stored both channels — the radius of the reference arc, i.e. what this car
     * actually did today. Null when no lap can be plotted.
     */
    public fun peakCombinedG(channels: SessionChannels?, pct: Double = PEAK_PERCENTILE): Double? {
        val all = ArrayList<Double>()
        for (lap in gripLaps(channels)) for (p in gripPoints(lap.entry)) all.add(p.g)
        if (all.isEmpty()) return null
        all.sort()
        val idx = min(all.size - 1, max(0, floor(pct * (all.size - 1)).toInt()))
        return all[idx]
    }

    /** One lap's row in the read-out. */
    @Serializable
    public data class LapShares(
        val chIdx: Int,
        val samples: Int,
        val loaded: Int,
        val trailBrake: Int,
        val powerDown: Int,
        val trailPct: Double,
        val powerPct: Double,
    )

    /**
     * A session reduced for the read-out: the arc's radius, the true maximum
     * (which is *not* the arc), a row per plottable lap and every sample pooled.
     */
    @Serializable
    public data class SessionGrip(
        val peakG: Double?,
        val maxG: Double,
        val laps: List<LapShares>,
        val all: Shares,
    )

    /** Null when no lap stored both channels. */
    public fun sessionGrip(channels: SessionChannels?, pct: Double = PEAK_PERCENTILE): SessionGrip? {
        val laps = gripLaps(channels)
        if (laps.isEmpty()) return null
        val rows = ArrayList<LapShares>()
        var maxG = 0.0
        var samples = 0
        var loaded = 0
        var trailBrake = 0
        var powerDown = 0
        for (lap in laps) {
            val pts = gripPoints(lap.entry)
            for (p in pts) if (p.g > maxG) maxG = p.g
            val sh = sharesOf(pts) ?: continue
            rows.add(
                LapShares(
                    chIdx = lap.chIdx,
                    samples = sh.samples,
                    loaded = sh.loaded,
                    trailBrake = sh.trailBrake,
                    powerDown = sh.powerDown,
                    trailPct = sh.trailPct,
                    powerPct = sh.powerPct,
                ),
            )
            samples += sh.samples
            loaded += sh.loaded
            trailBrake += sh.trailBrake
            powerDown += sh.powerDown
        }
        if (rows.isEmpty()) return null
        return SessionGrip(
            peakG = peakCombinedG(channels, pct),
            maxG = maxG,
            laps = rows,
            all = Shares(
                samples = samples,
                loaded = loaded,
                trailBrake = trailBrake,
                powerDown = powerDown,
                trailPct = trailBrake.toDouble() / loaded * 100,
                powerPct = powerDown.toDouble() / loaded * 100,
            ),
        )
    }
}
