package app.trackevolution.core

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.api.LogbookOwner
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.AICoachMessage
import app.trackevolution.core.model.AICoachOutcome
import app.trackevolution.core.offline.InMemoryOfflinePersistence
import app.trackevolution.core.offline.OfflineStore
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.IOException

/**
 * The AI Coach at the API client (#320, NS-58): the request's headers and
 * body, the stream read into outcomes, every refusal an answer rather than an
 * exception — and never the offline layer's business: nothing is cached,
 * nothing queued, offline is [AICoachOutcome.Offline] with the queue untouched.
 */
class AICoachApiTest {

    private val store = OfflineStore(InMemoryOfflinePersistence())
    private val seen = mutableListOf<HttpRequestData>()
    private val bodies = mutableListOf<String>()
    private var online = true
    private var reply: () -> Pair<HttpStatusCode, ByteReadChannel> = { HttpStatusCode.OK to ByteReadChannel(recorded) }
    private val recorded = RepoRoot.path("contracts/streams/ai-coach.sse").readBytes()

    private val api = ApiClient(
        MockEngine { request ->
            seen += request
            (request.body as? TextContent)?.let { bodies += it.text }
            if (!online) throw IOException("Unable to resolve host")
            val path = request.url.encodedPath
            if (path == "/api/ai/coach/verify") {
                return@MockEngine respond(
                    Goldens.bodyText("ai-coach-verify"),
                    HttpStatusCode.OK,
                    headersOf(HttpHeaders.ContentType, "application/json"),
                )
            }
            val (status, body) = reply()
            respond(body, status, headersOf(HttpHeaders.ContentType, if (status.value == 200) "text/event-stream" else "application/json"))
        },
        baseUrl = "https://example.test",
        tokens = StaticToken("tok"),
        offline = store,
    )

    private val context = AICoach.CoachContext(eventId = 3, sessionId = 9)
    private val question = listOf(AICoachMessage("user", AICoach.COACH_ENTRIES.getValue("session").question))

    private suspend fun ask(model: String? = null, text: StringBuilder = StringBuilder(), tools: MutableList<String?> = mutableListOf()) =
        api.aiCoach("anthropic", "sk-ant-secret", context, question, model, onText = { text.append(it) }, onTool = { _, label -> tools += label })

    @Test
    fun `sends the credential headers, the context and the conversation, and reads the stream`() = runTest {
        val text = StringBuilder()
        val tools = mutableListOf<String?>()
        val outcome = ask(model = "claude-opus-5-5", text = text, tools = tools)
        assertEquals(AICoachOutcome.Done("end", "fake-1", null), outcome)
        assertTrue(text.startsWith("**Where the time is.**"))
        assertEquals(listOf("Analysing the session…"), tools)

        val req = seen.single()
        assertEquals("POST", req.method.value)
        assertEquals("/api/ai/coach", req.url.encodedPath)
        assertEquals("Bearer tok", req.headers[HttpHeaders.Authorization])
        assertEquals("anthropic", req.headers["X-TE-AI-Provider"])
        assertEquals("sk-ant-secret", req.headers["X-TE-AI-Key"])
        val body = Json.parseToJsonElement(bodies.single()).jsonObject
        assertEquals("""{"event_id":3,"session_id":9}""", body["context"].toString())
        assertEquals("user", body["messages"]!!.jsonArray.single().jsonObject["role"]!!.jsonPrimitive.content)
        assertEquals("claude-opus-5-5", body["model"]!!.jsonPrimitive.content)
    }

    @Test
    fun `omits the model for the default, and the key for a provider that needs none`() = runTest {
        api.aiCoach("fake", null, context, question)
        assertFalse(Json.parseToJsonElement(bodies.single()).jsonObject.containsKey("model"))
        assertNull(seen.single().headers["X-TE-AI-Key"])
    }

    @Test
    fun `a 402 is the paywall and a 401 is the session, never an error`() = runTest {
        reply = { HttpStatusCode.PaymentRequired to ByteReadChannel("""{"error":"pro required"}""") }
        assertEquals(AICoachOutcome.Paywall, ask())
        reply = { HttpStatusCode.Unauthorized to ByteReadChannel("""{"error":"unauthorized"}""") }
        assertEquals(AICoachOutcome.Unauthorized, ask())
    }

    @Test
    fun `a refusal before the stream carries the server's own words`() = runTest {
        reply = { HttpStatusCode.FailedDependency to ByteReadChannel("""{"error":"provider rejected the key"}""") }
        assertEquals(AICoachOutcome.Error(424, "provider rejected the key"), ask())
        reply = { HttpStatusCode.TooManyRequests to ByteReadChannel("""{"error":"rate limited — too many AI Coach requests; wait a minute"}""") }
        assertEquals(AICoachOutcome.Error(429, "rate limited — too many AI Coach requests; wait a minute"), ask())
    }

    @Test
    fun `an error event ends the reply with its status, and a cut-off stream is an error`() = runTest {
        reply = {
            HttpStatusCode.OK to ByteReadChannel(
                "event: text\ndata: {\"delta\":\"Half\"}\n\nevent: error\ndata: {\"error\":\"Anthropic is unavailable right now — try again shortly\",\"status\":502}\n\n",
            )
        }
        val text = StringBuilder()
        assertEquals(AICoachOutcome.Error(502, "Anthropic is unavailable right now — try again shortly"), ask(text = text))
        assertEquals("Half", text.toString())

        reply = { HttpStatusCode.OK to ByteReadChannel("event: text\ndata: {\"delta\":\"Half\"}\n\n") }
        assertEquals(AICoachOutcome.Error(502, ApiClient.COACH_CUT_OFF), ask())
    }

    @Test
    fun `a stop short of the end carries its sentence`() = runTest {
        reply = {
            HttpStatusCode.OK to ByteReadChannel(
                ": keepalive\n\nevent: text\ndata: {\"delta\":\"x\"}\n\nevent: done\ndata: {\"stop\":\"tool_limit\",\"model\":\"m\",\"message\":\"It ran out of tool calls.\"}\n\n",
            )
        }
        assertEquals(AICoachOutcome.Done("tool_limit", "m", "It ran out of tool calls."), ask())
    }

    @Test
    fun `offline is an outcome, and nothing is queued or cached`() = runTest {
        online = false
        assertEquals(AICoachOutcome.Offline, ask())
        assertEquals(0, store.pendingCount())
        online = true
        ask()
        assertNull(store.cachedGet("/ai/coach"))
        assertEquals(0, store.pendingCount())
    }

    @Test
    fun `verify sends the credential and decodes the models`() = runTest {
        val verified = api.verifyAICoachKey("anthropic", "sk-ant-secret")
        assertTrue(verified.ok)
        assertTrue(verified.models.isNotEmpty())
        val req = seen.single()
        assertEquals("/api/ai/coach/verify", req.url.encodedPath)
        assertEquals("sk-ant-secret", req.headers["X-TE-AI-Key"])
        online = false
        assertThrows<ApiException.Transport> { api.verifyAICoachKey("anthropic", "k") }
    }

    @Test
    fun `a student's client sends neither`() = runTest {
        val student = api.forOwner(LogbookOwner.Student(4, "Sam", pro = true))
        assertThrows<ApiException.ReadOnly> { student.aiCoach("anthropic", "k", context, question) }
        assertThrows<ApiException.ReadOnly> { student.verifyAICoachKey("anthropic", "k") }
        assertTrue(seen.isEmpty())
    }
}
