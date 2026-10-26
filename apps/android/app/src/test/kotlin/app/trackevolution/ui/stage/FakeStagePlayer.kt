package app.trackevolution.ui.stage

import androidx.media3.common.Player

/**
 * A [StagePlayer] with no Media3 behind it: it records what the stage asked of
 * it and plays by a hand-advanced clock ([advance]).
 */
class FakeStagePlayer : StagePlayer {
    override val player: Player? = null
    override var ready: Boolean = true
    override var error: String? = null
    override var expired: Boolean = false
    override var isPlaying: Boolean = false
    override var positionMs: Long = 0

    var loadedUrl: String? = null
    var speedNow: Float = 1f
    var silent: Boolean = false
    var small: Boolean = false
    var released: Boolean = false
    val seeks = mutableListOf<Pair<Long, Boolean>>()

    override fun load(url: String, startMs: Long) {
        loadedUrl = url
        positionMs = startMs
    }

    override fun play() {
        isPlaying = true
    }

    override fun pause() {
        isPlaying = false
    }

    override fun seekTo(ms: Long, exact: Boolean) {
        seeks += ms to exact
        positionMs = ms
    }

    override fun setSpeed(rate: Float) {
        speedNow = rate
    }

    override fun setMuted(muted: Boolean) {
        silent = muted
    }

    override fun setInset(inset: Boolean) {
        small = inset
    }

    override fun release() {
        released = true
    }

    /** Play on for [ms] of wall time at the current speed. */
    fun advance(ms: Long) {
        if (isPlaying) positionMs += (ms * speedNow).toLong()
    }
}
