package app.trackevolution.core.clips

import app.trackevolution.core.api.ApiException
import app.trackevolution.core.clips.ClipUploadQueue.Outcome
import app.trackevolution.core.model.ClipCreate
import app.trackevolution.core.model.ClipUpload
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

/**
 * Every transition of the clip upload (NS-45) against a fake server that
 * behaves like `src/routes/clips.ts`: parts of `part_bytes`, the last the
 * remainder; a create that resumes with the parts it holds; 409s that never
 * change. The manifest is a real file in a temp directory, so "resumes after
 * the worker was killed" is asserted against what a new process would read.
 */
class ClipUploadQueueTest {

    @TempDir
    lateinit var dir: File

    /** A server in miniature: one clip row per session, parts by number. */
    private inner class FakeServer : ClipUploadQueue.Transport {
        var partBytes = 10L
        val creates = mutableListOf<Pair<Int, ClipCreate>>()
        val parts = sortedMapOf<Int, Long>()
        val calls = mutableListOf<String>()
        var clipId = 77
        var completed = false
        var createError: ApiException? = null
        var partError: (Int) -> ApiException? = { null }
        var completeError: ApiException? = null

        override suspend fun create(sessionId: Int, body: ClipCreate): ClipUpload {
            calls += "create $sessionId"
            createError?.let { throw it }
            creates += sessionId to body
            val count = ((body.sizeBytes + partBytes - 1) / partBytes).toInt()
            return ClipUpload(clipId = clipId, partBytes = partBytes, parts = count, uploaded = parts.keys.toList())
        }

        override suspend fun uploadPart(clipId: Int, partNumber: Int, file: File, offset: Long, length: Long) {
            calls += "part $partNumber"
            partError(partNumber)?.let { throw it }
            assertEquals(this.clipId, clipId)
            assertTrue(offset + length <= file.length(), "a part never reads past the file")
            parts[partNumber] = length
        }

        override suspend fun complete(clipId: Int) {
            calls += "complete"
            completeError?.let { throw it }
            completed = true
        }
    }

    private class FakeIds(var map: Map<Int, Int> = emptyMap(), var pending: Int = 0) : ClipUploadQueue.TempIds {
        override suspend fun resolve(tempId: Int): Int? = map[tempId]
        override suspend fun pendingWrites(): Int = pending
    }

    private val server = FakeServer()
    private val ids = FakeIds()

    private fun clipFile(name: String = "a.mp4", size: Int = 25): File =
        File(dir, name).apply { writeBytes(ByteArray(size) { it.toByte() }) }

    private fun job(file: File? = clipFile(), sessionId: Int = 501, eventId: Int = 7, state: ClipJob.State = ClipJob.State.PENDING) = ClipJob(
        id = "job-1",
        sessionId = sessionId,
        eventId = eventId,
        timeMs = 47_124,
        file = file?.path,
        sizeBytes = file?.length() ?: 0,
        durationMs = 52_124,
        lapOffsetMs = 3_000,
        state = state,
        createdAt = 1_000,
    )

    private fun queue(manifest: ClipManifest) = ClipUploadQueue(manifest, server, ids)

    @Test
    fun `create, every part, complete — then the job and its file are gone`() = runTest {
        val manifest = ClipManifest(dir)
        val j = job()
        manifest.put(j)

        assertEquals(Outcome.Done, queue(manifest).run(j.id))

        assertEquals(listOf("create 501", "part 1", "part 2", "part 3", "complete"), server.calls)
        assertEquals(ClipCreate(timeMs = 47_124, sizeBytes = 25, durationMs = 52_124, lapOffsetMs = 3_000), server.creates.single().second)
        assertEquals(mapOf(1 to 10L, 2 to 10L, 3 to 5L), server.parts, "every part is part_bytes long but the last")
        assertTrue(manifest.all().isEmpty())
        assertFalse(File(j.file!!).exists(), "the local file is deleted after complete")
    }

    @Test
    fun `resumes from the server's uploaded list, and a new process reads the progress`() = runTest {
        val manifest = ClipManifest(dir)
        val j = job()
        manifest.put(j)
        server.partError = { n -> if (n == 2) ApiException.Transport("connection reset") else null }

        assertEquals(Outcome.Retry("connection reset"), queue(manifest).run(j.id))
        val reread = ClipManifest(dir).get(j.id)!!
        assertEquals(listOf(1), reread.uploaded, "part 1 landed and is recorded on disk")
        assertEquals(77, reread.clipId)
        assertEquals(0, reread.attempts, "a transport failure doesn't count")

        server.partError = { null }
        server.calls.clear()
        assertEquals(Outcome.Done, queue(ClipManifest(dir)).run(j.id))
        assertEquals(listOf("create 501", "part 2", "part 3", "complete"), server.calls, "part 1 is not sent twice")
    }

    @Test
    fun `waits while its session is a temp id, then maps it through the id map`() = runTest {
        val manifest = ClipManifest(dir)
        val j = job(sessionId = -3, eventId = -2)
        manifest.put(j)
        ids.pending = 2

        assertEquals(Outcome.Waiting, queue(manifest).run(j.id))
        assertTrue(server.calls.isEmpty(), "nothing is sent for a session the server hasn't seen")
        assertTrue(File(j.file!!).exists())

        ids.map = mapOf(-3 to 812, -2 to 40)
        ids.pending = 0
        assertEquals(Outcome.Done, queue(manifest).run(j.id))
        assertEquals(812, server.creates.single().first)
    }

    @Test
    fun `a temp session whose create is gone from an empty queue is dropped`() = runTest {
        val manifest = ClipManifest(dir)
        val j = job(sessionId = -3)
        manifest.put(j)
        ids.pending = 0

        assertEquals(Outcome.Dropped("the session was never saved"), queue(manifest).run(j.id))
        assertNull(manifest.get(j.id))
        assertFalse(File(j.file!!).exists())
    }

    @Test
    fun `storage full and already has a clip drop the job and delete the file`() = runTest {
        for (message in listOf("clip storage full", "lap already has a clip")) {
            val manifest = ClipManifest(dir)
            val j = job(clipFile("c.mp4"))
            manifest.put(j)
            server.createError = ApiException.Server(409, message)
            assertEquals(Outcome.Dropped(message), queue(manifest).run(j.id))
            assertNull(manifest.get(j.id))
            assertFalse(File(j.file!!).exists(), "$message: the file goes too")
        }
    }

    @Test
    fun `a lapse, a deleted session and a refused body are dropped too`() = runTest {
        for (error in listOf(ApiException.PaymentRequired("pro required"), ApiException.Server(404, "not found"), ApiException.Server(400, "clip too long"))) {
            val manifest = ClipManifest(dir)
            val j = job(clipFile("d.mp4"))
            manifest.put(j)
            server.createError = error
            assertTrue(queue(manifest).run(j.id) is Outcome.Dropped, error.message)
        }
    }

    @Test
    fun `transport failures and 5xx back off, and 5xx counts and gives up`() = runTest {
        val manifest = ClipManifest(dir)
        val j = job()
        manifest.put(j)

        server.createError = ApiException.Transport("offline")
        repeat(20) { assertEquals(Outcome.Retry("offline"), queue(manifest).run(j.id)) }
        assertEquals(0, manifest.get(j.id)!!.attempts)

        server.createError = ApiException.Server(503, "busy")
        repeat(ClipUploadQueue.MAX_ATTEMPTS - 1) { assertEquals(Outcome.Retry("busy"), queue(manifest).run(j.id)) }
        assertEquals(Outcome.Dropped("busy"), queue(manifest).run(j.id))
        assertNull(manifest.get(j.id))
    }

    @Test
    fun `a clip row gone mid-upload restarts with a fresh create`() = runTest {
        val manifest = ClipManifest(dir)
        val j = job()
        manifest.put(j)
        server.partError = { n -> if (n == 1) ApiException.Server(404, "not found") else null }

        assertEquals(Outcome.Retry("not found"), queue(manifest).run(j.id))
        assertNull(manifest.get(j.id)!!.clipId, "the dead row is forgotten")

        server.partError = { null }
        assertEquals(Outcome.Done, queue(manifest).run(j.id))
    }

    @Test
    fun `missing parts at complete retry, and the next create says which`() = runTest {
        val manifest = ClipManifest(dir)
        val j = job()
        manifest.put(j)
        server.completeError = ApiException.Server(409, "missing parts")
        assertEquals(Outcome.Retry("missing parts"), queue(manifest).run(j.id))

        // The server lost part 2.
        server.parts.remove(2)
        server.completeError = null
        server.calls.clear()
        assertEquals(Outcome.Done, queue(manifest).run(j.id))
        assertEquals(listOf("create 501", "part 2", "complete"), server.calls)
    }

    @Test
    fun `a part already uploaded goes straight to complete`() = runTest {
        val manifest = ClipManifest(dir)
        val j = job()
        manifest.put(j)
        server.partError = { ApiException.Server(409, "clip already uploaded") }
        assertEquals(Outcome.Done, queue(manifest).run(j.id))
        assertEquals("complete", server.calls.last())
    }

    @Test
    fun `a missing or resized file is a dead job`() = runTest {
        val manifest = ClipManifest(dir)
        val f = clipFile("gone.mp4")
        val j = job(f)
        manifest.put(j)
        f.delete()
        assertEquals(Outcome.Dropped("the cut clip is missing"), queue(manifest).run(j.id))

        val g = clipFile("short.mp4")
        manifest.put(job(g).copy(sizeBytes = 999))
        assertTrue(queue(manifest).run("job-1") is Outcome.Dropped)
        assertTrue(server.calls.isEmpty())
    }

    @Test
    fun `a job still cutting, or a failed cut, is not uploaded and stays to be said`() = runTest {
        val manifest = ClipManifest(dir)
        manifest.put(job(file = null, state = ClipJob.State.CUTTING))
        assertEquals(Outcome.Skipped, queue(manifest).run("job-1"))
        manifest.put(job(file = null, state = ClipJob.State.CUT_FAILED))
        assertEquals(Outcome.Skipped, queue(manifest).run("job-1"))
        assertEquals(ClipJob.State.CUT_FAILED, manifest.get("job-1")!!.state)
        assertEquals(Outcome.Skipped, queue(manifest).run("no-such-job"))
    }

    @Test
    fun `a process death mid-cut leaves a failed cut, and stray clips are swept`() {
        val manifest = ClipManifest(dir)
        manifest.put(job(file = null, state = ClipJob.State.CUTTING))
        val stray = clipFile("stray.mp4")
        val kept = clipFile("kept.mp4")
        manifest.put(job(kept).copy(id = "job-2"))

        val next = ClipManifest(dir)
        next.recoverInterrupted()
        assertEquals(ClipJob.State.CUT_FAILED, next.get("job-1")!!.state)
        assertFalse(stray.exists(), "a clip no job names is deleted")
        assertTrue(kept.exists())

        next.prune(nowMs = 1_000 + ClipManifest.FAILED_KEPT_MS + 1)
        assertNull(next.get("job-1"), "a failed cut is said for a week, then forgotten")
        assertTrue(next.get("job-2") != null, "a pending upload is never pruned")
    }

    @Test
    fun `clear forgets every job and clip`() {
        val manifest = ClipManifest(dir)
        val f = clipFile()
        manifest.put(job(f))
        manifest.clear()
        assertTrue(ClipManifest(dir).all().isEmpty())
        assertFalse(f.exists())
    }
}
