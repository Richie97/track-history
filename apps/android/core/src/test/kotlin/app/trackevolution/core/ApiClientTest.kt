package app.trackevolution.core

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.EventDraft
import app.trackevolution.core.model.EventPatch
import app.trackevolution.core.model.Patch
import app.trackevolution.core.model.SessionDraft
import app.trackevolution.core.model.TrackPatch
import app.trackevolution.core.model.TracePoint
import app.trackevolution.core.api.NoToken
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.content.TextContent
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.IOException

/**
 * The client's own behavior — headers, URLs, request bodies and error mapping.
 * What it decodes is [GoldenContractTest]'s job; these fixtures are only as real
 * as they need to be to exercise the plumbing.
 */
class ApiClientTest {

    private val recorded = mutableListOf<HttpRequestData>()

    private fun client(
        token: String? = "tok",
        baseUrl: String = "https://example.test",
        handler: MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ): ApiClient {
        val engine = MockEngine { request ->
            recorded += request
            handler(request)
        }
        return ApiClient(
            engine,
            baseUrl = baseUrl,
            tokens = token?.let { StaticToken(it) } ?: NoToken,
        )
    }

    private fun bodyOf(request: HttpRequestData): JsonObject =
        Json.parseToJsonElement((request.body as TextContent).text).jsonObject

    @Test
    fun `sends the bearer token on api requests`() = runTest {
        val api = client { respondJson(Goldens.bodyText("me")) }
        api.me()
        assertEquals("Bearer tok", recorded.single().headers[HttpHeaders.Authorization])
        assertEquals("https://example.test/api/me", recorded.single().url.toString())
    }

    @Test
    fun `never sends the token to the public share endpoint`() = runTest {
        val api = client { respondJson(Goldens.bodyText("share-public")) }
        api.sharedLogbook("eric")
        assertNull(recorded.single().headers[HttpHeaders.Authorization])
        assertEquals("https://example.test/api/share/eric", recorded.single().url.toString())
    }

    @Test
    fun `trims a trailing slash off the base URL`() = runTest {
        val api = client(baseUrl = "http://10.0.2.2:8787/") { respondJson(Goldens.bodyText("me")) }
        api.me()
        assertEquals("http://10.0.2.2:8787/api/me", recorded.single().url.toString())
    }

    @Test
    fun `points at another server at runtime`() = runTest {
        val api = client { respondJson(Goldens.bodyText("me")) }
        api.serverUrl = "http://192.168.1.5:8787/"
        api.me()
        assertEquals("http://192.168.1.5:8787/api/me", recorded.single().url.toString())
    }

    @Test
    fun `filters events by track`() = runTest {
        val api = client { respondJson("[]") }
        api.events(trackId = 7)
        assertEquals("https://example.test/api/events?track_id=7", recorded.single().url.toString())
    }

    // ---- Error mapping ----------------------------------------------------

    @Test
    fun `maps 401 to Unauthorized, keeping the server's message`() = runTest {
        val api = client { respondJson("""{"error":"unauthorized"}""", HttpStatusCode.Unauthorized) }
        val error = assertThrows<ApiException> { api.me() }
        assertTrue(error.isUnauthorized)
        assertEquals(401, error.status)
        assertEquals("unauthorized", error.message)
    }

    @Test
    fun `surfaces the server's message on any other failure`() = runTest {
        val api = client {
            respondJson("""{"error":"start_date required"}""", HttpStatusCode.BadRequest)
        }
        val error = assertThrows<ApiException> { api.createEvent(EventDraft(startDate = "")) }
        assertFalse(error.isUnauthorized)
        assertEquals(400, error.status)
        assertEquals("start_date required", error.message)
    }

    @Test
    fun `falls back when the failure body is not the expected shape`() = runTest {
        val api = client { respondJson("<html>502</html>", HttpStatusCode.BadGateway) }
        val error = assertThrows<ApiException> { api.me() }
        assertEquals("Request failed (502)", error.message)
    }

    @Test
    fun `a dead network is a transport failure, not a server error`() = runTest {
        val api = client { throw IOException("Unable to resolve host") }
        val error = assertThrows<ApiException> { api.me() }
        assertTrue(error is ApiException.Transport)
        assertNull(error.status)
        assertEquals("Unable to resolve host", error.message)
    }

    @Test
    fun `a body that does not match its model is a decoding failure`() = runTest {
        val api = client { respondJson("""{"user":{"id":"one"}}""") }
        val error = assertThrows<ApiException> { api.me() }
        assertTrue(error is ApiException.Decoding)
    }

    // ---- Request bodies ---------------------------------------------------

    @Test
    fun `a draft omits the fields the user left blank`() = runTest {
        val api = client { respondJson("""{"id":12}""", HttpStatusCode.Created) }
        val id = api.createEvent(EventDraft(startDate = "2026-05-01", trackName = "Road Atlanta"))
        assertEquals(12, id)

        val body = bodyOf(recorded.single())
        assertEquals(
            setOf("start_date", "track_name"),
            body.keys,
            "a create request must not send nulls for every untouched column",
        )
    }

    @Test
    fun `a patch distinguishes leave-alone from clear-it`() = runTest {
        val api = client { respondJson("""{"ok":true}""") }
        api.updateEvent(
            3,
            EventPatch(
                club = Patch.Set("Chin"),
                // Explicitly cleared — the server must see a null, not silence.
                notes = Patch.Set(null),
                // Untouched: the key must not appear at all.
                car = Patch.Unchanged,
            ),
        )

        val body = bodyOf(recorded.single())
        assertEquals(setOf("club", "notes"), body.keys)
        assertEquals(JsonPrimitive("Chin"), body["club"])
        assertEquals(JsonNull, body["notes"])
    }

    @Test
    fun `a track patch omits the name rather than nulling it`() = runTest {
        val api = client { respondJson("""{"ok":true}""") }
        api.updateTrack(4, TrackPatch(goalMs = Patch.Set(121_000)))
        assertEquals(setOf("goal_ms"), bodyOf(recorded.single()).keys)

        recorded.clear()
        api.updateTrack(4, TrackPatch(name = "Road Atlanta", notes = Patch.Set(null)))
        val body = bodyOf(recorded.single())
        assertEquals(setOf("name", "notes"), body.keys)
        assertEquals(JsonNull, body["notes"])
    }

    @Test
    fun `a recorded session posts its laps and trace together`() = runTest {
        val api = client { respondJson("""{"id":9}""", HttpStatusCode.Created) }
        api.createSession(
            eventId = 2,
            SessionDraft(
                label = "Session 1",
                laps = listOf(121_240, 120_980),
                trace = listOf(TracePoint(1.0, 2.0, 30.5)),
            ),
        )
        val body = bodyOf(recorded.single())
        assertEquals(setOf("label", "laps", "trace"), body.keys)
        // The trace is a bare array per point, exactly as `sanitizeTrace` stores it.
        assertEquals("[[1.0,2.0,30.5]]", body["trace"].toString())
        assertEquals("https://example.test/api/events/2/sessions", recorded.single().url.toString())
    }

    @Test
    fun `clearing the checklist template sends an explicit null`() = runTest {
        val api = client { respondJson("""{"ok":true}""") }
        api.updateChecklistTemplate(emptyList())
        assertEquals(JsonNull, bodyOf(recorded.single())["checklist_template"])
    }
}

/** JSON responses, with the content type a real server would set. */
private fun MockRequestHandleScope.respondJson(
    body: String,
    status: HttpStatusCode = HttpStatusCode.OK,
): HttpResponseData = respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))
