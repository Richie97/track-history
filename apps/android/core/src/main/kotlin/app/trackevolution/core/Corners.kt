package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import kotlin.math.abs
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
 * grid points where the stored `|latG|` stays at or above [CORNER_MIN_G] *in
 * one direction*, merged across a short dip (a double apex is one corner, not
 * two) and dropped when too short to be anything but a kerb strike. It is the
 * primitive [Balance] hangs off, and it is its own file because anything
 * per-corner — entry speed, minimum speed, brake release — segments the same
 * way.
 *
 * Direction is the point. `latG` is stored as a magnitude, and through a
 * left-right transition a magnitude dips for a grid point or two and comes
 * straight back — so read alone it fuses linked corners: at VIR the whole
 * Climbing Esses were one "corner", Roller Coaster through Hog Pen another,
 * nine in a lap of eighteen. The sign comes from a channel that has one — yaw,
 * else steering ([lateralSigns]) — and a change of direction always ends a
 * corner, whatever the gap. A lap with neither channel (a GPS-only import) has
 * no direction to read and segments by magnitude alone, as every lap did
 * before.
 *
 * Corners are numbered from the start/finish line in distance order and
 * labelled T1…Tn. Those are the app's numbers at this threshold, not the
 * circuit's official turn numbers: a fast kink may or may not clear
 * [CORNER_MIN_G], two apexes in the same direction count once, and a bend the
 * start/finish line cuts through is counted on both sides of it. Every surface
 * that shows one says as much.
 *
 * [sessionCorners] segments every lap together on the shared distance grid
 * rather than any one lap's, so the corner list is one list for the session —
 * the same T4 on every lap, whichever laps are highlighted — and a lap that
 * took a corner a little wider still lands in the same window. A grid point is
 * cornering when *any* lap is loaded there, in the direction most of the loaded
 * laps agree on. The grid is what makes that legitimate: laps are aligned by
 * driven distance from the start/finish line, so the same k is the same place
 * on track to within the line taken.
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
     * Two cornering runs *in the same direction* separated by at most this many
     * below-threshold grid points are one corner: a double apex, not two
     * corners. 2 points = 40 m at the 20 m grid.
     */
    public const val CORNER_MERGE_GAP_POINTS: Int = 2

    /**
     * A run shorter than this is a kerb strike or a bump, not a corner.
     * 3 points = 60 m at the 20 m grid.
     */
    public const val MIN_CORNER_POINTS: Int = 3

    /** True when the lap stored the channel this file reads. */
    public fun hasCornerData(entry: LapChannels?): Boolean = entry?.latG != null

    /**
     * Which way the car is turning at each grid point of one lap: 1 or -1, from
     * yaw, else steering; null when the lap stored neither. Which of the two is
     * "left" is the recorder's business and nothing here depends on it — only
     * on the sign changing when the direction does.
     */
    public fun lateralSigns(entry: LapChannels?): List<Int>? {
        val latG = entry?.latG ?: return null
        val src = entry.yaw ?: entry.steering ?: return null
        return latG.indices.map { k -> if (k < src.size && src[k] < 0) -1 else 1 }
    }

    /**
     * The cornering direction at each grid point: 0 below [minG], else the sign
     * from [signs] — or 1 throughout without it, which is the magnitude-only
     * reading. A magnitude stored with a sign is still a magnitude — `pdr.js`
     * stores `abs(lateral acceleration)`, so `latG`'s own sign is never a
     * direction.
     */
    public fun cornerDirs(
        latG: List<Double>?,
        signs: List<Int>? = null,
        minG: Double = CORNER_MIN_G,
    ): List<Int> =
        latG?.mapIndexed { k, g -> if (abs(g) >= minG) signs?.getOrNull(k) ?: 1 else 0 } ?: emptyList()

    /**
     * Directions reduced to corners: inclusive runs. A run is a stretch of one
     * non-zero direction; two runs merge across a gap of at most [mergeGap]
     * clear points only when they turn the same way, and runs shorter than
     * [minPoints] are dropped.
     */
    public fun cornersFromDirs(
        dirs: List<Int>,
        mergeGap: Int = CORNER_MERGE_GAP_POINTS,
        minPoints: Int = MIN_CORNER_POINTS,
    ): List<Limits.Run> {
        // Parallel lists: each run's direction, start and end.
        val runDirs = ArrayList<Int>()
        val k0s = ArrayList<Int>()
        val k1s = ArrayList<Int>()
        for (k in dirs.indices) {
            val dir = dirs[k]
            if (dir == 0) continue
            // The last run is the last of either direction, so an opposite run
            // in between has already taken its place and nothing merges across
            // it.
            val last = runDirs.size - 1
            if (last >= 0 && runDirs[last] == dir && k - k1s[last] - 1 <= mergeGap) {
                k1s[last] = k
            } else {
                runDirs.add(dir)
                k0s.add(k)
                k1s.add(k)
            }
        }
        return k0s.indices
            .filter { k1s[it] - k0s[it] + 1 >= minPoints }
            .map { Limits.Run(k0s[it], k1s[it]) }
    }

    /**
     * One corner, numbered from the start/finish line. [peakG] is the highest
     * `|latG|` seen inside the window and [peakK] where; [laps] is how many laps
     * were loaded in the corner's direction somewhere inside it, and stays 0 on
     * a single lap's corners, which have no session to count over.
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
        return cornersFromDirs(cornerDirs(latG, lateralSigns(entry), minG), mergeGap, minPoints)
            .mapIndexed { i, r ->
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
     * Every lap's cornering directions in one convention. Two laps of one
     * session share a recorder, but a comparison can put laps from two
     * recorders on one grid and their yaw need not agree on which way is
     * positive — so each lap is checked against the first wherever both are
     * loaded, and flipped when it disagrees more than it agrees. Measured, not
     * assumed, as [Balance] does for steering against yaw. When any lap has no
     * direction at all, none is used: half a session cut by direction and half
     * not would be two corner lists laid over each other.
     *
     * Laps without `latG` contribute an empty list.
     */
    public fun sessionDirs(laps: List<LapChannels>, minG: Double = CORNER_MIN_G): List<List<Int>> {
        val signs = laps.map { lateralSigns(it) }
        if (signs.any { it == null }) return laps.map { cornerDirs(it.latG, null, minG) }
        val dirs = laps.mapIndexed { i, l -> cornerDirs(l.latG, signs[i], minG) }
        val ref = dirs.firstOrNull() ?: return dirs
        return dirs.mapIndexed { i, d ->
            if (i == 0) return@mapIndexed d
            var agree = 0
            var k = 0
            while (k < d.size && k < ref.size) {
                agree += d[k] * ref[k]
                k++
            }
            if (agree < 0) d.map { -it } else d
        }
    }

    /**
     * The session's corners on the shared grid, from every lap's directions
     * together — a point is cornering when any lap is loaded there, in the
     * direction more of the loaded laps turn (on a tie, the earliest loaded
     * lap's). See the file's documentation. Empty when no lap stored `latG`.
     */
    public fun sessionCorners(
        channels: SessionChannels?,
        minG: Double = CORNER_MIN_G,
        mergeGap: Int = CORNER_MERGE_GAP_POINTS,
        minPoints: Int = MIN_CORNER_POINTS,
    ): List<Corner> {
        val laps = (channels?.laps ?: emptyList()).filter { it.latG != null }
        if (laps.isEmpty()) return emptyList()
        val n = laps.maxOf { it.latG!!.size }
        val dirs = sessionDirs(laps, minG)
        val voted = List(n) { k ->
            var sum = 0
            var first = 0
            for (d in dirs) {
                val v = d.getOrElse(k) { 0 }
                sum += v
                if (first == 0) first = v
            }
            if (sum > 0) 1 else if (sum < 0) -1 else first
        }
        return cornersFromDirs(voted, mergeGap, minPoints).mapIndexed { i, r ->
            val dir = voted[r.k0]
            var peakG = 0.0
            var peakK = r.k0
            var count = 0
            laps.forEachIndexed { li, lap ->
                val (g, k) = peakIn(lap.latG!!, r)
                if (g > peakG) {
                    peakG = g
                    peakK = k
                }
                val d = dirs[li]
                for (kk in r.k0..r.k1) {
                    if (kk < d.size && d[kk] == dir) {
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
