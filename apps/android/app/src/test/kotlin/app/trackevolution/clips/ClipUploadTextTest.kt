package app.trackevolution.clips

import app.trackevolution.core.clips.ClipJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The upload notification's one line over every clip on its way (NS-50). */
class ClipUploadTextTest {
    private fun job(id: String, state: ClipJob.State = ClipJob.State.PENDING, size: Long = 0, uploaded: List<Int> = emptyList()) =
        ClipJob(
            id = id,
            sessionId = 501,
            eventId = 7,
            timeMs = 100_000,
            sizeBytes = size,
            clipId = if (size > 0) 1 else null,
            partBytes = if (size > 0) 100 else null,
            parts = if (size > 0) ((size + 99) / 100).toInt() else null,
            uploaded = uploaded,
            state = state,
            createdAt = 0,
        )

    @Test
    fun `one job keeps NS-45's title`() {
        assertNull(ClipUploadText.notificationTitle(emptyList(), emptyMap()))
        assertNull(ClipUploadText.notificationTitle(listOf(job("a", size = 100)), emptyMap()))
        // A failure isn't on its way: it doesn't count.
        assertNull(ClipUploadText.notificationTitle(listOf(job("a", size = 100), job("b", ClipJob.State.DROPPED)), emptyMap()))
    }

    @Test
    fun `several jobs are one line, weighted by bytes`() {
        val jobs = listOf(
            job("a", size = 100, uploaded = listOf(1)),
            job("b", size = 300),
            job("c", ClipJob.State.CUTTING),
            job("d", ClipJob.State.CUT_FAILED),
        )
        assertEquals("Saving 3 lap videos · 25%", ClipUploadText.notificationTitle(jobs, emptyMap()))
        // The part in flight counts as it goes: 100 + 50 of 400.
        assertEquals("Saving 3 lap videos · 37%", ClipUploadText.notificationTitle(jobs, mapOf("b" to 50L)))
        assertEquals(
            "Saving 2 lap videos…",
            ClipUploadText.notificationTitle(listOf(job("a", ClipJob.State.CUTTING), job("b", ClipJob.State.CUTTING)), emptyMap()),
        )
    }
}
