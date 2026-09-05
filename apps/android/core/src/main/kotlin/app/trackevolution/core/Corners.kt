package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import kotlin.math.abs
import kotlin.math.ceil
import kotlinx.serialization.Serializable

/**
 * Corner segmentation (#189) — the port of `public/js/corners.js`.
 *
 * Same function and constant names as the JS original so the two diff by eye,
 * that file's test cases come with it ([CornersTest]), and the output is pinned
 * against the web implementation by `contracts/logic/corners.json`.
 *
 * [Sectors] cuts a lap by *distance* — three equal slices of the driven length
 * — which is the right cut for "where did the time go" and the wrong one for
 * "what was the car doing in the corner": a sector boundary lands mid-corner as
 * often as not. This cuts by *lateral load* instead: a corner is a stretch of
 * grid points where the stored `|latG|` stays at or above [CORNER_MIN_G],
 * merged across a short dip (a chicane's flick between two apexes is one
 * corner, not two) and dropped when too short to be anything but a kerb strike.
 * It is the primitive [Balance] hangs off, and it is its own file because
 * anything per-corner — entry speed, minimum speed, brake release — segments
 * the same way.
 *
 * Corners are numbered from the start/finish line in distance order and
 * labelled T1…Tn. Those are the app's numbers at this threshold, not the
 * circuit's official turn numbers: a fast kink may or may not clear
 * [CORNER_MIN_G], and a double apex may count once or twice. Every surface that
 * shows one says as much.
 *
 * [sessionCorners] segments where *most* laps agree they were cornering rather
 * than any one lap's mask, so the corner list is one list for the session — the
 * same T4 on every lap, whichever laps are highlighted — and a lap that took a
 * corner a little wider still lands in the same window. The grid is what makes
 * that legitimate: laps are aligned by driven distance from the start/finish
 * line, so the same k is the same place on track to within the line taken. The
 * quorum is what stops that alignment's slack from chaining neighbouring
 * corners together; see [Corners.CORNER_LAP_QUORUM].
 */
public object Corners {
    /**
     * Sustained `|latG|` at or above this is a corner. Display semantics, not
     * physics — like `Limits.WHEELSPIN_PCT` and `Grip.MIN_LOAD_G`, tune against
     * real footage. 0.35 G is well above the noise on a straight and well below
     * the lightest real corner on a road-tyred car.
     */
    public const val CORNER_MIN_G: Double = 0.35

    /**
     * Two cornering runs separated by at most this many below-threshold grid
     * points are one corner: a chicane or a double apex, not two corners.
     * 2 points = 40 m at the 20 m grid.
     */
    public const val CORNER_MERGE_GAP_POINTS: Int = 2

    /**
     * A run shorter than this is a kerb strike or a bump, not a corner.
     * 3 points = 60 m at the 20 m grid.
     */
    public const val MIN_CORNER_POINTS: Int = 3

    /**
     * The share of readable laps that must be cornering at a grid point for
     * [sessionCorners] to call it one — see the note there for why a union is
     * the wrong combiner. Half is the mildest rule that removes the
     * one-wide-lap smear: a corner every lap takes survives however scruffy one
     * lap was, and a place only one lap loaded (a tank-slapper, a spin, an off)
     * no longer widens the session's window. Below two laps it degrades to "any
     * lap", which is the only answer available.
     */
    public const val CORNER_LAP_QUORUM: Double = 0.5

    /**
     * How many of [lapCount] laps must agree. At least one, so a single-lap
     * session still segments.
     */
    public fun lapQuorum(lapCount: Int, quorum: Double = CORNER_LAP_QUORUM): Int =
        maxOf(1, ceil(lapCount * quorum).toInt())

    /** True when the lap stored the channel this file reads. */
    public fun hasCornerData(entry: LapChannels?): Boolean = entry?.latG != null

    /**
     * The cornering mask of one lap: true at every grid point where `|latG|` is
     * at or above [minG]. A magnitude stored with a sign is still a magnitude —
     * `pdr.js` stores `abs(lateral acceleration)`, and a negative would be a
     * source bug, not a left-hander.
     */
    public fun cornerMask(latG: List<Double>?, minG: Double = CORNER_MIN_G): List<Boolean> =
        latG?.map { abs(it) >= minG } ?: emptyList()

    /**
     * A mask reduced to corners: inclusive runs, merged across gaps of at most
     * [mergeGap] clear points, runs shorter than [minPoints] dropped.
     */
    public fun cornersFromMask(
        mask: List<Boolean>,
        mergeGap: Int = CORNER_MERGE_GAP_POINTS,
        minPoints: Int = MIN_CORNER_POINTS,
    ): List<Limits.Run> = Limits.booleanRuns(mask, mergeGap).filter { it.k1 - it.k0 + 1 >= minPoints }

    /**
     * One corner, numbered from the start/finish line. [peakG] is the highest
     * `|latG|` seen inside the window and [peakK] where; [laps] is how many laps
     * cleared the threshold somewhere inside it, and stays 0 on a single lap's
     * corners, which have no session to count over.
     */
    @Serializable
    public data class Corner(
        val n: Int,
        val k0: Int,
        val k1: Int,
        val peakG: Double,
        val peakK: Int,
        val laps: Int = 0,
    )

    /**
     * One lap's corners, numbered from the start/finish line. Empty without a
     * `latG` channel.
     */
    public fun lapCorners(
        entry: LapChannels?,
        minG: Double = CORNER_MIN_G,
        mergeGap: Int = CORNER_MERGE_GAP_POINTS,
        minPoints: Int = MIN_CORNER_POINTS,
    ): List<Corner> {
        val latG = entry?.latG ?: return emptyList()
        return cornersFromMask(cornerMask(latG, minG), mergeGap, minPoints).mapIndexed { i, r ->
            val (peakG, peakK) = peakIn(latG, r)
            Corner(n = i + 1, k0 = r.k0, k1 = r.k1, peakG = peakG, peakK = peakK)
        }
    }

    private fun peakIn(latG: List<Double>, run: Limits.Run): Pair<Double, Int> {
        var peakG = 0.0
        var peakK = run.k0
        var k = run.k0
        while (k <= run.k1 && k < latG.size) {
            val g = abs(latG[k])
            if (g > peakG) {
                peakG = g
                peakK = k
            }
            k++
        }
        return peakG to peakK
    }

    /**
     * The session's corners on the shared grid: where at least [quorum] of the
     * readable laps agree they were cornering — see the file's documentation.
     * Empty when no lap stored `latG`.
     *
     * A quorum and not a union, which is what this used to take. Laps are
     * aligned by driven distance, but they differ in length by a percent or two
     * (line choice, GPS drift), so OR-ing the masks widened every corner by the
     * spread of the whole session. Once widened, neighbours fell inside
     * [mergeGap] of one another and *chained*: on a 7-lap VIR session the
     * Climbing Esses, the Snake and South Bend fused into one 1,200 m "corner",
     * and the session reported six corners where every individual lap segmented
     * eight to eleven. Requiring most laps to agree keeps the window at the
     * corner rather than at its envelope, and leaves [mergeGap] free to do the
     * job it is for. Genuinely continuous complexes stay single: VIR's esses
     * hold load for 780 m on every lap and still read as one.
     */
    public fun sessionCorners(
        channels: SessionChannels?,
        minG: Double = CORNER_MIN_G,
        mergeGap: Int = CORNER_MERGE_GAP_POINTS,
        minPoints: Int = MIN_CORNER_POINTS,
        quorum: Double = CORNER_LAP_QUORUM,
    ): List<Corner> {
        val laps = (channels?.laps ?: emptyList()).filter { it.latG != null }
        if (laps.isEmpty()) return emptyList()
        val n = laps.maxOf { it.latG!!.size }
        val masks = laps.map { cornerMask(it.latG, minG) }
        val votes = IntArray(n)
        for (m in masks) for (k in m.indices) if (m[k]) votes[k]++
        val need = lapQuorum(laps.size, quorum)
        val agreed = votes.map { it >= need }
        return cornersFromMask(agreed, mergeGap, minPoints).mapIndexed { i, r ->
            var peakG = 0.0
            var peakK = r.k0
            var count = 0
            laps.forEachIndexed { li, lap ->
                val (g, k) = peakIn(lap.latG!!, r)
                if (g > peakG) {
                    peakG = g
                    peakK = k
                }
                val m = masks[li]
                for (kk in r.k0..r.k1) {
                    if (kk < m.size && m[kk]) {
                        count++
                        break
                    }
                }
            }
            Corner(n = i + 1, k0 = r.k0, k1 = r.k1, peakG = peakG, peakK = peakK, laps = count)
        }
    }

    /** The corner containing grid point [k], or null on a straight. */
    public fun cornerAt(corners: List<Corner>, k: Int): Corner? =
        corners.firstOrNull { k >= it.k0 && k <= it.k1 }

    /**
     * The label a corner is shown under. The app's numbering, not the circuit's
     * — see the file's documentation.
     */
    public fun cornerLabel(c: Corner): String = "T${c.n}"
}
