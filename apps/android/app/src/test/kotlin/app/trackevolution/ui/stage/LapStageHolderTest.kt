package app.trackevolution.ui.stage

import app.trackevolution.core.Corners
import app.trackevolution.core.VideoSync
import app.trackevolution.core.VideoSync.SideKey
import app.trackevolution.core.VideoSync.SyncMode
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.LapClip
import app.trackevolution.core.model.SessionChannels
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The stage's holder against [FakeStagePlayer]: the clock, the seeks, the
 * follower's rate and re-seeks, the swap, the remembered mode and the replay
 * fallbacks — everything *The sync model* asks of a player, with no Media3.
 */
class LapStageHolderTest {

    private val n = 30
    private val latG = List(n) { k -> if (k in 10..14) 1.1 else 0.05 }
    private val speedA = List(n) { k -> if (k in 10..14) 90.0 else 160.0 }
    private val speedB = speedA.mapIndexed { k, v -> if (k in 10..14) v - 20 else v - 4 }
    private val entryA = LapChannels(n = 3, timeMs = 15_000, speed = speedA, latG = latG, throttle = List(n) { 100.0 }, brake = List(n) { 0.0 })
    private val entryB = LapChannels(n = 5, timeMs = 16_200, speed = speedB, latG = latG)
    private val clipA = LapClip(id = 7, durationMs = 22_000, lapOffsetMs = 3_000)
    private val clipB = LapClip(id = 8, durationMs = 23_600, lapOffsetMs = 3_400)
    private val corners = Corners.sessionCorners(SessionChannels(v = 1, dStepM = 20.0, laps = listOf(entryA, entryB)))

    private val made = mutableListOf<FakeStagePlayer>()
    private fun holder() = LapStageHolder({ FakeStagePlayer().also { made += it } }, CoroutineScope(Dispatchers.Unconfined))

    private fun binding(clipA: LapClip? = this.clipA, clipB: LapClip? = this.clipB, showB: Boolean = true, key: String = "ab") =
        LapStageHolder.Binding(
            key = key,
            a = stageSide(SideKey.A, entryA, 20.0, 3, clipA, true, 0)!!,
            b = stageSide(SideKey.B, entryB, 20.0, 5, clipB, false, 1),
            showB = showB,
            corners = corners,
        )

    private val urls: suspend (Int) -> String = { "https://clips.test/$it.mp4" }

    @Test
    fun `binds both clips, opens two seconds before the line, and only the master is heard`() {
        val h = holder()
        h.bind(binding(), urls)
        assertEquals(2, made.size)
        assertEquals(-2.0, h.eMaster, 1e-9)
        val a = h.playerFor(SideKey.A) as FakeStagePlayer
        val b = h.playerFor(SideKey.B) as FakeStagePlayer
        assertEquals("https://clips.test/7.mp4", a.loadedUrl)
        assertEquals(1_000L, a.positionMs) // 3 000 offset − 2 s
        assertFalse(a.silent)
        assertTrue(b.silent)
        assertTrue("the inset decodes small", b.small)
        assertTrue(h.hasVideo)
    }

    @Test
    fun `plays on the master's clock and keeps the follower in step`() {
        val h = holder()
        h.bind(binding(), urls)
        h.seekElapsed(8.0)
        h.play()
        val a = h.playerFor(SideKey.A) as FakeStagePlayer
        val b = h.playerFor(SideKey.B) as FakeStagePlayer
        assertTrue(a.isPlaying)
        assertTrue(b.isPlaying)
        h.tick(1_000_000_000L)
        a.advance(500)
        h.tick(1_500_000_000L)
        assertEquals("the master's video is the clock", 8.5, h.eMaster, 1e-6)
        // In Same place the follower runs at the speed ratio at the shared distance.
        val st = h.state.value!!
        assertEquals(VideoSync.followRate(binding().sides, SideKey.A, st.a.k).toFloat(), b.speedNow, 1e-4f)
        // Drifted past RESYNC_MS, the follower is re-seeked exactly.
        b.positionMs -= 400
        h.tick(2_100_000_000L)
        val target = h.state.value!!.b!!.clipMs!!.toLong()
        assertEquals(target to true, b.seeks.last())
    }

    @Test
    fun `replay runs at real lap speed from the frame clock and stops at the end`() {
        val h = holder()
        h.bind(binding(clipA = null, clipB = null), urls)
        assertTrue(made.isEmpty())
        assertFalse(h.hasVideo)
        h.play()
        h.tick(1_000_000_000L)
        h.tick(1_050_000_000L)
        assertEquals(-2.0 + 0.05, h.eMaster, 1e-6)
        h.changeRate(0.5)
        h.tick(1_100_000_000L)
        assertEquals(-2.0 + 0.075, h.eMaster, 1e-6)
        h.seekElapsed(16.99)
        h.tick(1_200_000_000L)
        assertEquals(17.0, h.eMaster, 1e-9)
        assertFalse("the end of the range pauses", h.playing)
    }

    @Test
    fun `a chart tap pauses, seeks exactly and parks, and a drag seeks fast until released`() {
        val h = holder()
        h.bind(binding(), urls)
        h.play()
        h.seekGrid(12.0)
        assertFalse(h.playing)
        val a = h.playerFor(SideKey.A) as FakeStagePlayer
        val expected = VideoSync.clipTimeAtGrid(binding().a.side, 12.0).toLong()
        assertEquals(expected to true, a.seeks.last())
        assertEquals(12.0, h.playhead.value!!.k, 1e-9)

        h.play()
        h.scrubGrid(5.0)
        assertTrue(h.scrubbing)
        assertFalse(h.playing)
        assertFalse("a drag seeks to the keyframe", a.seeks.last().second)
        h.endScrub()
        assertTrue("one exact seek on release", a.seeks.last().second)
        assertTrue("and playback resumes", h.playing)
    }

    @Test
    fun `out of the lap there is no playhead`() {
        val h = holder()
        h.bind(binding(), urls)
        assertNull(h.playhead.value)
        h.seekElapsed(5.0)
        assertNotNull(h.playhead.value)
        assertEquals(setOf(0, 1), h.playhead.value!!.perLap.keys)
    }

    @Test
    fun `time mode puts the follower at the master's elapsed time`() {
        val h = holder()
        h.bind(binding(), urls)
        h.changeMode(SyncMode.TIME)
        h.seekElapsed(8.0)
        val st = h.state.value!!
        assertEquals(8.0, st.b!!.e, 1e-9)
        assertTrue(st.gapM!! < 0)
        val p = h.playhead.value!!
        assertEquals("B's dot at B's own place", st.b!!.k, p.kFor(1), 1e-9)
    }

    @Test
    fun `the remembered mode is adopted until the view picks one`() {
        val h = holder()
        h.bind(binding(), urls)
        h.adoptStoredMode(SyncMode.TIME)
        assertEquals(SyncMode.TIME, h.mode)
        h.changeMode(SyncMode.PLACE)
        h.adoptStoredMode(SyncMode.TIME)
        assertEquals(SyncMode.PLACE, h.mode)
    }

    @Test
    fun `swapping the inset swaps the master and the sound, keeping the place`() {
        val h = holder()
        h.bind(binding(), urls)
        h.seekElapsed(8.0)
        val kBefore = h.state.value!!.a.k
        h.swap()
        assertEquals(SideKey.B, h.masterKey)
        assertEquals(kBefore, h.state.value!!.a.k, 1e-9)
        assertTrue((h.playerFor(SideKey.A) as FakeStagePlayer).silent)
        assertFalse((h.playerFor(SideKey.B) as FakeStagePlayer).silent)
    }

    @Test
    fun `the side with video is the master when A has none`() {
        val h = holder()
        h.bind(binding(clipA = null), urls)
        assertEquals(SideKey.B, h.masterKey)
    }

    @Test
    fun `a single lap's reference has no slot and no player`() {
        val h = holder()
        h.bind(binding(showB = false), urls)
        assertEquals(1, made.size)
        assertNull(h.playerFor(SideKey.B))
        h.seekElapsed(8.0)
        assertNotNull("the delta still reads against the reference", h.state.value!!.deltaS)
        assertEquals(setOf(0), h.playhead.value!!.perLap.keys)
    }

    @Test
    fun `a new binding keeps side A's place and whether it was playing`() {
        val h = holder()
        h.bind(binding(), urls)
        h.seekGrid(12.0)
        h.play()
        h.bind(binding(clipB = null, key = "other"), urls)
        assertEquals(12.0, h.state.value!!.a.k, 1e-6)
        assertTrue(h.playing)
        assertTrue("the dropped clip's player is released", made.first { it.loadedUrl!!.endsWith("8.mp4") }.released)
    }

    @Test
    fun `a failed sign-in for the URL turns the side to replay with the words`() {
        val h = LapStageHolder({ FakeStagePlayer() }, CoroutineScope(Dispatchers.Unconfined))
        h.bind(binding(clipB = null), { throw ApiException.Transport("offline") })
        assertNull(h.playerFor(SideKey.A))
        assertEquals(StageVideoText.NEEDS_CONNECTION, h.noteFor(SideKey.A))
        assertFalse(h.hasVideo)
    }

    @Test
    fun `an expired URL is signed again, once`() {
        val h = holder()
        var signed = 0
        h.bind(binding(clipB = null), { signed++; "https://clips.test/$it.mp4?v=$signed" })
        val first = h.playerFor(SideKey.A) as FakeStagePlayer
        first.expired = true
        first.error = "Couldn't play this video: ERROR_CODE_IO_BAD_HTTP_STATUS"
        h.refreshExpired()
        assertTrue(first.released)
        assertEquals(2, signed)
        assertEquals("https://clips.test/7.mp4?v=2", (h.playerFor(SideKey.A) as FakeStagePlayer).loadedUrl)
    }

    @Test
    fun `corner stops step the screen reader along the lap`() {
        val h = holder()
        h.bind(binding(), urls)
        h.stepCorner(forward = true)
        assertEquals(VideoSync.valueAt(binding().a.side.t, corners[0].k0.toDouble())!!, h.eMaster, 1e-9)
        h.stepCorner(forward = false)
        assertEquals("nothing before the first corner: it stays", VideoSync.valueAt(binding().a.side.t, corners[0].k0.toDouble())!!, h.eMaster, 1e-9)
    }

    @Test
    fun `the scrubber's track is the delta in the master's time, with corner and sector ticks`() {
        val track = scrubTrack(binding(), SideKey.A)
        assertTrue(track.isDelta)
        assertEquals(n, track.points.size)
        assertEquals(1.0, track.points.maxOf { kotlin.math.abs(it.second) }, 1e-9)
        assertEquals(corners.size + 2, track.ticks.size)
        val speed = scrubTrack(binding().copy(b = null), SideKey.A)
        assertFalse("with no other side it draws A's speed", speed.isDelta)
    }
}
