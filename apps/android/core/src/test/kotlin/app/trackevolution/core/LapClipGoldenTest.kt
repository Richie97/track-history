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
 * checks they land where the screens will read them.
 */
class LapClipGoldenTest {

    @Test
    fun `the event detail carries one clip and nulls`() {
        val laps = Goldens.decode("event-detail", EventDetail.serializer()).sessions.flatMap { it.laps }
        val clipped = laps.filter { it.clip != null }
        assertEquals(1, clipped.size, "the fixture saves one clip, on the rich event's best lap")
        assertTrue(laps.size > clipped.size, "and the other laps carry null")
        val best = laps.minBy { it.timeMs }
        assertEquals(3000, best.clip?.lapOffsetMs)
        assertEquals(2048L, best.clip?.sizeBytes)
    }

    @Test
    fun `a coach sees the clip without its size`() {
        val laps = Goldens.decode("student-event-detail", EventDetail.serializer()).sessions.flatMap { it.laps }
        val clip = laps.firstNotNullOfOrNull { it.clip }
        assertNotNull(clip)
        assertNull(clip!!.sizeBytes, "size_bytes is the student's bookkeeping (COACH_CLIP_FIELDS)")
        assertTrue(clip.durationMs > clip.lapOffsetMs)
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
