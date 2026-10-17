package app.trackevolution.core

import app.trackevolution.core.model.EventDetail
import app.trackevolution.core.model.Me
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Best-lap video metadata (NS-45) as the goldens pin it: a lap's `clip` as an
 * object and as a null on the same event, the coach's cut without
 * `size_bytes`, and `user.clips` on `/me`. The strict decode in
 * [GoldenContractTest] is what makes the models carry the fields at all; this
 * checks they land where the screens will read them — and the clip's YouTube
 * upload (NS-46) as an object and as a null, and never on a coach's cut.
 */
class LapClipGoldenTest {

    @Test
    fun `the event detail carries two clips and nulls`() {
        val laps = Goldens.decode("event-detail", EventDetail.serializer()).sessions.flatMap { it.laps }
        val clipped = laps.filter { it.clip != null }
        assertEquals(2, clipped.size, "the fixture saves two clips: the rich event's best lap and another session's")
        assertTrue(laps.size > clipped.size, "and the other laps carry null")
        val best = laps.minBy { it.timeMs }
        assertEquals(3000, best.clip?.lapOffsetMs)
        assertEquals(2048L, best.clip?.sizeBytes)
        // The best lap's clip is on YouTube; the other's is not.
        val youtube = best.clip?.youtube
        assertNotNull(youtube)
        assertEquals("done", youtube!!.status)
        assertEquals("unlisted", youtube.privacy)
        assertEquals("https://youtu.be/${youtube.videoId}", youtube.url)
        // Ids are normalized to 1 in the goldens, so the other clip is told apart by its lap time.
        assertNull(clipped.first { it.timeMs != best.timeMs }.clip!!.youtube)
    }

    @Test
    fun `a coach sees the clip without its size`() {
        val laps = Goldens.decode("student-event-detail", EventDetail.serializer()).sessions.flatMap { it.laps }
        val clip = laps.firstNotNullOfOrNull { it.clip }
        assertNotNull(clip)
        assertNull(clip!!.sizeBytes, "size_bytes is the student's bookkeeping (COACH_CLIP_FIELDS)")
        assertNull(clip.youtube, "the YouTube link is the driver's to hand out (NS-46)")
        assertTrue(clip.durationMs > clip.lapOffsetMs)
    }

    @Test
    fun `me carries the YouTube connection`() {
        val fresh = Goldens.decode("me", Me.serializer()).user.youtube
        assertNotNull(fresh)
        assertTrue(fresh!!.available && !fresh.connected && fresh.account == null)
        val connected = Goldens.decode("me-pro-legacy", Me.serializer()).user.youtube
        assertNotNull(connected)
        assertTrue(connected!!.connected && connected.account != null && connected.channelTitle != null)
    }

    @Test
    fun `me carries storage`() {
        val clips = Goldens.decode("me-pro-legacy", Me.serializer()).user.clips
        assertNotNull(clips)
        assertEquals(2048L, clips!!.usedBytes)
        assertEquals(20L * 1024 * 1024 * 1024, clips.quotaBytes)
        assertEquals(0, clips.coachCount)
    }
}
