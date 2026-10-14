package app.trackevolution.screens

import app.trackevolution.clips.ClipNetwork
import app.trackevolution.core.api.LogbookOwner
import app.trackevolution.core.clips.ClipJob
import app.trackevolution.core.clips.ClipUploadQueue.DropReason
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

    private val now = 1_800_000_000_000L

    private fun job(sessionId: Int = 501, timeMs: Int = 122_110, state: ClipJob.State = ClipJob.State.PENDING) =
        ClipJob(id = "j", sessionId = sessionId, eventId = 7, timeMs = timeMs, state = state, createdAt = 0)

    /** A 100-byte clip in parts of 40: 40, 40, 20. */
    private fun started(uploaded: List<Int> = emptyList()) =
        job().copy(sizeBytes = 100, clipId = 3, partBytes = 40, parts = 3, uploaded = uploaded)

    private fun of(
        lap: Lap,
        owner: LogbookOwner = LogbookOwner.Me,
        viewer: Entitlement? = pro,
        jobs: List<ClipJob> = emptyList(),
        resolve: (Int) -> Int? = { null },
        cellular: Boolean = false,
        metered: Boolean = false,
        online: Boolean = true,
        parts: Map<String, Long> = emptyMap(),
        sessionLaps: List<Lap> = listOf(lap),
    ) = LapVideoState.of(lap, 501, sessionLaps, owner, viewer, jobs, resolve, cellular, ClipNetwork(online, metered), parts, now)

    private val uploading = LapVideoState.Uploading(0.0)

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
        assertEquals(LapVideoState.Preparing, of(without, jobs = listOf(job(state = ClipJob.State.CUTTING))))
        assertEquals(uploading, of(without, jobs = listOf(job()), metered = false))
        assertEquals(LapVideoState.WaitingForWifi, of(without, jobs = listOf(job()), metered = true))
        assertEquals(uploading, of(without, jobs = listOf(job()), metered = true, cellular = true))
        assertEquals(LapVideoState.WaitingForConnection, of(without, jobs = listOf(job()), online = false, cellular = true))
        assertEquals(LapVideoState.Failed(null, "j"), of(without, jobs = listOf(job(state = ClipJob.State.CUT_FAILED))))
    }

    @Test
    fun `uploading says how much of the clip the server holds, plus the part in flight`() {
        assertEquals(LapVideoState.Uploading(0.4), of(without, jobs = listOf(started(uploaded = listOf(1)))))
        assertEquals(LapVideoState.Uploading(0.6), of(without, jobs = listOf(started(uploaded = listOf(1))), parts = mapOf("j" to 20L)))
        // The short last part counts as what it is.
        assertEquals(LapVideoState.Uploading(1.0), of(without, jobs = listOf(started(uploaded = listOf(1, 2, 3)))))
        assertEquals("before the create there is no part size to count by", 0.0, LapVideoState.fraction(job(), 500), 0.0)
        assertEquals("never past the whole", 1.0, LapVideoState.fraction(started(uploaded = listOf(1, 2, 3)), 40), 0.0)
    }

    @Test
    fun `a part in flight says so until the network goes, whatever its backoff said before`() {
        val backedOff = started().copy(failures = 2, notBeforeMs = now + 60_000)
        assertEquals(LapVideoState.Uploading(0.1), of(without, jobs = listOf(backedOff), parts = mapOf("j" to 10L)))
        assertEquals(LapVideoState.WaitingForConnection, of(without, jobs = listOf(backedOff), parts = mapOf("j" to 10L), online = false))
        assertEquals(LapVideoState.WaitingForWifi, of(without, jobs = listOf(backedOff), parts = mapOf("j" to 10L), metered = true))
    }

    @Test
    fun `a failed attempt says when it tries again, ahead of what it would wait for`() {
        val backedOff = job(sessionId = -3).copy(failures = 1, notBeforeMs = now + 30_000)
        assertEquals(LapVideoState.Retrying(now + 30_000, "j"), of(without, jobs = listOf(backedOff), resolve = { 501 }, online = false))
        // A backoff that has run out, or a wait with no failure behind it, is not "interrupted".
        assertEquals(uploading, of(without, jobs = listOf(backedOff.copy(notBeforeMs = now)), resolve = { 501 }))
        assertEquals(uploading, of(without, jobs = listOf(backedOff.copy(failures = 0)), resolve = { 501 }))
    }

    @Test
    fun `a session saved offline is waited for, on a lap page reached by its temp id`() {
        val lap = without.copy(sessionId = -3)
        val state = LapVideoState.of(lap, -3, listOf(lap), LogbookOwner.Me, pro, listOf(job(sessionId = -3)), { null }, false, ClipNetwork.UNKNOWN, emptyMap(), now)
        assertEquals(LapVideoState.WaitingForSession, state)
    }

    @Test
    fun `an upload given up on says why, and one on its way outranks an old failure`() {
        val dropped = job(state = ClipJob.State.DROPPED).copy(dropReason = DropReason.STORAGE_FULL.rawValue)
        assertEquals(LapVideoState.Failed("clip storage full", "j"), of(without, jobs = listOf(dropped)))
        assertEquals(uploading, of(without, jobs = listOf(dropped, job().copy(id = "k"))))
        assertEquals(uploading, of(without, jobs = listOf(job().copy(id = "k"), dropped)))
    }

    @Test
    fun `the words are iOS's`() {
        assertEquals("Preparing video", LapVideoText.pending(LapVideoState.Preparing, now))
        assertEquals("Video waiting for this session to sync", LapVideoText.pending(LapVideoState.WaitingForSession, now))
        assertEquals("Video waiting for a connection", LapVideoText.pending(LapVideoState.WaitingForConnection, now))
        assertEquals("Video waiting for Wi-Fi", LapVideoText.pending(LapVideoState.WaitingForWifi, now))
        assertEquals("Video uploading", LapVideoText.pending(LapVideoState.Uploading(0.009), now))
        assertEquals("Video uploading · 42%", LapVideoText.pending(LapVideoState.Uploading(0.429), now))
        assertEquals(
            "Video upload interrupted. Trying again shortly.",
            LapVideoText.pending(LapVideoState.Retrying(now + 60_000, "j"), now),
        )
        assertEquals(
            "Video upload interrupted. Trying again in 2 min.",
            LapVideoText.pending(LapVideoState.Retrying(now + 61_000, "j"), now),
        )
        assertEquals(
            "Video upload interrupted. Trying again in 60 min.",
            LapVideoText.pending(LapVideoState.Retrying(now + 3_600_000, "j"), now),
        )
        assertEquals(null, LapVideoText.pending(LapVideoState.None, now))

        assertEquals("Couldn't save this lap's video.", LapVideoText.failure(null))
        assertEquals("Couldn't upload this lap's video: your video storage is full.", LapVideoText.failure("clip storage full"))
        assertEquals("Couldn't upload this lap's video: saving lap videos needs Pro.", LapVideoText.failure("pro required"))
        assertEquals("Couldn't upload this lap's video.", LapVideoText.failure("session lost"))
        assertEquals("Couldn't upload this lap's video.", LapVideoText.failure("too many restarts"))
    }

    @Test
    fun `a job matches by session and lap time, through the id map for a session saved offline`() {
        assertEquals(LapVideoState.None, of(without, jobs = listOf(job(timeMs = 99_999))))
        assertEquals(LapVideoState.None, of(without, jobs = listOf(job(sessionId = 502))))
        assertEquals(LapVideoState.None, of(without, jobs = listOf(job(sessionId = -3))))
        assertEquals(uploading, of(without, jobs = listOf(job(sessionId = -3)), resolve = { if (it == -3) 501 else null }))
    }

    @Test
    fun `a pending upload shows on the lowest lap number with its time, never on a lap tied with it`() {
        val tied = without.copy(id = 44, lapNum = 9)
        val laps = listOf(tied, without)
        assertEquals(uploading, of(without, jobs = listOf(job()), sessionLaps = laps))
        assertEquals(LapVideoState.None, of(tied, jobs = listOf(job()), sessionLaps = laps))
    }

    @Test
    fun `nothing at all for a lap with no clip and no job, and never a pending state for a coach`() {
        assertEquals(LapVideoState.None, of(without))
        assertEquals(LapVideoState.None, of(without, owner = proStudent, jobs = listOf(job())))
    }
}
