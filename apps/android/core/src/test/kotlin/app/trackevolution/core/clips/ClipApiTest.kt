package app.trackevolution.core.clips

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.api.ClipMissingParts
import app.trackevolution.core.api.LogbookOwner
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.ClipCreate
import app.trackevolution.core.offline.OfflineStore
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.OutgoingContent
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * The clip routes' request shaping (NS-45): what is sent, and that none of it
 * can ever be queued offline or sent from a student's (read-only) client.
 */
class ClipApiTest {

    @TempDir
    lateinit var dir: File

    private val recorded = mutableListOf<HttpRequestData>()

    private fun client(status: HttpStatusCode = HttpStatusCode.OK, body: (HttpRequestData) -> String): ApiClient {
        val engine = MockEngine { request ->
            recorded += request
            respond(body(request), status, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        return ApiClient(engine, baseUrl = "https://example.test", tokens = StaticToken("tok"))
    }

    @Test
    fun `create posts the time, size, duration and measured offset`() = runTest {
        val api = client { """{"clip_id":9,"part_bytes":52428800,"parts":3,"uploaded":[1]}""" }
        val upload = api.createClip(501, ClipCreate(timeMs = 122_110, sizeBytes = 140_000_000, durationMs = 127_400, lapOffsetMs = 3_317))
        assertEquals(9, upload.clipId)
        assertEquals(52_428_800L, upload.partBytes)
        assertEquals(listOf(1), upload.uploaded)

        val request = recorded.single()
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("/api/sessions/501/clip", request.url.encodedPath)
        val sent = Json.parseToJsonElement((request.body as TextContent).text).jsonObject
        assertEquals("122110", sent["time_ms"]!!.jsonPrimitive.content)
        assertEquals("140000000", sent["size_bytes"]!!.jsonPrimitive.content)
        assertEquals("127400", sent["duration_ms"]!!.jsonPrimitive.content)
        assertEquals("3317", sent["lap_offset_ms"]!!.jsonPrimitive.content)
        assertEquals("Bearer tok", request.headers[HttpHeaders.Authorization])
        assertNull(sent["lap_num"], "no lap_num without one — NS-45's body, unchanged")
    }

    @Test
    fun `create sends lap_num beside the time when the job has one (NS-50)`() = runTest {
        val api = client { """{"clip_id":9,"part_bytes":52428800,"parts":3,"uploaded":[]}""" }
        api.createClip(501, ClipCreate(timeMs = 122_110, sizeBytes = 140_000_000, durationMs = 127_400, lapOffsetMs = 3_317, lapNum = 4))
        val sent = Json.parseToJsonElement((recorded.single().body as TextContent).text).jsonObject
        assertEquals("4", sent["lap_num"]!!.jsonPrimitive.content)
        assertEquals("122110", sent["time_ms"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a part is the exact slice of the file, with its exact length`() = runTest {
        val file = File(dir, "clip.mp4").apply { writeBytes(ByteArray(25) { it.toByte() }) }
        val api = client { """{"ok":true}""" }
        api.uploadClipPart(9, 3, file, offset = 20, length = 5)

        val request = recorded.single()
        assertEquals(HttpMethod.Put, request.method)
        assertEquals("/api/clips/9/parts/3", request.url.encodedPath)
        val body = request.body as OutgoingContent
        assertEquals(5L, body.contentLength, "Content-Length must equal the part's size")
        assertEquals("video/mp4", body.contentType.toString())
        assertArrayEquals(byteArrayOf(20, 21, 22, 23, 24), body.toByteArray())
    }

    @Test
    fun `refusals carry the server's words and status`() = runTest {
        val api = client(HttpStatusCode.Conflict) { """{"error":"clip storage full"}""" }
        val e = assertThrows(ApiException.Server::class.java) {
            kotlinx.coroutines.runBlocking { api.createClip(1, ClipCreate(1, 1, 1, 0)) }
        }
        assertEquals(409, e.status)
        assertEquals("clip storage full", e.message)
    }

    @Test
    fun `complete's missing parts come back as the part numbers`() = runTest {
        val api = client(HttpStatusCode.Conflict) { """{"error":"missing parts","missing":[2,3]}""" }
        val e = assertThrows(ClipMissingParts::class.java) {
            kotlinx.coroutines.runBlocking { api.completeClip(9) }
        }
        assertEquals(listOf(2, 3), e.missing)
        // Any other 409 on complete is an ordinary refusal.
        val other = client(HttpStatusCode.Conflict) { """{"error":"something else"}""" }
        assertThrows(ApiException.Server::class.java) {
            kotlinx.coroutines.runBlocking { other.completeClip(9) }
        }
    }

    @Test
    fun `complete, url and delete hit their routes`() = runTest {
        val api = client { r ->
            when {
                r.url.encodedPath.endsWith("/complete") -> """{"id":9,"duration_ms":127400,"lap_offset_ms":3317,"size_bytes":140000000}"""
                r.url.encodedPath.endsWith("/url") -> """{"url":"https://example.test/clips/9.mp4?exp=1&sig=ab","expires_at":3600000}"""
                else -> """{"ok":true}"""
            }
        }
        assertEquals(3317, api.completeClip(9).lapOffsetMs)
        assertEquals("https://example.test/clips/9.mp4?exp=1&sig=ab", api.clipUrl(9).url)
        api.deleteClip(9)
        assertEquals(
            listOf("POST /api/clips/9/complete", "GET /api/clips/9/url", "DELETE /api/clips/9"),
            recorded.map { "${it.method.value} ${it.url.encodedPath}" },
        )
    }

    @Test
    fun `download names the file from Content-Disposition and streams it`() = runTest {
        val engine = MockEngine { request ->
            recorded += request
            respond(
                "VIDEO",
                HttpStatusCode.OK,
                headersOf(
                    HttpHeaders.ContentType to listOf("video/mp4"),
                    HttpHeaders.ContentDisposition to listOf("attachment; filename=\"vir-2026-05-09-lap-6.mp4\""),
                ),
            )
        }
        val api = ApiClient(engine, baseUrl = "https://example.test", tokens = StaticToken("tok"))
        val out = ByteArrayOutputStream()
        val name = api.downloadClip(9) { out }
        assertEquals("vir-2026-05-09-lap-6.mp4", name)
        assertEquals("VIDEO", out.toString())
        assertEquals("/api/clips/9/download", recorded.single().url.encodedPath)
    }

    @Test
    fun `none of the clip writes is ever queued offline`() {
        assertFalse(OfflineStore.isQueueable("POST", "/sessions/501/clip"))
        assertFalse(OfflineStore.isQueueable("PUT", "/clips/9/parts/1"))
        assertFalse(OfflineStore.isQueueable("POST", "/clips/9/complete"))
        assertFalse(OfflineStore.isQueueable("DELETE", "/clips/9"))
    }

    @Test
    fun `a student's client gets the URL under the mount and refuses everything else unsent`() = runTest {
        val api = client { """{"url":"https://example.test/clips/9.mp4?exp=1&sig=ab","expires_at":1}""" }
        val student = api.forOwner(LogbookOwner.Student(id = 5, name = "Sam", pro = true))
        student.clipUrl(9)
        assertEquals("/api/students/5/clips/9/url", recorded.single().url.encodedPath)

        val file = File(dir, "x.mp4").apply { writeBytes(ByteArray(4)) }
        for (write in listOf<suspend () -> Unit>(
            { student.deleteClip(9) },
            { student.createClip(1, ClipCreate(1, 1, 1, 0)) },
            { student.uploadClipPart(9, 1, file, 0, 4) },
            { student.completeClip(9) },
            { student.downloadClip(9) { ByteArrayOutputStream() } },
        )) {
            var refused = false
            try {
                write()
            } catch (e: ApiException.ReadOnly) {
                refused = true
            }
            assertTrue(refused)
        }
        assertEquals(1, recorded.size, "nothing but the URL was sent")
    }
}
