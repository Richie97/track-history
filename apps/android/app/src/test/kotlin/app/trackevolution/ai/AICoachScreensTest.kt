package app.trackevolution.ai

import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import app.trackevolution.core.AICoach
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.AICoachModel
import app.trackevolution.screens.EventModel
import app.trackevolution.screens.EventScreen
import app.trackevolution.screens.SettingsModel
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.ProvideLayoutMetrics
import app.trackevolution.ui.theme.TrackTheme
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The AI Coach on Android (#320) end to end over `MockEngine`: the event page's
 * doors, the sheet streaming the recorded reply (`contracts/streams/ai-coach.sse`),
 * *Save to notes*, the paywall in place, a refusal in the sheet with *Try
 * again*, no key → Settings, offline, read-only, the side pane at expanded
 * width — and Settings' AI Coach block verifying and forgetting a key.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp")
class AICoachScreensTest {

    @get:Rule
    val compose = createComposeRule()

    private val sent = CopyOnWriteArrayList<HttpRequestData>()
    private val bodies = CopyOnWriteArrayList<Pair<String, String>>()
    private var coachStatus = HttpStatusCode.OK
    private var coachError = ""
    private var offlineCoach = false

    private val api = ApiClient(
        MockEngine { request ->
            sent += request
            val path = request.url.encodedPath
            (request.body as? TextContent)?.let { bodies += "${request.method.value} $path" to it.text }
            when {
                path == "/api/ai/coach" -> {
                    if (offlineCoach) throw IOException("Unable to resolve host")
                    if (coachStatus != HttpStatusCode.OK) {
                        respond("""{"error":"$coachError"}""", coachStatus, JSON)
                    } else {
                        respond(ByteReadChannel(STREAM), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "text/event-stream"))
                    }
                }
                path == "/api/ai/coach/verify" -> respond(golden("ai-coach-verify"), HttpStatusCode.OK, JSON)
                path.endsWith("/tracks") -> respond("[]", HttpStatusCode.OK, JSON)
                request.method.value == "PUT" -> respond("""{"ok":true}""", HttpStatusCode.OK, JSON)
                path == "/api/me" -> respond(golden("me"), HttpStatusCode.OK, JSON)
                path.startsWith("/api/events/") -> respond(EVENT_DETAIL, HttpStatusCode.OK, JSON)
                else -> respond("[]", HttpStatusCode.OK, JSON)
            }
        },
        baseUrl = "https://example.test",
        tokens = StaticToken("tok"),
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var keys: AICoachKeys
    private var openedSettings = 0

    @Before
    fun setUp() {
        keys = AICoachKeys(AICoachKeys.InMemory())
        AICoachSettingsFocus.pending = false
    }

    private fun eventually(condition: () -> Boolean) {
        repeat(400) {
            if (condition()) return
            Thread.sleep(25)
            compose.waitForIdle()
        }
        assertTrue("condition never held", condition())
    }

    private fun shown(text: String) = compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()
    private fun tagged(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
    private fun coachRequests() = sent.filter { it.url.encodedPath == "/api/ai/coach" }

    private fun withKey() = keys.save("anthropic", "sk-ant-api03-secretsecret", listOf(AICoachModel("claude-sonnet-5-5", "Claude Sonnet 5.5")), "claude-sonnet-5-5")

    private fun showEvent(pro: Boolean = true, readOnly: Boolean = false, offline: Boolean = false, access: Boolean = true): AICoachChat {
        val model = runBlocking {
            EventModel(CoroutineScope(Dispatchers.Default), api, 1).also { model ->
                model.load()
                withTimeout(5_000) { while (model.state != LoadState.Ready) delay(5) }
            }
        }
        val chat = AICoachChat(scope, api, keys)
        val aiAccess = AICoachAccess(chat, keys, pro, onOpenSettings = { openedSettings++ }, onSubscribe = {}, onSignedOut = {})
        compose.setContent {
            ProvideLayoutMetrics {
                TrackTheme {
                    EventScreen(
                        model = model,
                        checklistTemplate = emptyList(),
                        onEdit = {},
                        onOpenTrack = {},
                        onRecord = {},
                        onImport = {},
                        onDeleted = {},
                        recorderAvailable = true,
                        readOnly = readOnly,
                        aiCoach = aiAccess.takeIf { access },
                        offline = offline,
                    )
                }
            }
        }
        compose.waitForIdle()
        return chat
    }

    private fun tapDebrief() {
        // The page's own list: at expanded width the analysis column scrolls too.
        compose.onAllNodes(hasScrollAction()).onFirst().performScrollToNode(hasTestTag("aiCoach-session-1"))
        compose.onNodeWithTag("aiCoach-session-1").performClick()
        compose.waitForIdle()
    }

    @Test
    fun `a debrief streams into the sheet, and Save keeps it in the session's notes`() {
        withKey()
        showEvent()
        tapDebrief()
        eventually { tagged("aiCoachReply") && tagged("aiCoachSave") }
        assertTrue(shown("Where the time is."))
        assertTrue(shown("Brake release into the slow corners"))
        // Bold is drawn, never left as markers.
        assertFalse(shown("**Where"))
        assertTrue(shown("Runs on your Anthropic account."))

        val request = coachRequests().single()
        assertEquals("anthropic", request.headers["X-TE-AI-Provider"])
        assertEquals("sk-ant-api03-secretsecret", request.headers["X-TE-AI-Key"])
        val body = Json.parseToJsonElement(bodies.first { it.first == "POST /api/ai/coach" }.second).jsonObject
        assertEquals("""{"event_id":1,"session_id":1}""", body["context"].toString())
        assertEquals(
            AICoach.COACH_ENTRIES.getValue("session").question,
            body["messages"]!!.jsonArray.single().jsonObject["content"]!!.jsonPrimitive.content,
        )

        compose.onNodeWithTag("aiCoachSave").performClick()
        eventually { shown("Saved to notes.") }
        val put = bodies.first { it.first == "PUT /api/sessions/1" }.second
        val notes = Json.parseToJsonElement(put).jsonObject["notes"]!!.jsonPrimitive.content
        assertTrue(notes, notes.startsWith("Learning the line. Brake later into T5.\n\nAI Coach, "))
        assertTrue(notes, notes.contains("Where the time is. Your best lap"))
    }

    @Test
    fun `a follow-up sends the whole conversation`() {
        withKey()
        showEvent()
        tapDebrief()
        eventually { tagged("aiCoachSave") }
        compose.onNodeWithTag("aiCoachAsk").performTextInput("Which corner first?")
        compose.onNodeWithTag("aiCoachSend").performClick()
        eventually { coachRequests().size == 2 && compose.onAllNodesWithTag("aiCoachSave").fetchSemanticsNodes().size == 2 }
        val last = Json.parseToJsonElement(bodies.last { it.first == "POST /api/ai/coach" }.second).jsonObject
        val roles = last["messages"]!!.jsonArray.map { it.jsonObject["role"]!!.jsonPrimitive.content }
        assertEquals(listOf("user", "assistant", "user"), roles)
    }

    @Test
    fun `the event page asks about next time and keeps the reply in the event's notes`() {
        withKey()
        showEvent()
        compose.onNode(hasScrollAction()).performScrollToNode(hasTestTag("aiCoach-event"))
        compose.onNodeWithTag("aiCoach-event").performClick()
        eventually { tagged("aiCoachSave") }
        val body = Json.parseToJsonElement(bodies.first { it.first == "POST /api/ai/coach" }.second).jsonObject
        assertEquals("""{"event_id":1,"track_id":1}""", body["context"].toString())
        assertTrue(shown(AICoach.coachSaveLabel("event")))
        compose.onNodeWithTag("aiCoachSave").performClick()
        eventually { bodies.any { it.first == "PUT /api/events/1" } }
        val notes = Json.parseToJsonElement(bodies.first { it.first == "PUT /api/events/1" }.second)
            .jsonObject["notes"]!!.jsonPrimitive.content
        assertTrue(notes, notes.startsWith("Cool morning, damp session 1.\n\nAI Coach, "))
    }

    @Test
    fun `a free account gets the paywall in the sheet, and nothing is sent`() {
        showEvent(pro = false)
        tapDebrief()
        eventually { tagged("proLocked") }
        assertTrue(coachRequests().isEmpty())
        assertFalse(tagged("aiCoachAsk"))
    }

    @Test
    fun `a 402 from the server is the paywall too, never an error`() {
        withKey()
        coachStatus = HttpStatusCode.PaymentRequired
        coachError = "pro required"
        showEvent()
        tapDebrief()
        eventually { tagged("proLocked") }
        assertFalse(tagged("aiCoachError"))
    }

    @Test
    fun `no key opens Settings' AI Coach block instead of a dead sheet`() {
        showEvent()
        tapDebrief()
        assertEquals(1, openedSettings)
        assertTrue(AICoachSettingsFocus.pending)
        assertFalse(tagged("aiCoachPanel"))
        assertTrue(coachRequests().isEmpty())
    }

    @Test
    fun `a rejected key is said in the sheet, with Try again and the way to Settings`() {
        withKey()
        coachStatus = HttpStatusCode.FailedDependency
        coachError = "provider rejected the key"
        val chat = showEvent()
        tapDebrief()
        eventually { tagged("aiCoachError") }
        assertTrue(shown("Anthropic rejected the key. Check it in Settings → AI assistants."))
        assertTrue(tagged("aiCoachSettings"))
        // The failed question left the conversation: Try again asks it afresh.
        coachStatus = HttpStatusCode.OK
        compose.onNodeWithTag("aiCoachRetry").performClick()
        eventually { tagged("aiCoachSave") }
        assertEquals(1, chat.turns.size)
        val retried = Json.parseToJsonElement(bodies.last { it.first == "POST /api/ai/coach" }.second).jsonObject
        assertEquals(1, retried["messages"]!!.jsonArray.size)
    }

    @Test
    fun `offline, the request is said in the sheet, and the doors say why`() {
        withKey()
        offlineCoach = true
        showEvent()
        tapDebrief()
        eventually { shown("The AI Coach needs a connection.") }
    }

    @Test
    fun `offline, the doors are disabled and say needs a connection`() {
        withKey()
        showEvent(offline = true)
        compose.onNode(hasScrollAction()).performScrollToNode(hasTestTag("aiCoach-session-1"))
        compose.onNodeWithTag("aiCoach-session-1").assertIsNotEnabled()
        assertTrue(shown("Debrief this session · needs a connection"))
    }

    @Test
    fun `a read-only page offers no door, even handed one`() {
        withKey()
        showEvent(readOnly = true)
        assertFalse(tagged("aiCoach-session-1"))
        assertFalse(tagged("aiCoach-event"))
    }

    @Test
    fun `no access, no door`() {
        withKey()
        showEvent(access = false)
        assertFalse(tagged("aiCoach-session-1"))
        assertFalse(tagged("aiCoach-event"))
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp")
    fun `at expanded width the conversation takes the analysis column, not a sheet`() {
        withKey()
        showEvent()
        tapDebrief()
        eventually { tagged("aiCoachSave") }
        assertTrue(tagged("aiCoachPanel"))
        assertFalse(tagged("aiCoachSheet"))
        // Closing gives the column back to the analysis.
        compose.onNodeWithTag("aiCoachClose").performClick()
        eventually { !tagged("aiCoachPanel") }
    }

    @Test
    fun `below expanded width the conversation is a sheet`() {
        withKey()
        showEvent()
        tapDebrief()
        eventually { tagged("aiCoachSave") }
        assertTrue(tagged("aiCoachSheet"))
    }

    // ---- Settings ------------------------------------------------------------

    private fun showSettings(pro: Boolean = true): AICoachSettingsState {
        val state = AICoachSettingsState(scope, api, keys)
        compose.setContent {
            TrackTheme {
                AICoachSettingsCard(state, pro = pro, onSubscribe = {}, onOpenLink = {})
            }
        }
        compose.waitForIdle()
        return state
    }

    @Test
    fun `Settings verifies a key, keeps it on the device, and forgets it`() {
        showSettings()
        assertTrue(shown("no key yet"))
        compose.onNodeWithTag("aiKey-anthropic").performTextInput("sk-ant-api03-abcdefghijklmnop")
        compose.onNodeWithTag("aiVerify-anthropic").performClick()
        eventually { keys.state.value.keys.containsKey("anthropic") }
        val verify = sent.single { it.url.encodedPath == "/api/ai/coach/verify" }
        assertEquals("sk-ant-api03-abcdefghijklmnop", verify.headers["X-TE-AI-Key"])
        eventually { shown("key sk-ant-…mnop · stored on this device only") }
        // Never the key itself.
        assertFalse(shown("sk-ant-api03-abcdefghijklmnop"))
        assertEquals("anthropic", keys.credential()?.provider)

        compose.onNodeWithTag("aiForget-anthropic").performClick()
        eventually { keys.credential() == null }
    }

    @Test
    fun `Settings locks the block for a free account`() {
        showSettings(pro = false)
        assertTrue(tagged("proLocked"))
        assertFalse(tagged("aiKey-anthropic"))
    }

    private companion object {
        val JSON = headersOf(HttpHeaders.ContentType, "application/json")

        private val repoRoot: File = run {
            var candidate: File? = File(System.getProperty("user.dir")).absoluteFile
            while (candidate != null) {
                if (File(candidate, "package.json").isFile) return@run candidate
                candidate = candidate.parentFile
            }
            error("repository root not found above ${System.getProperty("user.dir")}")
        }

        val STREAM: ByteArray = File(repoRoot, "contracts/streams/ai-coach.sse").readBytes()

        fun goldenBody(name: String): JsonElement =
            Json.parseToJsonElement(File(repoRoot, "contracts/golden/$name.json").readText()).jsonObject["body"]!!

        fun golden(name: String): String = goldenBody(name).toString()

        /** An event detail with session n's id n and its laps numbered through. */
        fun uniqueIds(detail: JsonObject): JsonObject {
            var lapId = 0
            val sessions = detail["sessions"]!!.jsonArray.mapIndexed { index, element ->
                val session = element.jsonObject
                val laps = session["laps"]!!.jsonArray.map { lap ->
                    JsonObject(lap.jsonObject + mapOf("id" to JsonPrimitive(++lapId), "session_id" to JsonPrimitive(index + 1)))
                }
                JsonObject(session + mapOf("id" to JsonPrimitive(index + 1), "laps" to JsonArray(laps)))
            }
            return JsonObject(detail + mapOf("sessions" to JsonArray(sessions)))
        }

        val EVENT_DETAIL: String = uniqueIds(goldenBody("event-detail").jsonObject).toString()
    }
}

/** The key store's rules, over memory (Robolectric has no AndroidKeyStore). */
class AICoachKeysTest {
    private fun model(id: String) = AICoachModel(id, id)

    @Test
    fun `the first verified key becomes active, and forgetting it hands over to the other`() {
        val backend = AICoachKeys.InMemory()
        val keys = AICoachKeys(backend)
        assertNull(keys.credential())
        keys.save("openai", "sk-openai-0123456789", listOf(model("gpt-6.2-astra")), "gpt-6.2-astra")
        keys.save("anthropic", "sk-ant-0123456789", emptyList(), null)
        assertEquals("openai", keys.credential()?.provider)
        keys.setActive("anthropic")
        assertEquals("anthropic", keys.credential()?.provider)
        keys.forget("anthropic")
        assertEquals("openai", keys.credential()?.provider)
        // Persisted, and read back by a fresh store over the same file.
        assertEquals("openai", AICoachKeys(backend).credential()?.provider)
    }

    @Test
    fun `the model is the typed id or the default, and a stale list refresh is dropped`() {
        val keys = AICoachKeys(AICoachKeys.InMemory())
        keys.save("anthropic", "sk-ant-0123456789", emptyList(), "claude-sonnet-5-5")
        keys.setModel("anthropic", "  claude-opus-5-5 ")
        assertEquals("claude-opus-5-5", keys.credential()?.model)
        keys.setModel("anthropic", "")
        assertNull(keys.credential()?.model)
        keys.setModels("anthropic", "an-old-key", listOf(model("x")), null)
        assertTrue(keys.state.value.keys.getValue("anthropic").models.isEmpty())
        keys.setModels("anthropic", "sk-ant-0123456789", listOf(model("x")), null)
        assertEquals(listOf("x"), keys.state.value.keys.getValue("anthropic").models.map { it.id })
    }

    @Test
    fun `sign-out clears everything, and an unreadable file is empty`() {
        val backend = AICoachKeys.InMemory()
        val keys = AICoachKeys(backend)
        keys.save("anthropic", "sk-ant-0123456789", emptyList(), null)
        keys.clear()
        assertNull(keys.credential())
        assertNull(backend.read())
        backend.write("{not json")
        assertNull(AICoachKeys(backend).credential())
    }

    @Test
    fun `the fake provider is a debug build's only`() {
        val release = AICoachKeys(AICoachKeys.InMemory(), fakeAllowed = false)
        release.setFake(true)
        assertNull(release.credential())
        val debug = AICoachKeys(AICoachKeys.InMemory(), fakeAllowed = true)
        debug.setFake(true)
        assertEquals(AICoachCredential("fake", null, null), debug.credential())
    }

    @Test
    fun `masks a key and knows the dev hosts`() {
        assertEquals("sk-ant-…mnop", AICoachKeys.maskKey("sk-ant-api03-abcdefghijklmnop"))
        assertEquals("…", AICoachKeys.maskKey("short"))
        assertTrue(isDevServer("http://10.0.2.2:8787"))
        assertTrue(isDevServer("http://localhost:8787"))
        assertFalse(isDevServer("https://trackevolution.app"))
    }
}
