package app.trackevolution.core.clips

import app.trackevolution.core.RepoRoot
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.clips.ClipUploadQueue.Action
import app.trackevolution.core.clips.ClipUploadQueue.DropReason
import app.trackevolution.core.clips.ClipUploadQueue.Outcome
import app.trackevolution.core.clips.ClipUploadQueue.Response
import app.trackevolution.core.clips.ClipUploadQueue.SessionState
import app.trackevolution.core.model.ClipCreate
import app.trackevolution.core.model.ClipUpload
import app.trackevolution.core.model.Lap
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The clip uploader's state machine (NS-45): iOS's `ClipUploadQueueTests`,
 * ported one for one under the same names. Every row of the transition table
 * on [ClipUploadQueue] is a test here and there, so a change to one platform's
 * table fails the other's tests until it is made there too.
 */
class ClipUploadQueueTest {
    private companion object {
        const val MiB = 1024L * 1024
        const val NOW = 1_800_000_000_000L

        /** A 120 MiB clip: three parts of 50, 50 and 20 MiB. */
        fun job(sessionId: Int = 42) = ClipJob(
            id = "job-1",
            sessionId = sessionId,
            eventId = 7,
            timeMs = 121_345,
            file = "job-1.mp4",
            sizeBytes = 120 * MiB,
            durationMs = 126_400,
            lapOffsetMs = 3_317,
            state = ClipJob.State.PENDING,
            createdAt = NOW,
        )

        /** The job once its create answered. */
        fun started(uploaded: List<Int> = emptyList()): ClipJob {
            val outcome = ClipUploadQueue.apply(
                job(),
                Action.Create(42, job().createBody),
                Response.Created(ClipUpload(clipId = 7, partBytes = 50 * MiB, parts = 3, uploaded = uploaded)),
                NOW,
            )
            return (outcome as Outcome.Continue).job
        }

        fun continued(outcome: Outcome): ClipJob {
            assertTrue(outcome is Outcome.Continue, "should continue: $outcome")
            return (outcome as Outcome.Continue).job
        }
    }

    // ---- The session ------------------------------------------------------

    @Test
    fun `a real session id is used as is`() {
        assertEquals(SessionState.Real(42), ClipUploadQueue.sessionState(42, mapped = null, queued = false))
    }

    @Test
    fun `a temp session id waits while its create is queued`() {
        assertEquals(SessionState.Waiting, ClipUploadQueue.sessionState(-3, mapped = null, queued = true))
        assertEquals(Action.WaitForSession, ClipUploadQueue.nextAction(job(sessionId = -3), SessionState.Waiting, NOW))
    }

    @Test
    fun `a temp session id maps to the real one once flushed`() {
        assertEquals(SessionState.Real(42), ClipUploadQueue.sessionState(-3, mapped = 42, queued = false))
        assertEquals(
            Action.Create(42, job().createBody),
            ClipUploadQueue.nextAction(job(sessionId = -3), SessionState.Real(42), NOW),
        )
    }

    @Test
    fun `a temp session the server refused drops the job`() {
        assertEquals(SessionState.Lost, ClipUploadQueue.sessionState(-3, mapped = null, queued = false))
        assertEquals(Action.Drop(DropReason.SESSION_LOST), ClipUploadQueue.nextAction(job(sessionId = -3), SessionState.Lost, NOW))
    }

    // ---- Create -----------------------------------------------------------

    @Test
    fun `a fresh job starts with the create`() {
        val body = job().createBody
        assertEquals(ClipCreate(timeMs = 121_345, sizeBytes = 120 * MiB, durationMs = 126_400, lapOffsetMs = 3_317), body)
        assertEquals(Action.Create(42, body), ClipUploadQueue.nextAction(job(), SessionState.Real(42), NOW))
    }

    @Test
    fun `the create answer sets up the parts and the first part follows`() {
        val job = started()
        assertEquals(7, job.clipId)
        assertEquals(50 * MiB, job.partBytes)
        assertEquals(3, job.parts)
        assertEquals(emptyList<Int>(), job.uploaded)
        assertEquals(Action.UploadPart(7, 1, 0, 50 * MiB), ClipUploadQueue.nextAction(job, SessionState.Real(42), NOW))
    }

    @Test
    fun `a resumed create picks up after the parts the server holds`() {
        val job = started(uploaded = listOf(2, 1, 9))
        assertEquals(listOf(1, 2), job.uploaded, "a part number past the count is ignored")
        assertEquals(Action.UploadPart(7, 3, 100 * MiB, 20 * MiB), ClipUploadQueue.nextAction(job, SessionState.Real(42), NOW))
    }

    @Test
    fun `storage full and already has a clip drop the job`() {
        val create = Action.Create(42, job().createBody)
        assertEquals(Outcome.Dropped(DropReason.STORAGE_FULL), ClipUploadQueue.apply(job(), create, Response.Status(409, "clip storage full"), NOW))
        assertEquals(Outcome.Dropped(DropReason.ALREADY_HAS_CLIP), ClipUploadQueue.apply(job(), create, Response.Status(409, "lap already has a clip"), NOW))
    }

    @Test
    fun `a create refused for any other reason drops the job`() {
        val create = Action.Create(42, job().createBody)
        assertEquals(Outcome.Dropped(DropReason.PRO_REQUIRED), ClipUploadQueue.apply(job(), create, Response.Status(402, "pro required"), NOW))
        assertEquals(Outcome.Dropped(DropReason.NOT_FOUND), ClipUploadQueue.apply(job(), create, Response.Status(404, "not found"), NOW))
        assertEquals(Outcome.Dropped(DropReason.REFUSED), ClipUploadQueue.apply(job(), create, Response.Status(400, "clip too long"), NOW))
    }

    // ---- Parts ------------------------------------------------------------

    @Test
    fun `a part uploaded moves to the next`() {
        val action = Action.UploadPart(7, 1, 0, 50 * MiB)
        val job = continued(ClipUploadQueue.apply(started(), action, Response.Ok, NOW))
        assertEquals(listOf(1), job.uploaded)
        assertEquals(Action.UploadPart(7, 2, 50 * MiB, 50 * MiB), ClipUploadQueue.nextAction(job, SessionState.Real(42), NOW))
    }

    @Test
    fun `every part held means complete`() {
        assertEquals(Action.Complete(7), ClipUploadQueue.nextAction(started(uploaded = listOf(1, 2, 3)), SessionState.Real(42), NOW))
    }

    @Test
    fun `a part refused because the clip is already ready goes to complete`() {
        val action = Action.UploadPart(7, 1, 0, 50 * MiB)
        val job = continued(ClipUploadQueue.apply(started(), action, Response.Status(409, "clip already uploaded"), NOW))
        assertEquals(Action.Complete(7), ClipUploadQueue.nextAction(job, SessionState.Real(42), NOW))
    }

    @Test
    fun `a part of the wrong size drops the job`() {
        val action = Action.UploadPart(7, 1, 0, 50 * MiB)
        assertEquals(Outcome.Dropped(DropReason.REFUSED), ClipUploadQueue.apply(started(), action, Response.Status(400, "part 1 must be …"), NOW))
        assertEquals(Outcome.Dropped(DropReason.REFUSED), ClipUploadQueue.apply(started(), action, Response.Status(411, null), NOW))
    }

    @Test
    fun `a part the server lost restarts from the create and gives up eventually`() {
        val action = Action.UploadPart(7, 2, 50 * MiB, 50 * MiB)
        var job = started(uploaded = listOf(1))
        for (restart in 1..ClipUploadQueue.MAX_RESTARTS) {
            val next = continued(ClipUploadQueue.apply(job, action, Response.Status(404, "not found"), NOW))
            assertTrue(next.clipId == null && next.uploaded.isEmpty() && next.restarts == restart, "restart $restart")
            assertEquals(Action.Create(42, next.createBody), ClipUploadQueue.nextAction(next, SessionState.Real(42), NOW))
            job = next.copy(clipId = 7, partBytes = 50 * MiB, parts = 3)
        }
        assertEquals(Outcome.Dropped(DropReason.TOO_MANY_RESTARTS), ClipUploadQueue.apply(job, action, Response.Status(404, "not found"), NOW))
    }

    // ---- Complete ---------------------------------------------------------

    @Test
    fun `complete finishes the job`() {
        assertEquals(Outcome.Finished, ClipUploadQueue.apply(started(uploaded = listOf(1, 2, 3)), Action.Complete(7), Response.Ok, NOW))
    }

    @Test
    fun `complete missing parts sends exactly those again`() {
        val job = continued(ClipUploadQueue.apply(started(uploaded = listOf(1, 2, 3)), Action.Complete(7), Response.MissingParts(listOf(2)), NOW))
        assertEquals(listOf(1, 3), job.uploaded)
        assertEquals(Action.UploadPart(7, 2, 50 * MiB, 50 * MiB), ClipUploadQueue.nextAction(job, SessionState.Real(42), NOW))
    }

    @Test
    fun `complete on a lost upload restarts`() {
        val job = continued(ClipUploadQueue.apply(started(uploaded = listOf(1, 2, 3)), Action.Complete(7), Response.Status(404, "not found"), NOW))
        assertTrue(job.clipId == null && job.restarts == 1)
    }

    // ---- Backoff ----------------------------------------------------------

    @Test
    fun `transport failures and server errors back off and never drop`() {
        val action = Action.UploadPart(7, 1, 0, 50 * MiB)
        var job = started()
        val waits = mutableListOf<Long>()
        for (response in listOf(Response.Transport, Response.Status(503, null), Response.Status(429, null), Response.Status(401, null), Response.Transport)) {
            val next = continued(ClipUploadQueue.apply(job, action, response, NOW))
            waits += next.notBeforeMs!! - NOW
            job = next
        }
        assertEquals(listOf(30_000L, 60_000L, 120_000L, 240_000L, 480_000L), waits)
        assertEquals(Action.WaitUntil(NOW + 480_000), ClipUploadQueue.nextAction(job, SessionState.Real(42), NOW))
        assertEquals(Action.UploadPart(7, 1, 0, 50 * MiB), ClipUploadQueue.nextAction(job, SessionState.Real(42), NOW + 480_000))
        val recovered = continued(ClipUploadQueue.apply(job, action, Response.Ok, NOW + 480_000))
        assertTrue(recovered.failures == 0 && recovered.notBeforeMs == null)
    }

    @Test
    fun `the backoff is capped at an hour`() {
        assertEquals(0L, ClipUploadQueue.backoffMs(0))
        assertEquals(30_000L, ClipUploadQueue.backoffMs(1))
        assertEquals(3_600_000L, ClipUploadQueue.backoffMs(8))
        assertEquals(3_600_000L, ClipUploadQueue.backoffMs(500))
    }

    @Test
    fun `a temp session waits even during a backoff`() {
        val job = job(sessionId = -3).copy(notBeforeMs = NOW + 10_000)
        assertEquals(Action.WaitForSession, ClipUploadQueue.nextAction(job, SessionState.Waiting, NOW))
    }

    // ---- Part geometry ----------------------------------------------------

    @Test
    fun `part ranges match the server's part size`() {
        val size = 120 * MiB
        val part = 50 * MiB
        assertEquals(0L to part, ClipUploadQueue.partRange(size, part, 3, 1))
        assertEquals(100 * MiB to 20 * MiB, ClipUploadQueue.partRange(size, part, 3, 3))
        // A clip smaller than a part is one part of its own size.
        assertEquals(0L to 2048L, ClipUploadQueue.partRange(2048, part, 1, 1))
    }

    // ---- The lap page -----------------------------------------------------

    @Test
    fun `a job is for the lap on either its temp or its real session id`() {
        assertTrue(ClipUploadQueue.isFor(jobSessionId = -3, jobTimeMs = 100, sessionId = -3, resolved = null, timeMs = 100))
        assertTrue(ClipUploadQueue.isFor(jobSessionId = -3, jobTimeMs = 100, sessionId = 42, resolved = 42, timeMs = 100))
        assertFalse(ClipUploadQueue.isFor(jobSessionId = -3, jobTimeMs = 100, sessionId = 42, resolved = null, timeMs = 100))
        assertFalse(ClipUploadQueue.isFor(jobSessionId = 42, jobTimeMs = 100, sessionId = 42, resolved = null, timeMs = 101))
    }

    @Test
    fun `a job with a lap number is for that lap only (NS-50)`() {
        // Two laps tied on time: each has its own job, told apart by number.
        assertTrue(ClipUploadQueue.isFor(42, 100, 42, null, 100, jobLapNum = 3, lapNum = 3))
        assertFalse(ClipUploadQueue.isFor(42, 100, 42, null, 100, jobLapNum = 3, lapNum = 2))
        assertFalse(ClipUploadQueue.isFor(42, 100, 42, null, 101, jobLapNum = 3, lapNum = 3), "the time still has to match")
        // A job from before lap numbers falls back to the time.
        assertTrue(ClipUploadQueue.isFor(42, 100, 42, null, 100, jobLapNum = null, lapNum = 2))
    }

    @Test
    fun `a lap number picks its lap, a tie included (NS-50)`() {
        val laps = listOf(
            Lap(id = 1, sessionId = 42, lapNum = 1, timeMs = 101_000),
            Lap(id = 3, sessionId = 42, lapNum = 3, timeMs = 100_000),
            Lap(id = 2, sessionId = 42, lapNum = 2, timeMs = 100_000),
        )
        assertEquals(3, ClipUploadQueue.clipLap(laps, 100_000, lapNum = 3)?.id)
        assertEquals(2, ClipUploadQueue.clipLap(laps, 100_000, lapNum = 2)?.id)
        assertNull(ClipUploadQueue.clipLap(laps, 100_000, lapNum = 1), "a mismatch is no lap, as the server's 404")
    }

    @Test
    fun `a job's lap number goes in the create body, and an older job's doesn't`() {
        assertEquals(4, job().copy(lapNum = 4).createBody.lapNum)
        assertNull(job().createBody.lapNum)
        // An older manifest, written before the field, still decodes.
        val old = Json.encodeToString(ClipJob.serializer(), job()).replace(Regex(",?\"lap_num\":null"), "")
        assertFalse("lap_num" in old)
        assertEquals(job(), Json.decodeFromString(ClipJob.serializer(), old))
    }

    @Test
    fun `the clip lands on the lowest lap number with its time`() {
        val laps = listOf(
            Lap(id = 1, sessionId = 42, lapNum = 1, timeMs = 101_000),
            Lap(id = 3, sessionId = 42, lapNum = 3, timeMs = 100_000),
            Lap(id = 2, sessionId = 42, lapNum = 2, timeMs = 100_000),
        )
        assertEquals(2, ClipUploadQueue.clipLap(laps, 100_000)?.id)
        assertNull(ClipUploadQueue.clipLap(laps, 99_000))
    }

    @Test
    fun `the manifest round trips in snake case`() {
        val job = started(uploaded = listOf(1)).copy(notBeforeMs = NOW)
        val json = Json.encodeToString(ClipJob.serializer(), job)
        assertTrue("\"session_id\":42" in json && "\"part_bytes\"" in json && "\"not_before_ms\"" in json, json)
        assertEquals(job, Json.decodeFromString(ClipJob.serializer(), json))
    }

    // ---- contracts/logic/clip-upload.json -----------------------------------

    /**
     * The transition table as the web reference wrote it (NS-47, NS-50):
     * every row of `contracts/logic/clip-upload.json` but the web-only ones,
     * the jobs read with their `lapNum` and temp ids `"tmp-N"` as this side's
     * negative `-N`.
     */
    @org.junit.jupiter.api.Nested
    inner class Fixture {
        private val fixture = Json.parseToJsonElement(RepoRoot.path("contracts/logic/clip-upload.json").readText()).jsonObject
        private val strict = Json { ignoreUnknownKeys = false }

        private fun id(raw: JsonElement): Int {
            val p = raw.jsonPrimitive
            return p.intOrNull ?: -p.content.removePrefix("tmp-").toInt()
        }

        private fun JsonElement?.intOrNull(): Int? = if (this == null || this is JsonNull) null else jsonPrimitive.int
        private fun JsonElement?.longOrNull(): Long? = if (this == null || this is JsonNull) null else jsonPrimitive.long

        private fun jobOf(o: JsonObject) = ClipJob(
            id = o["id"]!!.jsonPrimitive.content,
            sessionId = id(o["sessionId"]!!),
            eventId = 7,
            timeMs = o["timeMs"]!!.jsonPrimitive.int,
            lapNum = o["lapNum"].intOrNull(),
            file = "job-1.mp4",
            sizeBytes = o["sizeBytes"]!!.jsonPrimitive.long,
            durationMs = o["durationMs"]!!.jsonPrimitive.int,
            lapOffsetMs = o["lapOffsetMs"]!!.jsonPrimitive.int,
            clipId = o["clipId"].intOrNull(),
            partBytes = o["partBytes"].longOrNull(),
            parts = o["parts"].intOrNull(),
            uploaded = o["uploaded"]!!.jsonArray.map { it.jsonPrimitive.int },
            state = ClipJob.State.PENDING,
            failures = o["failures"]!!.jsonPrimitive.int,
            restarts = o["restarts"]!!.jsonPrimitive.int,
            notBeforeMs = o["notBeforeMs"].longOrNull(),
            createdAt = o["createdAtMs"]!!.jsonPrimitive.long,
        )

        private fun sessionOf(o: JsonObject): SessionState = when (val kind = o["kind"]!!.jsonPrimitive.content) {
            "real" -> SessionState.Real(o["id"]!!.jsonPrimitive.int)
            "waiting" -> SessionState.Waiting
            "lost" -> SessionState.Lost
            else -> error("session kind $kind")
        }

        private fun reason(raw: String) = DropReason.entries.single { it.rawValue == raw }

        private fun actionOf(o: JsonObject): Action = when (val kind = o["kind"]!!.jsonPrimitive.content) {
            "create" -> Action.Create(o["sessionId"]!!.jsonPrimitive.int, strict.decodeFromJsonElement(ClipCreate.serializer(), o["body"]!!))
            "uploadPart" -> Action.UploadPart(
                o["clipId"]!!.jsonPrimitive.int,
                o["part"]!!.jsonPrimitive.int,
                o["offset"]!!.jsonPrimitive.long,
                o["length"]!!.jsonPrimitive.long,
            )
            "complete" -> Action.Complete(o["clipId"]!!.jsonPrimitive.int)
            "waitForSession" -> Action.WaitForSession
            "waitUntil" -> Action.WaitUntil(o["ms"]!!.jsonPrimitive.long)
            "drop" -> Action.Drop(reason(o["reason"]!!.jsonPrimitive.content))
            else -> error("action kind $kind")
        }

        private fun responseOf(o: JsonObject): Response = when (val kind = o["kind"]!!.jsonPrimitive.content) {
            "created" -> o["start"]!!.jsonObject.let { s ->
                Response.Created(
                    ClipUpload(
                        clipId = s["clipId"]!!.jsonPrimitive.int,
                        partBytes = s["partBytes"]!!.jsonPrimitive.long,
                        parts = s["parts"]!!.jsonPrimitive.int,
                        uploaded = s["uploaded"]!!.jsonArray.map { it.jsonPrimitive.int },
                    ),
                )
            }
            "ok" -> Response.Ok
            "missingParts" -> Response.MissingParts(o["missing"]!!.jsonArray.map { it.jsonPrimitive.int })
            "status" -> Response.Status(o["status"]!!.jsonPrimitive.int, o["error"]!!.let { if (it is JsonNull) null else it.jsonPrimitive.content })
            "transport" -> Response.Transport
            else -> error("response kind $kind")
        }

        private fun outcomeOf(o: JsonObject): Outcome = when (val kind = o["kind"]!!.jsonPrimitive.content) {
            "continue" -> Outcome.Continue(jobOf(o["job"]!!.jsonObject))
            "finished" -> Outcome.Finished
            "dropped" -> Outcome.Dropped(reason(o["reason"]!!.jsonPrimitive.content))
            else -> error("outcome kind $kind")
        }

        private fun phoneRows(key: String) = fixture[key]!!.jsonArray.map { it.jsonObject }
            .filter { it["webOnly"]?.jsonPrimitive?.booleanOrNull != true }

        @Test
        fun `constants and drop reasons match`() {
            assertEquals(fixture["BACKOFF_BASE_MS"]!!.jsonPrimitive.long, ClipUploadQueue.BACKOFF_BASE_MS)
            assertEquals(fixture["BACKOFF_MAX_MS"]!!.jsonPrimitive.long, ClipUploadQueue.BACKOFF_MAX_MS)
            assertEquals(fixture["MAX_RESTARTS"]!!.jsonPrimitive.int, ClipUploadQueue.MAX_RESTARTS)
            val web = fixture["DropReason"]!!.jsonObject.values.map { it.jsonPrimitive.content }.toSet()
            // `source unreadable` is the web's alone: an ejected card has no phone counterpart.
            assertEquals(web - "source unreadable", DropReason.entries.map { it.rawValue }.toSet())
        }

        @Test
        fun `sessionState, backoffMs and partRange match`() {
            for (row in phoneRows("sessionState")) {
                assertEquals(
                    sessionOf(row["state"]!!.jsonObject),
                    ClipUploadQueue.sessionState(id(row["sessionId"]!!), row["mapped"].intOrNull(), row["queued"]!!.jsonPrimitive.booleanOrNull!!),
                    "$row",
                )
            }
            for (row in fixture["backoffMs"]!!.jsonArray) {
                val (failures, wait) = row.jsonArray.map { it.jsonPrimitive.long }
                assertEquals(wait, ClipUploadQueue.backoffMs(failures.toInt()), "backoffMs($failures)")
            }
            for (row in phoneRows("partRange")) {
                val range = ClipUploadQueue.partRange(
                    row["sizeBytes"]!!.jsonPrimitive.long,
                    row["partBytes"]!!.jsonPrimitive.long,
                    row["parts"]!!.jsonPrimitive.int,
                    row["part"]!!.jsonPrimitive.int,
                )
                assertEquals(row["offset"]!!.jsonPrimitive.long to row["length"]!!.jsonPrimitive.long, range, "$row")
            }
        }

        @Test
        fun `every nextAction row, the create body byte for byte`() {
            val rows = phoneRows("nextAction")
            assertTrue(rows.any { it["job"]!!.jsonObject["lapNum"] is JsonNull }, "the row for a job from before lap numbers")
            for (row in rows) {
                val name = row["name"]!!.jsonPrimitive.content
                val want = row["action"]!!.jsonObject
                val got = ClipUploadQueue.nextAction(jobOf(row["job"]!!.jsonObject), sessionOf(row["session"]!!.jsonObject), row["nowMs"]!!.jsonPrimitive.long)
                assertEquals(actionOf(want), got, name)
                if (got is Action.Create) {
                    // What goes on the wire: `lap_num` only when the job has one.
                    assertEquals(want["body"], ApiClient.requestJson.encodeToJsonElement(ClipCreate.serializer(), got.body), "$name: body")
                }
            }
        }

        @Test
        fun `every apply row`() {
            val rows = phoneRows("apply")
            assertTrue(rows.size >= 25)
            for (row in rows) {
                val name = row["name"]!!.jsonPrimitive.content
                assertEquals(
                    outcomeOf(row["outcome"]!!.jsonObject),
                    ClipUploadQueue.apply(
                        jobOf(row["job"]!!.jsonObject),
                        actionOf(row["action"]!!.jsonObject),
                        responseOf(row["response"]!!.jsonObject),
                        row["nowMs"]!!.jsonPrimitive.long,
                    ),
                    name,
                )
            }
        }
    }
}
