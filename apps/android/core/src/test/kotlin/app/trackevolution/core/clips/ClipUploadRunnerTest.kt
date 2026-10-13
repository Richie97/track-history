package app.trackevolution.core.clips

import app.trackevolution.core.api.ApiException
import app.trackevolution.core.api.ClipMissingParts
import app.trackevolution.core.clips.ClipUploadQueue.DropReason
import app.trackevolution.core.clips.ClipUploadRunner.Outcome
import app.trackevolution.core.model.ClipCreate
import app.trackevolution.core.model.ClipUpload
import app.trackevolution.core.offline.OfflineStore
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

/**
 * [ClipUploadRunner] driving [ClipUploadQueue] (NS-45) against a fake server
 * that behaves like `src/routes/clips.ts`: parts of `part_bytes`, the last the
 * remainder; a create that resumes with the parts it holds. The manifest is a
 * real file in a temp directory, so "resumes after the worker was killed" is
 * asserted against what a new process would read. The transitions themselves
 * are `ClipUploadQueueTest`'s; this pins the loop around them.
 */
class ClipUploadRunnerTest {

    @TempDir
    lateinit var dir: File

    /** A server in miniature: one clip row, parts by number. */
    private inner class FakeServer : ClipUploadRunner.Transport {
        var partBytes = 10L
        val creates = mutableListOf<Pair<Int, ClipCreate>>()
        val parts = sortedMapOf<Int, Long>()
        val calls = mutableListOf<String>()
        var clipId = 77
        var createError: Exception? = null
        var partError: (Int) -> Exception? = { null }
        val completeErrors = ArrayDeque<Exception>()

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
            completeErrors.removeFirstOrNull()?.let { throw it }
        }
    }

    private class FakeIds(var map: Map<Int, Int> = emptyMap(), var queued: Set<Int> = emptySet()) : ClipUploadRunner.TempIds {
        override suspend fun state(tempId: Int) = OfflineStore.TempIdState(mapped = map[tempId], queued = tempId in queued)
    }

    private val server = FakeServer()
    private val ids = FakeIds()
    private var clock = 1_800_000_000_000L

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

    private fun runner(manifest: ClipManifest) = ClipUploadRunner(manifest, server, ids, now = { clock })

    @Test
    fun `create, every part, complete — then the job and its file are gone`() = runTest {
        val manifest = ClipManifest(dir)
        val j = job()
        manifest.put(j)

        assertEquals(Outcome.Done, runner(manifest).run(j.id))

        assertEquals(listOf("create 501", "part 1", "part 2", "part 3", "complete"), server.calls)
        assertEquals(ClipCreate(timeMs = 47_124, sizeBytes = 25, durationMs = 52_124, lapOffsetMs = 3_000), server.creates.single().second)
        assertEquals(mapOf(1 to 10L, 2 to 10L, 3 to 5L), server.parts, "every part is part_bytes long but the last")
        assertTrue(manifest.all().isEmpty())
        assertFalse(File(j.file!!).exists(), "the local file is deleted after complete")
    }

    @Test
    fun `a failure backs off and a new process resumes at the next part`() = runTest {
        val manifest = ClipManifest(dir)
        val j = job()
        manifest.put(j)
        server.partError = { n -> if (n == 2) ApiException.Transport("connection reset") else null }

        assertEquals(Outcome.WaitUntil(clock + 30_000), runner(manifest).run(j.id))
        val reread = ClipManifest(dir).get(j.id)!!
        assertEquals(listOf(1), reread.uploaded, "part 1 landed and is recorded on disk")
        assertEquals(77, reread.clipId)
        assertEquals(1, reread.failures)

        // Inside the backoff nothing is sent.
        server.partError = { null }
        server.calls.clear()
        assertEquals(Outcome.WaitUntil(clock + 30_000), runner(ClipManifest(dir)).run(j.id))
        assertTrue(server.calls.isEmpty())

        clock += 30_000
        assertEquals(Outcome.Done, runner(ClipManifest(dir)).run(j.id))
        assertEquals(listOf("part 2", "part 3", "complete"), server.calls, "the held clip id resumes without a create, and part 1 isn't sent twice")
    }

    @Test
    fun `waits while its session is a temp id, then maps it through the id map`() = runTest {
        val manifest = ClipManifest(dir)
        val j = job(sessionId = -3, eventId = -2)
        manifest.put(j)
        ids.queued = setOf(-3, -2)

        assertEquals(Outcome.WaitForSession, runner(manifest).run(j.id))
        assertTrue(server.calls.isEmpty(), "nothing is sent for a session the server hasn't seen")
        assertTrue(File(j.file!!).exists())

        ids.map = mapOf(-3 to 812, -2 to 40)
        ids.queued = emptySet()
        assertEquals(Outcome.Done, runner(manifest).run(j.id))
        assertEquals(812, server.creates.single().first)
    }

    @Test
    fun `a temp session whose create is gone and never mapped is dropped`() = runTest {
        val manifest = ClipManifest(dir)
        val j = job(sessionId = -3)
        manifest.put(j)

        assertEquals(Outcome.Dropped(DropReason.SESSION_LOST), runner(manifest).run(j.id))
        assertNull(manifest.get(j.id))
        assertFalse(File(j.file!!).exists())
    }

    @Test
    fun `storage full and already has a clip drop the job and delete the file`() = runTest {
        for ((message, reason) in listOf("clip storage full" to DropReason.STORAGE_FULL, "lap already has a clip" to DropReason.ALREADY_HAS_CLIP)) {
            val manifest = ClipManifest(dir)
            val j = job(clipFile("c.mp4"))
            manifest.put(j)
            server.createError = ApiException.Server(409, message)
            assertEquals(Outcome.Dropped(reason), runner(manifest).run(j.id))
            assertNull(manifest.get(j.id))
            assertFalse(File(j.file!!).exists(), "$message: the file goes too")
        }
    }

    @Test
    fun `transport failures and 5xx back off up to an hour and never drop`() = runTest {
        val manifest = ClipManifest(dir)
        manifest.put(job())
        val waits = mutableListOf<Long>()
        for (error in List(10) { if (it % 2 == 0) ApiException.Transport("offline") else ApiException.Server(503, "busy") }) {
            server.createError = error
            val outcome = runner(manifest).run("job-1") as Outcome.WaitUntil
            waits += outcome.ms - clock
            clock = outcome.ms
        }
        assertEquals(
            listOf(30_000L, 60_000L, 120_000L, 240_000L, 480_000L, 960_000L, 1_920_000L, 3_600_000L, 3_600_000L, 3_600_000L),
            waits,
        )
        server.createError = null
        assertEquals(Outcome.Done, runner(manifest).run("job-1"))
    }

    @Test
    fun `a clip row gone mid-upload restarts with a fresh create`() = runTest {
        val manifest = ClipManifest(dir)
        manifest.put(job())
        var lost = true
        server.partError = { n -> if (n == 1 && lost) ApiException.Server(404, "not found").also { lost = false } else null }

        assertEquals(Outcome.Done, runner(manifest).run("job-1"))
        assertEquals(listOf("create 501", "part 1", "create 501", "part 1", "part 2", "part 3", "complete"), server.calls)
    }

    @Test
    fun `missing parts at complete sends exactly those again`() = runTest {
        val manifest = ClipManifest(dir)
        manifest.put(job())
        server.completeErrors += ClipMissingParts(listOf(2))

        assertEquals(Outcome.Done, runner(manifest).run("job-1"))
        assertEquals(listOf("create 501", "part 1", "part 2", "part 3", "complete", "part 2", "complete"), server.calls)
    }

    @Test
    fun `a part already uploaded goes straight to complete`() = runTest {
        val manifest = ClipManifest(dir)
        manifest.put(job())
        server.partError = { ApiException.Server(409, "clip already uploaded") }
        assertEquals(Outcome.Done, runner(manifest).run("job-1"))
        assertEquals(listOf("create 501", "part 1", "complete"), server.calls)
    }

    @Test
    fun `a missing or resized file is a dead job`() = runTest {
        val manifest = ClipManifest(dir)
        val f = clipFile("gone.mp4")
        manifest.put(job(f))
        f.delete()
        assertEquals(Outcome.Dropped(DropReason.REFUSED), runner(manifest).run("job-1"))

        val g = clipFile("short.mp4")
        manifest.put(job(g).copy(sizeBytes = 999))
        assertEquals(Outcome.Dropped(DropReason.REFUSED), runner(manifest).run("job-1"))
        assertTrue(server.calls.isEmpty())
    }

    @Test
    fun `answers that came back as exceptions read as iOS reads them`() {
        assertEquals(ClipUploadQueue.Response.Transport, ClipUploadRunner.response(ApiException.Transport("gone")))
        assertEquals(ClipUploadQueue.Response.Transport, ClipUploadRunner.response(ApiException.Decoding("bad")))
        assertEquals(ClipUploadQueue.Response.Transport, ClipUploadRunner.response(IllegalStateException("?")))
        assertEquals(ClipUploadQueue.Response.Status(403, "This logbook is read-only."), ClipUploadRunner.response(ApiException.ReadOnly()))
        assertEquals(ClipUploadQueue.Response.Status(401, "unauthorized"), ClipUploadRunner.response(ApiException.Unauthorized("unauthorized")))
        assertEquals(ClipUploadQueue.Response.MissingParts(listOf(1, 3)), ClipUploadRunner.response(ClipMissingParts(listOf(1, 3))))
    }

    @Test
    fun `a job still cutting, or a failed cut, is not uploaded and stays to be said`() = runTest {
        val manifest = ClipManifest(dir)
        manifest.put(job(file = null, state = ClipJob.State.CUTTING))
        assertEquals(Outcome.Skipped, runner(manifest).run("job-1"))
        manifest.put(job(file = null, state = ClipJob.State.CUT_FAILED))
        assertEquals(Outcome.Skipped, runner(manifest).run("job-1"))
        assertEquals(ClipJob.State.CUT_FAILED, manifest.get("job-1")!!.state)
        assertEquals(Outcome.Skipped, runner(manifest).run("no-such-job"))
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
