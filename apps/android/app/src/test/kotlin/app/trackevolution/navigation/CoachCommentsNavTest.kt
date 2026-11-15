package app.trackevolution.navigation

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController
import app.trackevolution.auth.ChecklistTemplateStore
import app.trackevolution.auth.UnitsStore
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.offline.InMemoryOfflinePersistence
import app.trackevolution.core.offline.OfflineStore
import app.trackevolution.recording.RecorderState
import app.trackevolution.ui.ProvideLayoutMetrics
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.ui.theme.TrackTheme
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Coach comments (NS-52), composed as the app composes them: the real graph
 * over a mock server. Pinned: the read-only exception (a coach comments on a
 * student's session while every other write stays hidden), the lap rows'
 * spoken counts, a comment card's named actions — Report and the block control
 * among them — the lap page's card, composer and markers, the dashboard's
 * unread card, and that a send with no connection keeps the draft and queues
 * nothing.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp")
class CoachCommentsNavTest {

    @get:Rule
    val compose = createComposeRule()

    private val sent = CopyOnWriteArrayList<HttpRequestData>()
    private val bodies = CopyOnWriteArrayList<String>()
    private val store = OfflineStore(InMemoryOfflinePersistence())
    private lateinit var nav: NavHostController
    @Volatile private var online = true

    private object NoTemplate : ChecklistTemplateStore {
        override val items: List<String> = emptyList()
        override suspend fun set(items: List<String>) = Unit
    }

    private object NoUnits : UnitsStore {
        override val units: UnitSystem = UnitSystem.METRIC
        override suspend fun set(units: UnitSystem) = Unit
    }

    @Test
    fun `a coach comments on a student's session while every other write stays hidden`() {
        show(Route.Event(5, student = 7))
        await("sessionComments-11")
        // The coach's thread, empty, with its audience note and its door.
        assertTrue(compose.onAllNodesWithText("Only you and Alex see what you write here.").fetchSemanticsNodes().isNotEmpty())
        for (text in listOf("Edit event", "Delete event", "Add a session", "Prep checklist")) {
            assertTrue(text, compose.onAllNodesWithText(text).fetchSemanticsNodes().isEmpty())
        }
        list().performScrollToNode(hasTestTag("composeSessionComment-11"))
        compose.onNodeWithTag("composeSessionComment-11").performClick()
        await("commentField")
        assertEquals("/student/:id/event/:id/session/:id/comment", Route.SessionComment(5, 11, null, 7).analyticsPath)
        compose.onNodeWithTag("commentTarget-21").performClick()
        compose.onNodeWithTag("commentField").performTextInput("Brake later into T1")
        compose.onNodeWithTag("commentSend").performClick()
        awaitRequest("POST", "/api/coaching/students/7/sessions/11/comments")
        assertTrue(bodies.any { it == """{"body":"Brake later into T1","lap_id":21}""" })
        // Nothing went to the mount, which is GET-only.
        assertTrue(sent.none { it.method.value != "GET" && it.url.encodedPath.startsWith("/api/students/") })
    }

    @Test
    fun `the owner's lap rows say their counts, and a comment card carries every action`() {
        show(Route.Event(5))
        await("lap-21")
        val row = compose.onNodeWithTag("lapComments-21", useUnmergedTree = true).fetchSemanticsNode()
        assertEquals("2 comments, 1 unread", row.config.getOrNull(SemanticsProperties.StateDescription))
        assertTrue(
            compose.onAllNodes(SemanticsMatcher("spoken count") {
                it.config.getOrNull(SemanticsProperties.ContentDescription)?.any { d -> d.endsWith(", 2 comments, 1 unread") } == true
            }).fetchSemanticsNodes().isNotEmpty(),
        )
        await("comment-1")
        val card = compose.onNodeWithTag("comment-1").fetchSemanticsNode()
        val actions = card.config[SemanticsActions.CustomActions].map { it.label }
        assertEquals(listOf("Reply", "Delete", "Report", "Remove coach"), actions)
        val spoken = card.config[SemanticsProperties.ContentDescription].single()
        assertTrue(spoken, spoken.startsWith("Sam Lee, ") && spoken.endsWith(", unread: Good pace all session."))
        // On screen, so read: the owner's /seen.
        awaitRequest("POST", "/api/events/5/comments/seen")
    }

    @Test
    fun `the lap page shows the lap's comments, a marker on the map, and posts a reply at the playhead`() {
        show(Route.Lap(5, 11, 21))
        await("lapComments")
        await("comment-2")
        assertTrue(
            compose.onAllNodes(SemanticsMatcher("map pin") {
                it.config.getOrNull(SemanticsProperties.ContentDescription)?.any { d -> d.contains("1 comment placed on the line") } == true
            }).fetchSemanticsNodes().isNotEmpty(),
        )
        val card = compose.onNodeWithTag("comment-2").fetchSemanticsNode()
        assertTrue(card.config[SemanticsActions.CustomActions].any { it.label == "Show on lap" })
        // Before the line there is no place: the stage opens on its run-up.
        list().performScrollToNode(hasTestTag("commentPlacePin"))
        compose.onNodeWithTag("commentPlacePin").performClick()
        assertTrue(compose.onAllNodesWithText("Mark a place first: tap a chart, or play the lap and pause where you mean.").fetchSemanticsNodes().isNotEmpty())
        // A tap on a chart seeks the stage into the lap; the pin takes that place.
        list().performScrollToNode(hasTestTag("channelChart:speed"))
        compose.onNodeWithTag("channelChart:speed").performClick()
        compose.waitForIdle()
        list().performScrollToNode(hasTestTag("commentPlacePin"))
        compose.onNodeWithTag("commentPlacePin").performClick()
        await("commentPlace")
        compose.onNodeWithTag("commentField").performTextInput("Tried it")
        compose.onNodeWithTag("commentSend").performClick()
        awaitRequest("POST", "/api/sessions/11/comments")
        assertTrue(bodies.toString(), bodies.any { it.startsWith("""{"body":"Tried it","lap_id":21,"dist_m":""") && it.endsWith(""","coach_id":3}""") })
    }

    @Test
    fun `a send with no connection keeps the draft, says so, and queues nothing`() {
        show(Route.SessionComment(5, 11, coachId = 3))
        await("commentField")
        compose.onNodeWithTag("commentField").performTextInput("Thanks")
        online = false
        compose.onNodeWithTag("commentSend").performClick()
        await("commentError")
        assertTrue(compose.onAllNodesWithText("Commenting needs a connection.").fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodesWithText("Thanks").fetchSemanticsNodes().isNotEmpty())
        assertEquals(0, runBlocking { store.pendingCount() })
    }

    @Test
    fun `the dashboard carries the unread card`() {
        show(null)
        await("unreadComments")
        assertTrue(compose.onAllNodesWithText("💬 Sam Lee commented on Session 1 · VIR").fetchSemanticsNodes().isNotEmpty())
        compose.onNodeWithTag("unreadComments").performClick()
        await("sessionComments-11")
    }

    private fun list() = compose.onAllNodes(androidx.compose.ui.test.hasScrollToNodeAction())[0]

    private fun await(tag: String) {
        repeat(400) {
            if (compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()) return
            Thread.sleep(25)
            compose.waitForIdle()
        }
        compose.onNodeWithTag(tag).assertExists()
    }

    private fun awaitRequest(method: String, path: String) {
        repeat(400) {
            if (sent.any { it.method.value == method && it.url.encodedPath == path }) return
            Thread.sleep(25)
            compose.waitForIdle()
        }
        throw AssertionError("no $method $path in ${sent.map { "${it.method.value} ${it.url.encodedPath}" }}")
    }

    private fun show(start: Route?) {
        val engine = MockEngine { request ->
            sent += request
            (request.body as? TextContent)?.let { bodies += it.text }
            if (!online) throw IOException("Unable to resolve host")
            val path = request.url.encodedPath
            val get = request.method.value == "GET"
            when {
                path.endsWith("/me/profile") -> respond(PROFILE, HttpStatusCode.OK, JSON)
                path == "/api/coaching/comments" -> respond(FEED, HttpStatusCode.OK, JSON)
                path.endsWith("/comments/seen") -> respond("""{"ok":true,"seen":1}""", HttpStatusCode.OK, JSON)
                path == "/api/coaching/students/7/events/5/comments" -> respond(COACH_THREAD, HttpStatusCode.OK, JSON)
                path == "/api/events/5/comments" -> respond(OWNER_THREADS, HttpStatusCode.OK, JSON)
                path.endsWith("/comments") && !get -> respond(CREATED, HttpStatusCode.Created, JSON)
                path.endsWith("/events/5") -> respond(DETAIL, HttpStatusCode.OK, JSON)
                path.endsWith("/events") -> respond(EVENTS, HttpStatusCode.OK, JSON)
                path.endsWith("/tracks") -> respond(TRACKS, HttpStatusCode.OK, JSON)
                path == "/api/me" -> respond(ME, HttpStatusCode.OK, JSON)
                path == "/api/garage" -> respond("""{"error":"pro required"}""", HttpStatusCode.PaymentRequired, JSON)
                else -> respond("""{"error":"not found"}""", HttpStatusCode.NotFound, JSON)
            }
        }
        val api = ApiClient(engine, baseUrl = "https://example.test", tokens = StaticToken("tok"), offline = store)
        compose.setContent {
            ProvideLayoutMetrics {
                TrackTheme {
                    nav = rememberNavController()
                    AppNavHost(
                        nav = nav,
                        api = api,
                        auth = NoTemplate,
                        unitsStore = NoUnits,
                        checklistTemplate = emptyList(),
                        hasCustomChecklistTemplate = false,
                        themeChoice = ThemeChoice.System,
                        onThemeChange = {},
                        serverUrl = "https://example.test",
                        recorderState = RecorderState(),
                        recorderIdle = true,
                        onStartRecording = {},
                        onStopRecording = {},
                        onSignOut = {},
                        entitlement = Entitlement(tier = Entitlement.Tier.PRO),
                    )
                }
            }
        }
        if (start != null) compose.runOnIdle { nav.navigate(start) }
    }

    private companion object {
        val JSON = headersOf(HttpHeaders.ContentType, "application/json")

        const val ME = """
            {"user":{"id":1,"email":"a@example.test","name":"Alex","share_slug":null,"comments_unread":1},
             "totals":{"events":1,"track_days":1}}
        """

        const val PROFILE = """{"id":7,"name":"Alex","picture":null,"pro":true,"profile":null}"""

        /** A best-lap trace the map draws: 40 points round a circle, as `[x, y, v]`. */
        fun circle() = (0 until 40).joinToString(",", "[", "]") {
            val a = it * Math.PI * 2 / 40
            String.format(java.util.Locale.US, "[%.1f,%.1f,%.1f]", 300 * Math.cos(a), 300 * Math.sin(a), 30.0 + it)
        }

        fun ramp(n: Int, scale: Double) = (0 until n).joinToString(",", "[", "]") { String.format(java.util.Locale.US, "%.3f", it * scale) }

        val DETAIL = """
            {"id":5,"track_id":100,"track_name":"VIR","start_date":"2026-04-11","days":1,"updated_at":1,
             "lap_count":2,"session_count":1,"best_ms":120400,"hours":1,"notes":null,"checklist":null,
             "sessions":[{"id":11,"label":"Session 1","notes":null,"sort":0,
               "trace":${circle()},
               "laps":[{"id":21,"session_id":11,"lap_num":1,"time_ms":121900},
                       {"id":22,"session_id":11,"lap_num":2,"time_ms":120400}],
               "channels":{"v":1,"dStepM":20,"laps":[
                 {"n":1,"timeMs":121900,"speed":${ramp(40, 4.0)}},
                 {"n":2,"timeMs":120400,"speed":${ramp(40, 4.1)}}]}}],
             "setups":[]}
        """

        const val EVENTS = """
            [{"id":5,"track_id":100,"track_name":"VIR","start_date":"2026-04-11","days":1,
              "vehicle_id":null,"updated_at":1,"lap_count":2,"session_count":1,"best_ms":120400,"hours":1}]
        """

        const val TRACKS = """
            [{"id":100,"name":"VIR","updated_at":1,"event_count":1,"track_days":1,"best_ms":120400,
              "last_date":"2026-04-11","series":[]}]
        """

        private const val SAM = """{"id":3,"name":"Sam Lee","picture":null}"""

        const val OWNER_THREADS = """
            {"comments":[
              {"id":1,"coach_id":3,"session_id":11,"lap_id":null,"dist_m":null,"body":"Good pace all session.",
               "created_at":1000,"edited_at":null,"author":$SAM,"mine":false,"seen":false},
              {"id":2,"coach_id":3,"session_id":11,"lap_id":21,"dist_m":400,"body":"Brake 10 m later here.",
               "created_at":2000,"edited_at":null,"author":$SAM,"mine":false,"seen":true},
              {"id":3,"coach_id":3,"session_id":11,"lap_id":21,"dist_m":null,"body":"Smooth lap.",
               "created_at":3000,"edited_at":null,"author":$SAM,"mine":false,"seen":false}],
             "coaches":[{"id":3,"name":"Sam Lee","picture":null,"active":true}]}
        """

        const val COACH_THREAD = """{"comments":[]}"""

        const val CREATED = """
            {"comment":{"id":9,"coach_id":3,"session_id":11,"lap_id":null,"dist_m":null,"body":"x",
             "created_at":5000,"edited_at":null,"author":{"id":1,"name":"Alex","picture":null},"mine":true,"seen":false}}
        """

        const val FEED = """
            {"unread":1,"comments":[
              {"id":1,"coach_id":3,"session_id":11,"lap_id":null,"dist_m":null,"body":"Good pace all session.",
               "created_at":1000,"edited_at":null,"author":$SAM,"mine":false,"seen":false,"student":null,
               "event_id":5,"track_name":"VIR","start_date":"2026-04-11","session_label":"Session 1","lap_num":null}]}
        """
    }
}
