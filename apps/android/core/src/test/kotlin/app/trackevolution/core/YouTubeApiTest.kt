package app.trackevolution.core

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.api.LogbookOwner
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.offline.InMemoryOfflinePersistence
import app.trackevolution.core.offline.OfflineStore
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.IOException

/**
 * Publishing a best-lap video to YouTube (NS-46) at the API client: every
 * route is live — never queued, never answered from the cache — and none
 * leaves a student's read-only client.
 */
class YouTubeApiTest {

    private val store = OfflineStore(InMemoryOfflinePersistence())
    private val requests = mutableListOf<String>()
    private val bodies = mutableListOf<String>()
    private var online = true
    private var refusal: Pair<HttpStatusCode, String>? = null

    private val api = ApiClient(
        MockEngine { request ->
            val auth = if (request.headers[HttpHeaders.Authorization] != null) " +auth" else ""
            requests += "${request.method.value} ${request.url.encodedPath}$auth"
            (request.body as? TextContent)?.let { bodies += it.text }
            if (!online) throw IOException("Unable to resolve host")
            val json = headersOf(HttpHeaders.ContentType, "application/json")
            val path = request.url.encodedPath
            val method = request.method.value
            refusal?.let { (status, error) -> return@MockEngine respond("""{"error":"$error"}""", status, json) }
            when {
                path == "/api/youtube/connect" ->
                    respond("""{"url":"https://example.test/youtube/connect?ticket=abc"}""", HttpStatusCode.OK, json)
                method == "DELETE" -> respond("""{"ok":true}""", HttpStatusCode.OK, json)
                path.endsWith("/youtube/draft") -> respond(Goldens.bodyText("youtube-draft"), HttpStatusCode.OK, json)
                method == "POST" -> respond(
                    """{"status":"queued","progress":0,"privacy":"public","url":null,"error":null}""",
                    HttpStatusCode.Accepted, json,
                )
                else -> respond(Goldens.bodyText("youtube-upload"), HttpStatusCode.OK, json)
            }
        },
        baseUrl = "https://example.test",
        tokens = StaticToken("tok"),
        offline = store,
    )

    @Test
    fun `the routes hit their own paths with the token, and nothing is cached`() = runTest {
        assertEquals("https://example.test/youtube/connect?ticket=abc", api.youTubeConnectUrl())
        val draft = api.youTubeDraft(7)
        assertEquals("unlisted", draft.privacy)
        assertEquals("driver@channel.example", draft.account)
        val started = api.startYouTubeUpload(7, "VIR · 2:01.500", "Best lap", "public")
        assertEquals("queued", started.status)
        assertEquals("public", started.privacy)
        val upload = api.youTubeUpload(7)
        assertEquals("done", upload.status)
        assertEquals("https://youtu.be/goldenVid01", upload.url)
        api.disconnectYouTube()
        assertEquals(
            listOf(
                "POST /api/youtube/connect +auth",
                "GET /api/clips/7/youtube/draft +auth",
                "POST /api/clips/7/youtube +auth",
                "GET /api/clips/7/youtube +auth",
                "DELETE /api/youtube +auth",
            ),
            requests,
        )
        assertNull(store.cachedGet("/clips/7/youtube"))
        assertNull(store.cachedGet("/clips/7/youtube/draft"))
    }

    @Test
    fun `starting an upload sends exactly the title, description and chosen visibility`() = runTest {
        api.startYouTubeUpload(7, "VIR · 2:01.500", "Line one\nLine two", "public")
        val body = Json.parseToJsonElement(bodies.last()).jsonObject
        assertEquals(setOf("title", "description", "privacy"), body.keys)
        assertEquals("VIR · 2:01.500", body["title"]!!.jsonPrimitive.content)
        assertEquals("Line one\nLine two", body["description"]!!.jsonPrimitive.content)
        assertEquals("public", body["privacy"]!!.jsonPrimitive.content)
    }

    @Test
    fun `offline, every route fails rather than queueing or answering stale`() = runTest {
        // A status read while online must not be what an offline read answers.
        api.youTubeUpload(7)
        online = false
        assertThrows<ApiException.Transport> { api.youTubeConnectUrl() }
        assertThrows<ApiException.Transport> { api.youTubeDraft(7) }
        assertThrows<ApiException.Transport> { api.startYouTubeUpload(7, "t", "d", "unlisted") }
        assertThrows<ApiException.Transport> { api.youTubeUpload(7) }
        assertThrows<ApiException.Transport> { api.disconnectYouTube() }
        assertEquals(0, store.pendingCount())
    }

    @Test
    fun `the server's refusals arrive in its own words, and a free account's as a 402`() = runTest {
        refusal = HttpStatusCode.TooManyRequests to "youtube upload limit"
        val limit = assertThrows<ApiException> { api.startYouTubeUpload(7, "t", "d", "unlisted") }
        assertEquals("youtube upload limit", limit.message)
        assertEquals("You can upload 10 videos to YouTube a day.", YouTubeUpload.youtubeRequestError(limit.message))

        refusal = HttpStatusCode.PaymentRequired to "pro required"
        assertThrows<ApiException.PaymentRequired> { api.youTubeDraft(7) }

        refusal = HttpStatusCode.NotFound to "not found"
        assertTrue(assertThrows<ApiException> { api.youTubeUpload(7) }.isNotFound)
    }

    @Test
    fun `a student's client sends none of them`() = runTest {
        val student = api.forOwner(LogbookOwner.Student(id = 3, name = "Alex", pro = true))
        assertThrows<ApiException.ReadOnly> { student.youTubeConnectUrl() }
        assertThrows<ApiException.ReadOnly> { student.youTubeDraft(7) }
        assertThrows<ApiException.ReadOnly> { student.startYouTubeUpload(7, "t", "d", "unlisted") }
        assertThrows<ApiException.ReadOnly> { student.youTubeUpload(7) }
        assertThrows<ApiException.ReadOnly> { student.disconnectYouTube() }
        assertTrue(requests.isEmpty())
    }
}
