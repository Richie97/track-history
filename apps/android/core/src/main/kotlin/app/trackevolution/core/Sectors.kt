package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import kotlinx.serialization.Serializable
import kotlin.math.floor
import kotlin.math.min

/**
 * Sector analysis and the theoretical best lap (#146) — the port of
 * `public/js/sectors.js`.
 *
 * Same function names, same rules, and that file's test cases come with it
 * (`SectorsTest`), pinned against the web implementation's output by
 * `contracts/logic/sectors.json`.
 *
 * Every stored channel lap carries a speed series on a driven-distance grid,
 * which is enough to split it into sectors without the driver defining any:
 * each lap is cut into `n` equal slices of *its own* driven distance and the
 * time in each slice is read off the lap's elapsed-time series
 * ([ChannelGraphs.lapTimeSeries], scaled to the timed lap). Fractions of the
 * lap's own length rather than absolute metres, deliberately — laps differ by
 * a percent or two in driven distance, so fractions keep the same corner in
 * the same sector and make every lap's sectors add up to exactly its lap
 * time. The best of each sector across a session sums to the theoretical best
 * lap; the gap to the actual best is what consistency would have been worth.
 */
public object Sectors {

    /** Thirds by default. `SECTOR_COUNT` in the JS. */
    public const val SECTOR_COUNT: Int = 3

    /**
     * Sector split times, integer milliseconds: [n] equal slices of the lap's
     * own driven distance. The first `n − 1` sectors are rounded and the last
     * absorbs the residual so the splits sum exactly to the lap time. Null when
     * there is no speed series, too few grid points to place a boundary, or
     * `n < 1`.
     *
     * [timeMs] is nullable only for parity with the JS, whose entries may in
     * theory lack a duration; a stored [LapChannels] always has one — see the
     * overload.
     */
    public fun sectorTimes(speed: List<Double>?, timeMs: Int?, dStepM: Double, n: Int = SECTOR_COUNT): List<Int>? {
        if (speed == null || speed.size < 2 || n < 1) return null
        val t = ChannelGraphs.lapTimeSeries(speed, dStepM, timeMs)
        val last = speed.size - 1
        val lapMs = timeMs ?: jsRound(t[last] * 1000)
        // Elapsed seconds at a fractional grid position, linearly interpolated.
        fun tAt(p: Double): Double {
            val i = min(last - 1, floor(p).toInt())
            return t[i] + (t[i + 1] - t[i]) * (p - i)
        }
        val out = IntArray(n)
        var acc = 0
        for (k in 0 until n - 1) {
            val a = tAt((k * last).toDouble() / n)
            val b = tAt(((k + 1) * last).toDouble() / n)
            val ms = jsRound((b - a) * 1000)
            out[k] = ms
            acc += ms
        }
        out[n - 1] = lapMs - acc
        return out.toList()
    }

    /** [sectorTimes] for a stored channel-lap entry. */
    public fun sectorTimes(entry: LapChannels, dStepM: Double, n: Int = SECTOR_COUNT): List<Int>? =
        sectorTimes(entry.speed, entry.timeMs, dStepM, n)

    /** One lap's splits. [chIdx] indexes `SessionChannels.laps`, as in the JS. */
    @Serializable
    public data class LapSplit(
        val chIdx: Int,
        val timeMs: Int,
        val sectors: List<Int>,
    )

    /**
     * A session's sector analysis: every lap that could be split, the best of
     * each sector across them and what those sum to. `bestSectorLap[k]` is the
     * `chIdx` owning sector k's best — the earliest lap on a tie, matching the
     * JS's strict `<`. [gapMs] is the actual best lap minus the theoretical best.
     */
    @Serializable
    public data class SessionSplits(
        val n: Int,
        val laps: List<LapSplit>,
        val bestSectors: List<Int>,
        val bestSectorLap: List<Int>,
        val theoreticalBestMs: Int,
        val bestLapMs: Int,
        val bestLapIdx: Int,
        val gapMs: Int,
    )

    /**
     * Every lap of a session (or an aligned pair from [CompareLaps.alignLapPair]
     * — same shape) split into sectors. Laps without a usable speed series are
     * left out; null when no lap can be split.
     */
    public fun sessionSectors(channels: SessionChannels, n: Int = SECTOR_COUNT): SessionSplits? {
        val laps = channels.laps.mapIndexedNotNull { chIdx, entry ->
            sectorTimes(entry, channels.dStepM, n)?.let { LapSplit(chIdx, it.sum(), it) }
        }
        if (laps.isEmpty()) return null
        val bestSectors = IntArray(n)
        val bestSectorLap = IntArray(n)
        for (k in 0 until n) {
            var best = laps[0]
            for (lap in laps) if (lap.sectors[k] < best.sectors[k]) best = lap
            bestSectors[k] = best.sectors[k]
            bestSectorLap[k] = best.chIdx
        }
        var bestLap = laps[0]
        for (lap in laps) if (lap.timeMs < bestLap.timeMs) bestLap = lap
        val theoreticalBestMs = bestSectors.sum()
        return SessionSplits(
            n = n,
            laps = laps,
            bestSectors = bestSectors.toList(),
            bestSectorLap = bestSectorLap.toList(),
            theoreticalBestMs = theoreticalBestMs,
            bestLapMs = bestLap.timeMs,
            bestLapIdx = bestLap.chIdx,
            gapMs = bestLap.timeMs - theoreticalBestMs,
        )
    }

    /** JavaScript's `Math.round`: half rounds up (toward +∞). */
    private fun jsRound(value: Double): Int = floor(value + 0.5).toInt()
}
