package app.trackevolution.ui.stage

import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.trackevolution.core.Corners
import app.trackevolution.core.VideoSync
import app.trackevolution.core.VideoSync.SideKey
import app.trackevolution.core.VideoSync.SyncMode
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.LapClip
import app.trackevolution.core.telemetry.LapClips
import app.trackevolution.ui.charts.LapPlayhead
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The lap stage's state and its two players (NS-51), held on the destination's
 * back-stack entry — the [app.trackevolution.screens.ClipPlayerHolder] pattern.
 *
 * `MainActivity` declares no `configChanges`, so **every rotation recreates the
 * activity**, and turning a phone sideways is exactly how a driver asks for the
 * full-bleed video. Held here, the players, the playhead ([eMaster]), the sync
 * [mode], the [swapped] inset and whether it was [playing] all outlive that, a
 * fold and the two-pane breakpoint; the composition only draws them.
 *
 * The clock is one seam: while playing, [tick] (driven by the stage's
 * `withFrameNanos` loop) reads the master's video position into [eMaster] when
 * the master's video holds the moment, and otherwise advances it at real lap
 * speed — the replay. The panel can't tell the two apart.
 *
 * [newPlayer] is injected so a JVM test drives the whole holder with a fake
 * (`LapStageHolderTest`); [scope] defaults to the ViewModel's.
 */
class LapStageHolder(
    private val newPlayer: () -> StagePlayer,
    scope: CoroutineScope? = null,
) : ViewModel() {

    private val io: CoroutineScope = scope ?: viewModelScope

    /** One side as the stage shows it: its sync side, its clip (null: replay) and its words. */
    data class SideInfo(
        val side: VideoSync.Side,
        /** The clip the stage may play — null for no clip, a locked one, or the leaderboard's other driver. */
        val clip: LapClip?,
        /** "Lap 5 · 2:19.812". */
        val label: String,
        val best: Boolean,
        /** The side's lap in the panel's own blob, for the playhead's dots; null when the panel doesn't draw it. */
        val chIdx: Int?,
        /** Why a clip that exists isn't played — the locked sentence — or null. */
        val lockedNote: String? = null,
    )

    /**
     * What the stage is showing. [b] is the second side: shown in its own slot
     * when [showB], or, on a single lap's stage, the **reference** the delta is
     * measured against, which has no slot ([showB] false). [key] says when a new
     * binding is a different view rather than the same one recomposed.
     */
    data class Binding(
        val key: String,
        val a: SideInfo,
        val b: SideInfo? = null,
        val showB: Boolean = true,
        val corners: List<Corners.Corner> = emptyList(),
    ) {
        val sides: VideoSync.Sides get() = VideoSync.Sides(a.side, b?.side)
        val shownB: SideInfo? get() = if (showB) b else null
    }

    var binding by mutableStateOf<Binding?>(null)
        private set
    var mode by mutableStateOf(VideoSync.DEFAULT_SYNC_MODE)
        private set
    var swapped by mutableStateOf(false)
        private set
    var playing by mutableStateOf(false)
        private set

    /** The master's elapsed seconds from its line — the playhead. Opens two seconds before the line. */
    var eMaster by mutableDoubleStateOf(-LapClips.PLAYBACK_LEAD_S)
        private set

    /** 0.25×, 0.5× or 1× (large screens' rate menu). */
    var rate by mutableDoubleStateOf(1.0)
        private set

    /** The fullscreen button's request, in portrait. */
    var fullscreen by mutableStateOf(false)

    /** A full-bleed the back chip left, held until the window stops asking for one. */
    var fullBleedDismissed by mutableStateOf(false)

    /** Whether the full-bleed dialog has the master's player — the page's view lets go meanwhile. */
    var fullBleedShowing by mutableStateOf(false)

    /** A finger or a mouse is dragging the scrubber or a chart. */
    var scrubbing by mutableStateOf(false)
        private set

    /** Signed URLs by clip id, and what to say instead of a video. */
    private val urls = mutableStateMapOf<Int, String>()
    private val notes = mutableStateMapOf<Int, String>()
    private val players = mutableMapOf<Int, StagePlayer>()
    private val refetched = mutableSetOf<Int>()
    private var signedUrl: (suspend (Int) -> String)? = null
    private var modeChosen = false
    private var wasPlaying = false
    private var lastFrameNanos = 0L
    private var lastRateAtNanos = 0L
    private var lastResyncAtNanos = 0L

    /** The master side's key: A unless the inset was swapped. */
    val masterKey: SideKey
        get() = if (swapped && binding?.shownB != null) SideKey.B else SideKey.A

    private fun info(key: SideKey): SideInfo? = binding?.let { if (key == SideKey.A) it.a else it.shownB }

    /** The whole view at [eMaster] — what the now-strip, the scrubber's words and the map read. */
    val state: State<VideoSync.PlayheadState?> = derivedStateOf {
        val b = binding ?: return@derivedStateOf null
        VideoSync.playheadAt(b.sides, masterKey, eMaster, mode)
    }

    /** What the panel draws: side A's place and each side's own, or null out of the lap. */
    val playhead: State<LapPlayhead?> = derivedStateOf {
        val b = binding ?: return@derivedStateOf null
        val st = state.value ?: return@derivedStateOf null
        if (!st.inLap) return@derivedStateOf null
        val perLap = buildMap {
            b.a.chIdx?.let { put(it, st.a.k) }
            val bk = st.b?.k
            val bIdx = b.b?.chIdx
            if (bk != null && bIdx != null && b.showB) put(bIdx, bk)
        }
        LapPlayhead(st.a.k, perLap)
    }

    /** The scrubber's range: the master's lap with the run-up either side. */
    val range: VideoSync.ScrubRange?
        get() {
            val b = binding ?: return null
            return VideoSync.scrubRange(if (masterKey == SideKey.B) b.b!!.side else b.a.side)
        }

    // ---- binding -------------------------------------------------------------

    /**
     * Show [next]. The same [Binding.key] again is a recomposition and changes
     * nothing; a different one (the lit laps changed, the picks changed) keeps
     * side A's place on the track and whether it was playing. [urlFor] signs a
     * clip's URL — the owner's route, a coach's mount, or a share link's.
     */
    fun bind(next: Binding, urlFor: suspend (Int) -> String, startK: Double? = null) {
        signedUrl = urlFor
        val prev = binding
        if (prev != null && prev.key == next.key) {
            binding = next // the words may have changed (units); the sides haven't
            return
        }
        val keepK = startK ?: state.value?.takeIf { it.inLap }?.a?.k
        val keepE = eMaster.takeIf { prev != null && keepK == null }
        val resume = playing
        pauseInternal()
        binding = next
        // The master is the side with video if A has none.
        swapped = next.a.clip == null && next.shownB?.clip != null
        val keep = next.clips().map { it.id }.toSet()
        players.keys.filter { it !in keep }.forEach { id -> players.remove(id)?.release() }
        next.clips().forEach { load(it) }
        eMaster = when {
            keepK != null -> elapsedForGridA(keepK)
            keepE != null -> keepE
            else -> -LapClips.PLAYBACK_LEAD_S
        }
        seekPlayers(exact = true)
        applyRoles()
        if (resume) play()
    }

    private fun Binding.clips(): List<LapClip> = listOfNotNull(a.clip, shownB?.clip)

    private fun load(clip: LapClip) {
        if (clip.id in players || clip.id in notes) return
        val url = urls[clip.id]
        if (url != null) {
            open(clip, url)
            return
        }
        val sign = signedUrl ?: return
        io.launch {
            try {
                val signed = sign(clip.id)
                urls[clip.id] = signed
                open(clip, signed)
            } catch (e: ApiException) {
                notes[clip.id] = when {
                    e is ApiException.Transport -> StageVideoText.NEEDS_CONNECTION
                    e.isNotFound -> StageVideoText.DELETED
                    else -> e.message ?: StageVideoText.NEEDS_CONNECTION
                }
            }
        }
    }

    private fun open(clip: LapClip, url: String) {
        val p = players[clip.id] ?: newPlayer().also { players[clip.id] = it }
        val st = state.value
        val target = targetMsFor(clip, st) ?: LapClips.playbackStartMs(clip.lapOffsetMs).toLong()
        p.load(url, target)
        applyRoles()
    }

    /** Where [clip]'s side should be at [st], in its clip; null when its video doesn't hold the moment. */
    private fun targetMsFor(clip: LapClip, st: VideoSync.PlayheadState?): Long? {
        val b = binding ?: return null
        st ?: return null
        val side = when (clip.id) {
            b.a.clip?.id -> st.a
            b.shownB?.clip?.id -> st.b
            else -> null
        } ?: return null
        return side.clipMs?.takeIf { side.inClip }?.toLong()
    }

    /** The player for [key]'s side when its video can show a frame; null is replay. */
    fun playerFor(key: SideKey): StagePlayer? {
        val clip = info(key)?.clip ?: return null
        if (notes[clip.id] != null) return null
        return players[clip.id]?.takeIf { it.error == null }
    }

    /** What a side's slot says instead of a video — no connection, deleted, a failure — or null. */
    fun noteFor(key: SideKey): String? {
        val clip = info(key)?.clip ?: return null
        return notes[clip.id] ?: players[clip.id]?.error
    }

    /** Whether any side the stage shows has a video to fill a window with. */
    val hasVideo: Boolean
        get() = playerFor(SideKey.A) != null || playerFor(SideKey.B) != null

    // ---- the transport ------------------------------------------------------

    fun play() {
        val r = range ?: return
        if (eMaster >= r.max) eMaster = r.min
        playing = true
        lastFrameNanos = 0L
        seekPlayers(exact = true)
        startPlayers()
    }

    fun pause() {
        pauseInternal()
    }

    private fun pauseInternal() {
        playing = false
        players.values.forEach { it.pause() }
    }

    fun togglePlay() = if (playing) pause() else play()

    /** A tap on a chart: pause, seek to side A's grid index [kA], and park there. */
    fun seekGrid(kA: Double) {
        pauseInternal()
        scrubbing = false
        eMaster = elapsedForGridA(kA)
        seekPlayers(exact = true)
    }

    /** A mouse dragging a chart: a fast seek per move. [endScrub] makes the last one exact. */
    fun scrubGrid(kA: Double) {
        beginScrub()
        eMaster = elapsedForGridA(kA)
        seekPlayers(exact = false)
    }

    /** The scrubber's drag: the master's elapsed seconds, fast. */
    fun scrubElapsed(e: Double) {
        beginScrub()
        val r = range ?: return
        eMaster = e.coerceIn(r.min, r.max)
        seekPlayers(exact = false)
    }

    /** A tap on the scrubber, a key or an accessibility step: exact, keeping play or pause. */
    fun seekElapsed(e: Double) {
        val r = range ?: return
        eMaster = e.coerceIn(r.min, r.max)
        seekPlayers(exact = true)
        if (playing) startPlayers()
    }

    private fun beginScrub() {
        if (!scrubbing) {
            wasPlaying = playing
            pauseInternal()
            scrubbing = true
        }
    }

    /** The drag ended: one exact seek, and playback resumes if it was playing. */
    fun endScrub() {
        if (!scrubbing) return
        scrubbing = false
        seekPlayers(exact = true)
        if (wasPlaying) play()
    }

    /** The screen reader's *Next corner* / *Previous corner*: the next stop along the master's lap. */
    fun stepCorner(forward: Boolean) {
        val b = binding ?: return
        val t = (if (masterKey == SideKey.B) b.b!!.side else b.a.side).t
        val stops = VideoSync.cornerStops(b.corners, t).map { it.e }
        val target = if (forward) stops.firstOrNull { it > eMaster + 0.05 } else stops.lastOrNull { it < eMaster - 0.05 }
        target?.let { seekElapsed(it) }
    }

    fun changeMode(next: SyncMode) {
        modeChosen = true
        if (mode == next) return
        mode = next
        seekPlayers(exact = true)
        if (playing) startPlayers()
    }

    /** The remembered mode, adopted unless this view has already picked one. */
    fun adoptStoredMode(stored: SyncMode) {
        if (!modeChosen && mode != stored) mode = stored
    }

    /** Swap the inset and the master: the scrubber and times follow the new master, the place stays. */
    fun swap() {
        binding?.shownB ?: return
        val st = state.value ?: return
        swapped = !swapped
        eMaster = if (masterKey == SideKey.B) st.b!!.e else st.a.e
        applyRoles()
        seekPlayers(exact = true)
        if (playing) startPlayers()
    }

    fun changeRate(next: Double) {
        rate = next
        if (playing) startPlayers()
    }

    // ---- the clock ----------------------------------------------------------

    /**
     * One display frame while playing: the master's video is the clock while it
     * holds the moment, else real lap speed from the frame time; then the
     * follower is kept in step (*The sync model*). Stops at the end of the
     * scrubber's range.
     */
    fun tick(frameNanos: Long) {
        if (!playing) return
        val b = binding ?: return
        val r = range ?: return
        val dt = if (lastFrameNanos == 0L) 0.0 else ((frameNanos - lastFrameNanos) / 1e9).coerceIn(0.0, 0.1)
        lastFrameNanos = frameNanos
        val masterInfo = info(masterKey) ?: b.a
        val mp = playerFor(masterKey)
        val clip = masterInfo.clip
        val st = state.value
        val masterSide = if (masterKey == SideKey.B) st?.b else st?.a
        var e = if (mp != null && clip != null && mp.ready && mp.isPlaying && masterSide?.inClip == true) {
            (mp.positionMs - clip.lapOffsetMs) / 1000.0
        } else {
            eMaster + dt * rate
        }
        if (e >= r.max) {
            e = r.max
            eMaster = e
            pauseInternal()
            return
        }
        eMaster = e
        keepInStep(frameNanos)
    }

    /** Start or stop each side's video by whether it holds the moment, and keep the follower in step. */
    private fun keepInStep(frameNanos: Long) {
        val b = binding ?: return
        val st = state.value ?: return
        for (key in listOf(SideKey.A, SideKey.B)) {
            val info = info(key) ?: continue
            val clip = info.clip ?: continue
            val p = playerFor(key) ?: continue
            if (!p.ready) continue
            val side = if (key == SideKey.A) st.a else st.b ?: continue
            val target = side.clipMs
            if (!side.inClip || target == null) {
                // Outside its clip a side waits on its last frame and resumes
                // when the target comes back in.
                if (p.isPlaying) p.pause()
                continue
            }
            val isMaster = key == masterKey
            val speed = if (isMaster || mode == SyncMode.TIME) {
                rate
            } else {
                if (frameNanos - lastRateAtNanos >= RATE_EVERY_NANOS || lastRateAtNanos == 0L) {
                    lastRateAtNanos = frameNanos
                    VideoSync.followRate(b.sides, masterKey, if (masterKey == SideKey.B) st.b!!.k else st.a.k) * rate
                } else {
                    null
                }
            }
            speed?.let { p.setSpeed(it.toFloat()) }
            if (!p.isPlaying) {
                p.seekTo(target.toLong(), exact = true)
                p.play()
            } else if (!isMaster && frameNanos - lastResyncAtNanos >= RESYNC_COOLDOWN_NANOS &&
                VideoSync.needsResync(target, p.positionMs.toDouble())
            ) {
                // Exact: a keyframe seek could land 1.5 s off on a PDR clip and
                // trip the next check, forever.
                lastResyncAtNanos = frameNanos
                p.seekTo(target.toLong(), exact = true)
            }
        }
    }

    private fun startPlayers() {
        lastRateAtNanos = 0L
        keepInStep(System.nanoTime())
    }

    /** Every side's video to where the playhead says, or left where it is when its clip doesn't hold the moment. */
    private fun seekPlayers(exact: Boolean) {
        val st = state.value ?: return
        for (key in listOf(SideKey.A, SideKey.B)) {
            val p = playerFor(key) ?: continue
            val side = if (key == SideKey.A) st.a else st.b ?: continue
            val target = side.clipMs?.takeIf { side.inClip } ?: continue
            p.seekTo(target.toLong(), exact)
            if (!playing && p.isPlaying) p.pause()
        }
    }

    /** Sound and decode size by role: only the master is heard; a phone's inset decodes small. */
    private fun applyRoles() {
        for (key in listOf(SideKey.A, SideKey.B)) {
            val p = playerFor(key) ?: continue
            val isMaster = key == masterKey
            p.setMuted(!isMaster)
            p.setInset(!isMaster)
        }
    }

    /** Side A's grid index [kA] as the master's elapsed time, in the current mode. */
    private fun elapsedForGridA(kA: Double): Double {
        val b = binding ?: return eMaster
        val eA = VideoSync.valueAt(b.a.side.t, kA) ?: return eMaster
        if (masterKey == SideKey.A) return eA
        // Where B is when A is at eA, by A's clock in this mode — then B leads.
        return VideoSync.playheadAt(b.sides, SideKey.A, eA, mode).b?.e ?: eA
    }

    /**
     * A player that failed on an expired signed URL (an hour old) gets one new
     * URL, past the cache, and goes back to the same place. Called from the
     * stage's frame loop and on resume.
     */
    fun refreshExpired() {
        val b = binding ?: return
        for (clip in b.clips()) {
            val p = players[clip.id] ?: continue
            if (!p.expired || clip.id in refetched) continue
            refetched += clip.id
            urls.remove(clip.id)
            players.remove(clip.id)?.release()
            load(clip)
        }
    }

    override fun onCleared() {
        players.values.forEach { it.release() }
        players.clear()
    }

    private companion object {
        /** The follower's rate is recomputed at most this often. */
        const val RATE_EVERY_NANOS = 250_000_000L

        /** Two re-seeks of the follower are at least this far apart, so a seek has time to land. */
        const val RESYNC_COOLDOWN_NANOS = 500_000_000L
    }
}
