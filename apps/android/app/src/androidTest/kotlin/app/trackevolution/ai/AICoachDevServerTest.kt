package app.trackevolution.ai

import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.trackevolution.core.AICoach
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.Pkce
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.AICoachMessage
import app.trackevolution.core.model.AICoachOutcome
import app.trackevolution.core.model.EventDraft
import app.trackevolution.core.model.SessionDraft
import app.trackevolution.screens.EventModel
import app.trackevolution.screens.EventScreen
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.ProvideLayoutMetrics
import app.trackevolution.ui.theme.TrackTheme
import io.ktor.client.engine.okhttp.OkHttp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.URLEncoder

/**
 * The AI Coach against a real Worker (#320): the server's scripted provider
 * (`X-TE-AI-Provider: fake`, answered only under `DEV_MODE` on a dev host —
 * the emulator's `10.0.2.2` is one), since a real key can't live in CI. The
 * client call on its own, then the event page's *Debrief this session* end to
 * end: the sheet streams the reply, *Save to session notes* writes it, and the
 * server's copy of the session carries the labelled note. Skipped unless the
 * instrumentation is given a dev server:
 *
 * ```
 * ./gradlew :app:installDebug :app:installDebugAndroidTest
 * adb shell am instrument -w -e devServer http://10.0.2.2:8787 \
 *   -e class app.trackevolution.ai.AICoachDevServerTest \
 *   app.trackevolution.test/androidx.test.runner.AndroidJUnitRunner
 * ```
 */
@RunWith(AndroidJUnit4::class)
class AICoachDevServerTest {

    @get:Rule
    val compose = createComposeRule()

    private val server: String? = InstrumentationRegistry.getArguments().getString("devServer")
    private val http = OkHttpClient.Builder().followRedirects(false).build()

    /** The app's own PKCE exchange against the DEV_MODE bypass, as `ClipUploadDevServerTest` mints its token. */
    private fun devToken(base: String): String {
        val pkce = Pkce.generate()
        val login = http.newCall(
            Request.Builder().url("$base/auth/login?client=app&code_challenge=${URLEncoder.encode(pkce.challenge, "UTF-8")}").build(),
        ).execute()
        val location = login.header("Location") ?: error("no redirect from /auth/login: ${login.code}")
        val code = Regex("[?&]code=([^&]+)").find(location)!!.groupValues[1]
        val body = """{"code":"$code","code_verifier":"${pkce.verifier}"}""".toRequestBody("application/json".toMediaType())
        val exchanged = http.newCall(Request.Builder().url("$base/auth/exchange").post(body).build()).execute().body!!.string()
        return Regex("\"token\"\\s*:\\s*\"([^\"]+)\"").find(exchanged)!!.groupValues[1]
    }

    private fun setPro(base: String, token: String) {
        http.newCall(
            Request.Builder().url("$base/auth/dev/entitlement").header("Authorization", "Bearer $token")
                .post("""{"pro":true}""".toRequestBody("application/json".toMediaType())).build(),
        ).execute().close()
    }

    @Test
    fun theFakeProviderStreamsADebrief() = runBlocking<Unit> {
        val base = server
        assumeTrue("no -e devServer given", base != null)
        base!!
        val token = devToken(base)
        setPro(base, token)
        val api = ApiClient(OkHttp.create(), baseUrl = base, tokens = StaticToken(token))
        val eventId = api.createEvent(EventDraft(startDate = "2026-05-09", trackName = "AI Coach test"))
        try {
            val sessionId = api.createSession(eventId, SessionDraft(label = "AI test", laps = listOf(100_000, 95_000)))
            val text = StringBuilder()
            val tools = mutableListOf<String?>()
            val outcome = api.aiCoach(
                provider = "fake",
                key = null,
                context = AICoach.coachContext("session", eventId = eventId, sessionId = sessionId)!!,
                messages = listOf(AICoachMessage("user", AICoach.COACH_ENTRIES.getValue("session").question)),
                onText = { text.append(it) },
                onTool = { _, label -> tools += label },
            )
            assertTrue("$outcome", outcome is AICoachOutcome.Done && outcome.stop == "end")
            assertTrue(text.toString(), text.startsWith("**Where the time is.**"))
            assertTrue(tools.isNotEmpty())
        } finally {
            api.deleteEvent(eventId)
        }
    }

    @Test
    fun theDebriefSheetStreamsAndSavesToTheSessionNotes() {
        val base = server
        assumeTrue("no -e devServer given", base != null)
        base!!
        val token = devToken(base)
        setPro(base, token)
        val api = ApiClient(OkHttp.create(), baseUrl = base, tokens = StaticToken(token))
        val (eventId, sessionId) = runBlocking {
            val e = api.createEvent(EventDraft(startDate = "2026-05-09", trackName = "AI Coach UI test"))
            e to api.createSession(e, SessionDraft(label = "AI UI", laps = listOf(100_000, 95_000)))
        }
        try {
            val model = runBlocking {
                EventModel(CoroutineScope(Dispatchers.Default), api, eventId).also { m ->
                    m.load()
                    withTimeout(10_000) { while (m.state != LoadState.Ready) delay(10) }
                }
            }
            val keys = AICoachKeys(AICoachKeys.InMemory(), fakeAllowed = true).apply { setFake(true) }
            val chat = AICoachChat(CoroutineScope(SupervisorJob() + Dispatchers.Main), api, keys)
            val access = AICoachAccess(chat, keys, pro = true, onOpenSettings = {}, onSubscribe = {}, onSignedOut = {})
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
                            aiCoach = access,
                        )
                    }
                }
            }
            val door = "aiCoach-session-$sessionId"
            compose.onAllNodes(hasScrollAction()).onFirst().performScrollToNode(hasTestTag(door))
            compose.onNodeWithTag(door).performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("aiCoachSave").fetchSemanticsNodes().isNotEmpty() }
            assertTrue(compose.onAllNodesWithText("Where the time is.", substring = true).fetchSemanticsNodes().isNotEmpty())
            compose.onNodeWithTag("aiCoachSave").performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Saved to notes.").fetchSemanticsNodes().isNotEmpty() }
            val notes = runBlocking { api.event(eventId).sessions.single { it.id == sessionId }.notes }
            assertTrue(notes, notes!!.startsWith("AI Coach, "))
            assertEquals(1, chat.turns.size)
        } finally {
            runBlocking { api.deleteEvent(eventId) }
        }
    }
}
