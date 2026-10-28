package app.trackevolution.ui.stage

import android.content.Context
import androidx.annotation.OptIn
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters

/**
 * One side's video, as the stage drives it (NS-51). An interface so
 * [LapStageHolder] runs in a JVM test with a fake — Media3 has no player to
 * build there — and so every Media3 call the sync needs is in one place.
 */
interface StagePlayer {
    /** What a `PlayerView` shows; null for a fake. */
    val player: Player?

    /** Prepared and showing a frame. */
    val ready: Boolean

    /** Why it can't play, in the lap page's words; null while all is well. */
    val error: String?

    /** Whether the error is the signed URL having expired (a 403), which a fresh URL fixes. */
    val expired: Boolean

    /** Frames are moving: told to play *and* not buffering. */
    val isPlaying: Boolean

    /**
     * Told to play — true while it buffers after a seek, when [isPlaying] is
     * still false. What decides whether to start a player: starting one that is
     * already starting re-seeks it, and a seek restarts the buffering, so a far
     * seek would never land.
     */
    val playWhenReady: Boolean
    val positionMs: Long

    /** Open [url] paused at [startMs]. */
    fun load(url: String, startMs: Long)
    fun play()
    fun pause()

    /** Keyframe-fast while a finger or a mouse drags, exact otherwise. */
    fun seekTo(ms: Long, exact: Boolean)
    fun setSpeed(rate: Float)

    /** Only the large (master) video is heard. */
    fun setMuted(muted: Boolean)

    /** An inset decodes at most 640×360: it is 132 dp wide on a phone. */
    fun setInset(inset: Boolean)
    fun release()
}

/** The stage's words for a playback failure — the lap video card's, so the two say the same. */
object StageVideoText {
    const val NEEDS_CONNECTION = "Playing a lap video needs a connection."
    const val DELETED = "This video has been deleted."
    fun couldNotPlay(code: String) = "Couldn't play this video: $code"
}

/** Media3 behind [StagePlayer]. */
@OptIn(UnstableApi::class)
class ExoStagePlayer(context: Context) : StagePlayer {
    private val exo: ExoPlayer = ExoPlayer.Builder(context).build()
    private var readyState by mutableStateOf(false)
    private var errorState by mutableStateOf<String?>(null)
    private var expiredState by mutableStateOf(false)

    init {
        exo.addListener(
            object : Player.Listener {
                override fun onPlaybackStateChanged(playbackState: Int) {
                    if (playbackState == Player.STATE_READY) readyState = true
                }

                override fun onPlayerError(error: PlaybackException) {
                    expiredState = error.errorCode == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS
                    errorState = when (error.errorCode) {
                        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
                        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
                        -> StageVideoText.NEEDS_CONNECTION
                        else -> StageVideoText.couldNotPlay(error.errorCodeName)
                    }
                }
            },
        )
    }

    override val player: Player get() = exo
    override val ready: Boolean get() = readyState && errorState == null
    override val error: String? get() = errorState
    override val expired: Boolean get() = expiredState
    override val isPlaying: Boolean get() = exo.isPlaying
    override val playWhenReady: Boolean get() = exo.playWhenReady
    override val positionMs: Long get() = exo.currentPosition

    override fun load(url: String, startMs: Long) {
        errorState = null
        expiredState = false
        readyState = false
        exo.setMediaItem(MediaItem.fromUri(url), startMs.coerceAtLeast(0))
        exo.playWhenReady = false
        exo.prepare()
    }

    override fun play() {
        exo.play()
    }

    override fun pause() {
        exo.pause()
    }

    override fun seekTo(ms: Long, exact: Boolean) {
        // Corvette PDR clips have ~1.5 s GOPs: an exact seek per drag event
        // would stall, so a drag seeks to the nearest keyframe and the release
        // seeks exactly once.
        exo.setSeekParameters(if (exact) SeekParameters.EXACT else SeekParameters.CLOSEST_SYNC)
        exo.seekTo(ms.coerceAtLeast(0))
    }

    override fun setSpeed(rate: Float) {
        if (exo.playbackParameters.speed != rate) exo.setPlaybackSpeed(rate)
    }

    override fun setMuted(muted: Boolean) {
        exo.volume = if (muted) 0f else 1f
    }

    override fun setInset(inset: Boolean) {
        val params = exo.trackSelectionParameters.buildUpon()
        if (inset) params.setMaxVideoSize(640, 360) else params.clearVideoSizeConstraints()
        exo.trackSelectionParameters = params.build()
    }

    override fun release() {
        exo.release()
    }
}
