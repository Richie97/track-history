package app.trackevolution.screens

import app.trackevolution.core.api.LogbookOwner
import app.trackevolution.core.clips.ClipJob
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.LapClip
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What the lap page says about a lap's video (NS-45), branch by branch: whose
 * logbook, whose tier, and which of this phone's upload jobs is the lap's.
 */
class LapVideoStateTest {

    private val clip = LapClip(id = 9, durationMs = 127_450, lapOffsetMs = 3_317, sizeBytes = 90_156_176)
    private val withClip = Lap(id = 41, sessionId = 501, lapNum = 6, timeMs = 122_110, clip = clip)
    private val without = withClip.copy(clip = null)
    private val pro = Entitlement(tier = Entitlement.Tier.PRO)
    private val free = Entitlement.FREE
    private val proStudent = LogbookOwner.Student(id = 5, name = "Sam", pro = true)
    private val freeStudent = LogbookOwner.Student(id = 5, name = "Sam", pro = false)

    private fun job(sessionId: Int = 501, timeMs: Int = 122_110, state: ClipJob.State = ClipJob.State.PENDING) =
        ClipJob(id = "j", sessionId = sessionId, eventId = 7, timeMs = timeMs, state = state, createdAt = 0)

    private fun of(
        lap: Lap,
        owner: LogbookOwner = LogbookOwner.Me,
        viewer: Entitlement? = pro,
        jobs: List<ClipJob> = emptyList(),
        resolve: (Int) -> Int? = { null },
        cellular: Boolean = false,
        metered: Boolean = false,
    ) = LapVideoState.of(lap, 501, owner, viewer, jobs, resolve, cellular, metered)

    @Test
    fun `the owner plays and manages a ready clip with Pro, and sees it locked without`() {
        assertEquals(LapVideoState.Playable(clip, menu = true), of(withClip))
        assertEquals(LapVideoState.Locked, of(withClip, viewer = free))
        assertEquals(LapVideoState.Locked, of(withClip, viewer = null))
    }

    @Test
    fun `a coach watches by the student's tier, whatever their own, and never gets the menu`() {
        assertEquals(LapVideoState.Playable(clip, menu = false), of(withClip, owner = proStudent, viewer = free))
        val locked = of(withClip, owner = freeStudent, viewer = pro)
        assertEquals(LapVideoState.StudentLocked("Sam"), locked)
        assertEquals("Lap videos play while Sam has Pro.", (locked as LapVideoState.StudentLocked).text)
        assertEquals("Lap videos play while this driver has Pro.", LapVideoState.StudentLocked(null).text)
    }

    @Test
    fun `a clip on its way says so, and waits for Wi-Fi only when cellular is off and the network is metered`() {
        assertEquals(LapVideoState.Uploading, of(without, jobs = listOf(job(state = ClipJob.State.CUTTING))))
        assertEquals(LapVideoState.Uploading, of(without, jobs = listOf(job()), metered = false))
        assertEquals(LapVideoState.WaitingForWifi, of(without, jobs = listOf(job()), metered = true))
        assertEquals(LapVideoState.Uploading, of(without, jobs = listOf(job()), metered = true, cellular = true))
        assertEquals(LapVideoState.CutFailed, of(without, jobs = listOf(job(state = ClipJob.State.CUT_FAILED))))
    }

    @Test
    fun `a job matches by session and lap time, through the id map for a session saved offline`() {
        assertEquals(LapVideoState.None, of(without, jobs = listOf(job(timeMs = 99_999))))
        assertEquals(LapVideoState.None, of(without, jobs = listOf(job(sessionId = 502))))
        assertEquals(LapVideoState.None, of(without, jobs = listOf(job(sessionId = -3))))
        assertEquals(LapVideoState.Uploading, of(without, jobs = listOf(job(sessionId = -3)), resolve = { if (it == -3) 501 else null }))
    }

    @Test
    fun `nothing at all for a lap with no clip and no job, and never a pending state for a coach`() {
        assertEquals(LapVideoState.None, of(without))
        assertEquals(LapVideoState.None, of(without, owner = proStudent, jobs = listOf(job())))
    }
}
