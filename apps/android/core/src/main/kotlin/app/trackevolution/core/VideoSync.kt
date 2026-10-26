package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.LapClip
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.telemetry.LapClips
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Video-synced lap analysis (NS-51, `docs/specs/native/NS-51-video-synced-laps.md`):
 * the pure half of the lap stage, the port of `public/js/video-sync.js` under
 * the same names. One driven distance — a fractional index `k` on a lap's 20 m
 * channel grid — is the playhead, and this object turns a video's clock into it
 * and back, keeps a second lap's video in step with the first, and words where
 * the car is.
 *
 * Nothing here is stored. A lap's elapsed time at each grid point is derived
 * from its speed trace by [ChannelGraphs.lapTimeSeries] (the delta chart's own
 * curve), and a clip's `lap_offset_ms` says where the lap starts inside the
 * video. [makeSide] takes the time curve as an optional argument so a stored
 * series can replace the derived one without changing a caller.
 *
 * Pinned by `contracts/logic/video-sync.json`, generated from the JS; the iOS
 * Kit's `VideoSync` asserts the same file. The Compose half is `ui/stage/`.
 */
public object VideoSync {

    /**
     * The two ways a compare keeps two videos together: [PLACE] holds both cars
     * at the same distance (the slower lap's video runs faster to keep up),
     * [TIME] at the same elapsed time from the line (one car pulls ahead). The
     * JS's strings are [key], which is also what the preference stores.
     */
    public enum class SyncMode(public val key: String) {
        PLACE("place"),
        TIME("time"),
        ;

        public companion object {
            /** A stored key back into a mode; anything unknown is [DEFAULT_SYNC_MODE]. */
            public fun fromKey(key: String?): SyncMode = entries.firstOrNull { it.key == key } ?: DEFAULT_SYNC_MODE
        }
    }

    /** `A` is the lap the view was opened for (or the first pick), `B` the reference or second pick. */
    public enum class SideKey { A, B }

    public val SYNC_MODES: List<SyncMode> = listOf(SyncMode.PLACE, SyncMode.TIME)
    public val DEFAULT_SYNC_MODE: SyncMode = SyncMode.PLACE

    /** A follower more than this far from where it should be is re-seeked. */
    public const val RESYNC_MS: Double = 150.0

    /** The follower's playback rate in [SyncMode.PLACE] stays inside these. */
    public const val FOLLOW_RATE_MIN: Double = 0.5
    public const val FOLLOW_RATE_MAX: Double = 2.0

    /**
     * A brake reading at or above this is "braking" in the scrubber's words —
     * compare-laps.js' `BRAKING_PCT`, which the head-to-head counts by.
     */
    public const val BRAKING_WORD_PCT: Double = 10.0

    private fun clamp(v: Double, lo: Double, hi: Double): Double = max(lo, min(hi, v))

    /**
     * The fractional grid index where `t[k] == e`, by binary search and linear
     * interpolation, clamped to `[0, t.size − 1]`. [t] is strictly increasing:
     * `lapTimeSeries` floors the speed at `DELTA_MIN_KPH`, so no cell takes no time.
     */
    public fun gridAtElapsed(t: List<Double>, e: Double): Double {
        val last = t.size - 1
        // `!(e > t[0])` rather than `e <= t[0]`: a NaN lands on the line, as in the JS.
        if (last <= 0 || !(e > t[0])) return 0.0
        if (e >= t[last]) return last.toDouble()
        var lo = 0
        var hi = last
        while (hi - lo > 1) {
            val mid = (lo + hi) ushr 1
            if (t[mid] <= e) lo = mid else hi = mid
        }
        return lo + (e - t[lo]) / (t[hi] - t[lo])
    }

    /**
     * A series at fractional index [k], linearly interpolated, [k] clamped to
     * the series. Null for a missing or empty series.
     */
    public fun valueAt(series: List<Double>?, k: Double): Double? {
        if (series.isNullOrEmpty()) return null
        val last = series.size - 1
        val kk = clamp(if (k.isFinite()) k else 0.0, 0.0, last.toDouble())
        val i0 = floor(kk).toInt()
        if (i0 >= last) return series[last]
        return series[i0] + (series[i0 + 1] - series[i0]) * (kk - i0)
    }

    /**
     * A side's clip as the stage reads it: where the lap starts inside the video
     * and how long the video is, both ms. [lapOffsetMs] is nullable only so the
     * JS's "a clip with no offset is no clip" rule has something to drop.
     */
    public data class SideClip(val lapOffsetMs: Double?, val durationMs: Double? = null) {
        public companion object {
            public fun of(clip: LapClip?): SideClip? =
                clip?.let { SideClip(it.lapOffsetMs.toDouble(), it.durationMs.toDouble()) }
        }
    }

    /**
     * One side of the stage: a lap's stored channel entry, its grid spacing, its
     * time curve [t] (elapsed seconds at each grid point) and its clip, or null
     * for replay. When [clip] is non-null its offset is non-null.
     */
    public data class Side(
        val key: SideKey,
        val entry: LapChannels,
        val dStepM: Double,
        val t: List<Double>,
        val clip: SideClip?,
    )

    /**
     * Build a side. Null when [entry] carries no speed trace to integrate. [t]
     * is a stored time curve, used as given; otherwise it is derived once with
     * `lapTimeSeries`.
     */
    public fun makeSide(
        key: SideKey,
        entry: LapChannels,
        dStepM: Double,
        clip: SideClip?,
        t: List<Double>? = null,
    ): Side? {
        val speed = entry.speed
        if (speed == null || speed.size < 2) return null
        val curve = t ?: ChannelGraphs.lapTimeSeries(speed, dStepM, entry.timeMs)
        val offset = clip?.lapOffsetMs
        val kept = if (clip != null && offset != null && offset.isFinite()) {
            SideClip(offset, clip.durationMs?.takeIf { it.isFinite() })
        } else {
            null
        }
        return Side(key, entry, dStepM, curve, kept)
    }

    // The side's lap length in seconds — the time curve's end, which is the
    // timed lap when it had one.
    private fun lapS(side: Side): Double = side.t[side.t.size - 1]
    private fun offsetMs(side: Side): Double = side.clip?.lapOffsetMs ?: 0.0

    /** [sideAtClipTime]'s answer: the lap's elapsed seconds (negative before the line), k there, and whether that is in the lap. */
    public data class SideAt(val e: Double, val k: Double, val inLap: Boolean)

    /** A clip time (ms) → `{ e, k, inLap }` for one side, k clamped to the lap. */
    public fun sideAtClipTime(side: Side, clipMs: Double): SideAt {
        val e = (clipMs - offsetMs(side)) / 1000
        return SideAt(e, gridAtElapsed(side.t, e), e >= 0 && e <= lapS(side))
    }

    /** k → the clip time (ms) to seek that side to. */
    public fun clipTimeAtGrid(side: Side, k: Double): Double = offsetMs(side) + 1000 * valueAt(side.t, k)!!

    public data class ScrubRange(val min: Double, val max: Double)

    /**
     * The scrubber's range in the master's lap time, seconds: the lap with
     * `PLAYBACK_LEAD_S` of run-up either side.
     */
    public fun scrubRange(side: Side): ScrubRange =
        ScrubRange(-LapClips.PLAYBACK_LEAD_S, lapS(side) + LapClips.PLAYBACK_LEAD_S)

    /**
     * Whether two sides are matched by lap fraction rather than grid index:
     * their driven lengths differ by more than compare-laps.js' warning threshold.
     */
    public fun matchByFraction(a: Side?, b: Side?): Boolean {
        if (a == null || b == null) return false
        val la = (a.t.size - 1) * a.dStepM
        val lb = (b.t.size - 1) * b.dStepM
        val longest = max(la, lb)
        return longest > 0 && abs(la - lb) / longest > CompareLaps.LENGTH_MISMATCH_WARN
    }

    // k on `from`'s grid → the same place on `to`'s grid.
    private fun mapGrid(from: Side, to: Side, k: Double, byFraction: Boolean): Double {
        val nTo = (to.t.size - 1).toDouble()
        if (!byFraction) return clamp(k, 0.0, nTo)
        val nFrom = (from.t.size - 1).toDouble()
        return if (nFrom > 0) clamp((k * nTo) / nFrom, 0.0, nTo) else 0.0
    }

    /** What the car is doing at a side's k: the stored readings, each null when the lap lacks the channel. */
    public data class Readings(val speedKph: Double?, val throttle: Double?, val brake: Double?, val gear: Double?)

    // The nearest sample for the gear — a state, not a measurement: gear 3.5 means nothing.
    private fun readings(entry: LapChannels, k: Double): Readings {
        val gears = entry.gear
        val gear = if (!gears.isNullOrEmpty()) {
            gears[clamp(java.lang.Math.round(k).toDouble(), 0.0, (gears.size - 1).toDouble()).toInt()]
        } else {
            null
        }
        return Readings(
            speedKph = valueAt(entry.speed, k),
            throttle = valueAt(entry.throttle, k),
            brake = valueAt(entry.brake, k),
            gear = gear?.takeIf { it.isFinite() },
        )
    }

    /**
     * One side's place at the playhead. [clipMs] is null for a replay side;
     * [inClip] says whether the side's video holds this moment — a cut that
     * started late, or a playhead out in the other lap's run-up, leaves it on replay.
     */
    public data class SideState(
        val e: Double,
        val k: Double,
        val distM: Double,
        val inLap: Boolean,
        val clipMs: Double?,
        val inClip: Boolean,
        val now: Readings,
    )

    private fun sideState(side: Side, e: Double, k: Double): SideState {
        val clipMs = if (side.clip != null) offsetMs(side) + 1000 * e else null
        val dur = side.clip?.durationMs
        return SideState(
            e = e,
            k = k,
            distM = k * side.dStepM,
            inLap = e >= 0 && e <= lapS(side),
            clipMs = clipMs,
            inClip = clipMs != null && clipMs >= 0 && (dur == null || clipMs <= dur),
            now = readings(side.entry, k),
        )
    }

    /** The two sides of a view: [b] is null for a one-sided stage. */
    public data class Sides(val a: Side, val b: Side? = null)

    /**
     * The whole view at one moment. [deltaS] is A's time minus B's at A's place
     * (positive: A slower); [gapM] in [SyncMode.TIME] is B's distance ahead of A
     * in metres (positive: B ahead). Both are A/B-relative whichever side is the
     * master, and null out of the lap or one-sided; [gapM] is null in [SyncMode.PLACE].
     */
    public data class PlayheadState(
        val mode: SyncMode,
        val masterKey: SideKey,
        val inLap: Boolean,
        val byFraction: Boolean,
        val a: SideState,
        val b: SideState?,
        val deltaS: Double?,
        val gapM: Double?,
    ) {
        /** The master side's state — the one whose clock runs the view. */
        val master: SideState get() = if (masterKey == SideKey.B && b != null) b else a
    }

    /**
     * The whole view at the master's elapsed time [eMaster] (seconds from its line).
     *
     * In the lap: [SyncMode.PLACE] puts the other side at the master's
     * distance, [SyncMode.TIME] at its elapsed time. Out of the lap both sides
     * keep the master's distance from the line in time — the same run-up before
     * it, the same roll-out after — so two cars cross it together in place mode.
     */
    public fun playheadAt(
        sides: Sides,
        masterKey: SideKey,
        eMaster: Double,
        mode: SyncMode = DEFAULT_SYNC_MODE,
    ): PlayheadState {
        val a = sides.a
        val b = sides.b
        val master = if (masterKey == SideKey.B && b != null) b else a
        val other = if (master === a) b else a
        val key = if (master === a) SideKey.A else SideKey.B
        val byFraction = matchByFraction(a, b)
        val lapM = lapS(master)
        val inLap = eMaster >= 0 && eMaster <= lapM
        val kM = gridAtElapsed(master.t, eMaster)
        val mState = sideState(master, eMaster, kM)

        var oState: SideState? = null
        if (other != null) {
            val eO: Double
            val kO: Double
            if (mode == SyncMode.TIME) {
                eO = eMaster
                kO = gridAtElapsed(other.t, eO)
            } else if (!inLap) {
                eO = if (eMaster < 0) eMaster else lapS(other) + (eMaster - lapM)
                kO = gridAtElapsed(other.t, eO)
            } else {
                kO = mapGrid(master, other, kM, byFraction)
                eO = valueAt(other.t, kO)!!
            }
            oState = sideState(other, eO, kO)
        }

        val aState = if (master === a) mState else oState!!
        val bState = if (master === a) oState else mState
        var deltaS: Double? = null
        var gapM: Double? = null
        if (b != null && inLap) {
            val kB = mapGrid(a, b, aState.k, byFraction)
            deltaS = valueAt(a.t, aState.k)!! - valueAt(b.t, kB)!!
            if (mode == SyncMode.TIME) {
                val kBonA = mapGrid(b, a, bState!!.k, byFraction)
                gapM = (kBonA - aState.k) * a.dStepM
            }
        }
        return PlayheadState(mode, key, inLap, byFraction, aState, bState, deltaS, gapM)
    }

    /**
     * The follower's playback rate in place mode at the master's grid index
     * [k]: the master's speed over the follower's at the same place, so the
     * follower's video covers the same metres in the master's seconds. Floored
     * at `DELTA_MIN_KPH` like the time curve, and clamped.
     */
    public fun followRate(sides: Sides, masterKey: SideKey, k: Double): Double {
        val a = sides.a
        val b = sides.b ?: return 1.0
        val master = if (masterKey == SideKey.B) b else a
        val other = if (master === a) b else a
        val vM = valueAt(master.entry.speed, k)
        val vO = valueAt(other.entry.speed, mapGrid(master, other, k, matchByFraction(a, b)))
        if (vM == null || vO == null) return 1.0
        return clamp(
            max(ChannelGraphs.DELTA_MIN_KPH, vM) / max(ChannelGraphs.DELTA_MIN_KPH, vO),
            FOLLOW_RATE_MIN,
            FOLLOW_RATE_MAX,
        )
    }

    /** Whether a follower [actualMs] into its clip is far enough from [targetMs] to re-seek: strictly more than [RESYNC_MS]. */
    public fun needsResync(targetMs: Double, actualMs: Double): Boolean = abs(targetMs - actualMs) > RESYNC_MS

    private const val MINUS = "−"

    /** The stage's clock: "0:36.0", "2:19.8", "−0:01.5" — tenths, rounded. */
    public fun fmtStageTime(s: Double?): String {
        if (s == null || !s.isFinite()) return "—"
        val tenths = java.lang.Math.round(abs(s) * 10)
        val m = tenths / 600
        val sec = (tenths % 600) / 10.0
        val body = "$m:${if (sec < 10) "0" else ""}${Units.toFixed(sec, 1)}"
        return if (s < 0 && tenths > 0) "$MINUS$body" else body
    }

    /** A signed delta in seconds: "+0.31 s", "−0.12 s", "0.00 s". */
    public fun fmtDeltaS(d: Double?): String? {
        if (d == null || !d.isFinite()) return null
        val v = java.lang.Math.round(abs(d) * 100)
        if (v == 0L) return "0.00 s"
        return "${if (d > 0) "+" else MINUS}${Units.toFixed(v / 100.0, 2)} s"
    }

    /** "B ahead 26 m" / "A ahead 85 ft" / "Level". */
    public fun fmtGap(gapM: Double?, units: UnitSystem): String? {
        if (gapM == null || !gapM.isFinite()) return null
        val metric = Units.isMetric(units)
        val v = java.lang.Math.round(abs(gapM) * (if (metric) 1.0 else Units.FT_PER_M))
        if (v == 0L) return "Level"
        return "${if (gapM > 0) "B" else "A"} ahead $v ${if (metric) "m" else "ft"}"
    }

    /**
     * Where [k] sits among the corners: "in T2", "after T4", "before T1", or
     * null when the lap has no corners to place it by.
     */
    public fun cornerPlace(corners: List<Corners.Corner>?, k: Double): String? {
        if (corners.isNullOrEmpty()) return null
        val inside = corners.firstOrNull { k >= it.k0 && k <= it.k1 }
        if (inside != null) return "in ${Corners.cornerLabel(inside)}"
        var prev: Corners.Corner? = null
        for (c in corners) if (c.k1 < k) prev = c
        return if (prev != null) "after ${Corners.cornerLabel(prev)}" else "before ${Corners.cornerLabel(corners[0])}"
    }

    /** [playheadText]'s answer: the now-strip's first line, the scrubber's spoken value, and the delta (or gap). */
    public data class PlayheadText(val place: String, val value: String, val delta: String?)

    /**
     * The words for the playhead, read from side A: [PlayheadText.place] the
     * now-strip's first line ("1.50 km · in T2", or "Before the line"),
     * [PlayheadText.delta] its last ("+0.31 s", or in time mode "B ahead 26 m";
     * null with nothing to compare), and [PlayheadText.value] the scrubber's
     * spoken value — "0:41.2, 2.84 km, in T11, 82 mph, braking 64 %, +0.31 s" —
     * whose clock is the master's.
     */
    public fun playheadText(state: PlayheadState, corners: List<Corners.Corner>?, units: UnitSystem): PlayheadText {
        val a = state.a
        val clock = fmtStageTime(state.master.e)
        if (!state.inLap) {
            val place = if (state.master.e < 0) "Before the line" else "After the line"
            return PlayheadText(place, "$clock, $place", null)
        }
        val dist = Units.fmtDist(java.lang.Math.round(a.distM).toDouble(), units)
        val where = cornerPlace(corners, a.k)
        val place = if (where != null) "$dist · $where" else dist
        val delta = if (state.mode == SyncMode.TIME) fmtGap(state.gapM, units) else fmtDeltaS(state.deltaS)
        val parts = mutableListOf(clock, dist)
        if (where != null) parts.add(where)
        a.now.speedKph?.let { parts.add(Units.fmtSpeedKph(it, units)) }
        val brake = a.now.brake
        val throttle = a.now.throttle
        if (brake != null && brake >= BRAKING_WORD_PCT) {
            parts.add("braking ${java.lang.Math.round(brake)} %")
        } else if (throttle != null) {
            parts.add("throttle ${java.lang.Math.round(throttle)} %")
        }
        if (delta != null) parts.add(delta)
        return PlayheadText(place, parts.joinToString(", "), delta)
    }

    /** A screen reader's stop along the scrubber: a corner's label and the lap's elapsed seconds at its start. */
    public data class CornerStop(val label: String, val e: Double)

    /** The screen reader's stops along the scrubber: each corner's start on time curve [t]. */
    public fun cornerStops(corners: List<Corners.Corner>?, t: List<Double>): List<CornerStop> =
        (corners ?: emptyList()).map { CornerStop(Corners.cornerLabel(it), valueAt(t, it.k0.toDouble())!!) }

    /**
     * The single-lap stage's reference lap: the session best, or the next-best
     * when this lap is the best, or null when no other lap has channels.
     * [matched] is [ChannelGraphs.matchLapsToChannels]' rows; returns one of
     * them. Ties go to the earlier lap.
     */
    public fun referenceLap(matched: List<ChannelGraphs.LapMatch>?, chIdx: Int?): ChannelGraphs.LapMatch? {
        val all = (matched ?: emptyList()).filter { it.chIdx >= 0 }
        val rows = all.filter { it.chIdx != chIdx }
        if (rows.isEmpty()) return null
        val best = all.reduce { m, r -> if (r.lap.timeMs < m.lap.timeMs) r else m }
        if (best.chIdx != chIdx) return best
        return rows.reduce { m, r -> if (r.lap.timeMs < m.lap.timeMs) r else m }
    }

    /** [stageSides]' answer, as channel indexes; [b] null for a one-sided stage. */
    public data class StageSides(val a: Int, val b: Int?)

    /**
     * Which of a session panel's lit laps the stage shows: A the lap the view
     * was opened for if it is lit, else the most recently lit; B the fastest
     * other lit lap (ties to the earlier index), or null. [lit] is the panel's
     * slot order (oldest first), [laps] the channel entries. Null when nothing is lit.
     */
    public fun stageSides(lit: List<Int>?, laps: List<LapChannels>, openedChIdx: Int?): StageSides? {
        if (lit.isNullOrEmpty()) return null
        val a = if (openedChIdx != null && openedChIdx in lit) openedChIdx else lit.last()
        var b: Int? = null
        for (i in lit) {
            if (i == a || i !in laps.indices) continue
            val cur = b
            if (cur == null || laps[i].timeMs < laps[cur].timeMs || (laps[i].timeMs == laps[cur].timeMs && i < cur)) b = i
        }
        return StageSides(a, b)
    }
}
