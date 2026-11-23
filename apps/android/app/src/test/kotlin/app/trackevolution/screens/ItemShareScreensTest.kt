package app.trackevolution.screens

import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.LogbookOwner
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.ItemShareKind
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.ProvideLayoutMetrics
import app.trackevolution.ui.theme.TrackTheme
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Share one event or session (NS-48), one lap or two laps compared (NS-56): the
 * owner's *Share…* dialog, and the read-only page a link opens.
 *
 * Fixtures are the golden contract's own captures, with ids made unique (the
 * capture normalises every id to 1, which a keyed `LazyColumn` refuses).
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp")
class ItemShareScreensTest {

    @get:Rule
    val compose = createComposeRule()

    private val sent = CopyOnWriteArrayList<HttpRequestData>()
    private var online = true
    private var sharedStatus = HttpStatusCode.OK
    private var sharedBody = SHARED_EVENT

    private val api = ApiClient(
        MockEngine { request ->
            sent += request
            val path = request.url.encodedPath
            val method = request.method.value
            if (!online && path.endsWith("/share")) throw IOException("Unable to resolve host")
            when {
                path.startsWith("/api/share/") && sharedStatus != HttpStatusCode.OK ->
                    respond("""{"error":"not found"}""", sharedStatus, JSON)
                path.startsWith("/api/share/") -> respond(sharedBody, HttpStatusCode.OK, JSON)
                path.endsWith("/share") && method == "DELETE" -> respond("""{"ok":true}""", HttpStatusCode.OK, JSON)
                path.endsWith("/events/1/share") -> respond(golden("item-share-event-create"), HttpStatusCode.Created, JSON)
                path.contains("/compare/") && path.endsWith("/share") ->
                    respond(golden("item-share-compare-create"), HttpStatusCode.Created, JSON)
                path.startsWith("/api/laps/") && path.endsWith("/share") ->
                    respond(golden("item-share-lap-create"), HttpStatusCode.Created, JSON)
                path.endsWith("/share") -> respond(golden("item-share-session-create"), HttpStatusCode.Created, JSON)
                path.endsWith("/tracks") -> respond("[]", HttpStatusCode.OK, JSON)
                else -> respond(EVENT_DETAIL, HttpStatusCode.OK, JSON)
            }
        },
        baseUrl = "https://example.test",
        tokens = StaticToken("tok"),
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /** Drains the main looper between checks — see `CoachingScreensTest`. */
    private fun eventually(condition: () -> Boolean) {
        repeat(400) {
            if (condition()) return
            Thread.sleep(25)
            compose.waitForIdle()
        }
        assertTrue("condition never held", condition())
    }

    private fun shown(text: String) = compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()

    private fun tagged(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()

    // ---- The owner's side ---------------------------------------------------

    private fun showEvent(readOnly: Boolean = false) {
        val model = runBlocking {
            EventModel(CoroutineScope(Dispatchers.Default), api, 1).also { model ->
                model.load()
                withTimeout(5_000) { while (model.state != LoadState.Ready) delay(5) }
            }
        }
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
                    )
                }
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun `sharing an event shows its link, and stopping deletes it and closes`() {
        showEvent()
        compose.onNodeWithTag("shareEvent").performClick()
        eventually { tagged("itemShareUrl") }
        assertTrue(shown("https://trackevolution.app/share/e/AAAAAAAAAAAAAAAAAAAAAA"))
        assertTrue(shown(ItemShareText.explanation(ItemShareKind.EVENT)))
        assertTrue(sent.any { it.method.value == "POST" && it.url.encodedPath == "/api/events/1/share" })

        compose.onNodeWithTag("itemShareCopy").performClick()
        compose.waitForIdle()
        eventually { shown(ItemShareText.COPIED) }

        compose.onNodeWithTag("itemShareStop").performClick()
        eventually { !tagged("itemShareDialog") }
        assertTrue(sent.any { it.method.value == "DELETE" && it.url.encodedPath == "/api/events/1/share" })

        // A later Share asks again — the server mints a new link.
        compose.onNodeWithTag("shareEvent").performClick()
        eventually { tagged("itemShareUrl") }
        assertEquals(2, sent.count { it.method.value == "POST" && it.url.encodedPath == "/api/events/1/share" })
    }

    @Test
    fun `a session's card has its own Share, which shares that session`() {
        showEvent()
        compose.onAllNodes(hasScrollAction()).onFirst().performScrollToNode(hasTestTag("shareSession-1"))
        compose.onNodeWithTag("shareSession-1").performClick()
        eventually { tagged("itemShareUrl") }
        assertTrue(shown(ItemShareText.explanation(ItemShareKind.SESSION)))
        assertTrue(sent.any { it.method.value == "POST" && it.url.encodedPath == "/api/sessions/1/share" })
    }

    @Test
    fun `offline, the dialog says sharing needs a connection and queues nothing`() {
        showEvent()
        online = false
        compose.onNodeWithTag("shareEvent").performClick()
        eventually { shown(ItemShareText.NEEDS_CONNECTION) }
        assertTrue(!tagged("itemShareUrl"))
    }

    @Test
    fun `a coach's read-only page offers no Share`() {
        showEvent(readOnly = true)
        assertTrue(!tagged("shareEvent"))
        assertTrue(!tagged("shareSession-1"))
    }

    // ---- One lap (NS-56) ----------------------------------------------------

    private fun showLap(owner: LogbookOwner = LogbookOwner.Me) {
        val model = runBlocking {
            EventModel(CoroutineScope(Dispatchers.Default), api, 1).also { model ->
                model.load()
                withTimeout(5_000) { while (model.state != LoadState.Ready) delay(5) }
            }
        }
        compose.setContent {
            ProvideLayoutMetrics {
                TrackTheme {
                    LapDetailScreen(
                        model = model,
                        sessionId = 1,
                        lapId = 1,
                        canViewChannels = true,
                        onCompare = {},
                        owner = owner,
                    )
                }
            }
        }
        eventually { tagged("lapDetail") }
    }

    @Test
    fun `the lap page's Share shares that lap, in the lap's own words`() {
        showLap()
        compose.onNodeWithTag("shareLap").performClick()
        eventually { tagged("itemShareUrl") }
        assertTrue(shown("https://trackevolution.app/share/l/AAAAAAAAAAAAAAAAAAAAAA"))
        assertTrue(shown(ItemShareText.explanation(ItemShareKind.LAP)))
        assertTrue(sent.any { it.method.value == "POST" && it.url.encodedPath == "/api/laps/1/share" })

        compose.onNodeWithTag("itemShareStop").performClick()
        eventually { !tagged("itemShareDialog") }
        assertTrue(sent.any { it.method.value == "DELETE" && it.url.encodedPath == "/api/laps/1/share" })
    }

    @Test
    fun `a coach's lap page offers no Share`() {
        showLap(owner = LogbookOwner.Student(id = 8, name = "Sam", pro = true))
        assertTrue(!tagged("shareLap"))
    }

    @Test
    fun `a comparison is shared A against B, and never with a lap the server hasn't seen`() {
        compose.setContent { }
        val state = ItemShareState.over(scope, api)
        val target = ItemShareTarget.compare(9, 11)!!
        state.open(target)
        eventually { state.link != null }
        assertEquals(ItemShareKind.COMPARE, state.link?.kind)
        assertTrue(sent.any { it.method.value == "POST" && it.url.encodedPath == "/api/laps/9/compare/11/share" })
        assertEquals(
            "Anyone with this link can see these two laps compared — their times, telemetry and video. " +
                "Nothing else in your logbook is shared.",
            ItemShareText.explanation(ItemShareKind.COMPARE),
        )
        // The same lap twice, a missing lap and a temp id are nothing to share.
        assertNull(ItemShareTarget.compare(9, 9))
        assertNull(ItemShareTarget.compare(9, null))
        assertNull(ItemShareTarget.compare(-3, 11))
    }

    // ---- The page a link opens ----------------------------------------------

    private fun showShared(kind: ItemShareKind = ItemShareKind.EVENT): SharedItemModel {
        val model = SharedItemModel(scope, api, kind, TOKEN)
        compose.setContent {
            ProvideLayoutMetrics {
                TrackTheme { SharedItemScreen(model = model, api = api) }
            }
        }
        eventually { model.state != LoadState.Loading }
        compose.waitForIdle()
        return model
    }

    @Test
    fun `a shared event reads without a token and offers no owner's controls`() {
        showShared()
        assertTrue(shown(TRACK_NAME))
        assertTrue(shown(ItemShareText.byline(ItemShareKind.EVENT, "Dev User")))
        val read = sent.single { it.url.encodedPath == "/api/share/e/$TOKEN" }
        assertNull("a link is read as nobody", read.headers[HttpHeaders.Authorization])
        for (tag in listOf("shareEvent", "shareSession-1", "editSession-1", "eventImportVideo")) {
            assertTrue(tag, !tagged(tag))
        }
        // Laps are rows, not doors: no lap row is clickable into a logbook.
        compose.onNodeWithTag("sharedItem").performScrollToNode(hasTestTag("lap-1"))
        assertTrue(compose.onAllNodesWithTag("lap-1").fetchSemanticsNodes().none { node ->
            node.config.contains(androidx.compose.ui.semantics.SemanticsActions.OnClick)
        })
    }

    @Test
    fun `a free owner's panel says so rather than offering Pro`() {
        sharedBody = sharedJson("shared-event", pro = false)
        showShared()
        compose.onNodeWithTag("sharedItem").performScrollToNode(hasTestTag("sharedCompare-3"))
        compose.onNodeWithTag("sharedCompare-3").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("sharedItem").performScrollToNode(hasTestTag("channelSharedFreeNote"))
        assertTrue(tagged("channelSharedFreeNote"))
        assertTrue(shown(ItemShareText.freeNote("Dev User")))
        assertTrue(!tagged("channelProCard"))
    }

    @Test
    fun `a session link's page is that one session`() {
        sharedBody = sharedJson("shared-session", pro = true)
        showShared(ItemShareKind.SESSION)
        assertTrue(shown(ItemShareText.byline(ItemShareKind.SESSION, "Dev User")))
        assertEquals(1, compose.onAllNodesWithTag("sharedSession-1").fetchSemanticsNodes().size)
        assertTrue(!tagged("sharedSession-2"))
    }

    @Test
    fun `a lap link's page is that one lap`() {
        sharedBody = sharedJson("shared-lap", pro = true)
        showShared(ItemShareKind.LAP)
        assertEquals("A lap shared by Dev User.", ItemShareText.byline(ItemShareKind.LAP, "Dev User"))
        assertTrue(shown(ItemShareText.byline(ItemShareKind.LAP, "Dev User")))
        assertTrue(shown("Lap time"))
        assertTrue(sent.any { it.url.encodedPath == "/api/share/l/$TOKEN" })
        assertEquals(1, compose.onAllNodesWithTag("sharedSession-1").fetchSemanticsNodes().size)
    }

    private fun showSharedCompare(): SharedCompareModel {
        val model = SharedCompareModel(scope, api, TOKEN)
        compose.setContent {
            ProvideLayoutMetrics {
                TrackTheme { SharedCompareScreen(model = model) }
            }
        }
        eventually { model.state != LoadState.Loading }
        compose.waitForIdle()
        return model
    }

    @Test
    fun `a comparison link shows both laps, read as nobody`() {
        sharedBody = golden("shared-compare")
        showSharedCompare()
        assertEquals(
            "Two laps compared, shared by Dev User.",
            ItemShareText.byline(ItemShareKind.COMPARE, "Dev User"),
        )
        assertTrue(shown(ItemShareText.byline(ItemShareKind.COMPARE, "Dev User")))
        val read = sent.single { it.url.encodedPath == "/api/share/c/$TOKEN" }
        assertNull("a link is read as nobody", read.headers[HttpHeaders.Authorization])
        assertTrue(tagged("sharedCompareSides"))
        // The capture's two laps were typed in, so there is nothing to lay over:
        // the page is their times and says why.
        assertTrue(tagged("sharedCompareNoTelemetry"))
        assertTrue(!tagged("sharedCompareFreeNote"))
        assertTrue(!tagged("shareCompare"))
    }

    @Test
    fun `a free owner's comparison is the two times and one sentence, never an upsell`() {
        sharedBody = JsonObject(goldenBody("shared-compare").jsonObject + mapOf("pro" to JsonPrimitive(false))).toString()
        showSharedCompare()
        assertEquals(
            "Dev User is on the free plan, so this link shows the two lap times. " +
                "The comparison shows while they have Pro.",
            ItemShareText.freeCompareNote("Dev User"),
        )
        assertTrue(shown(ItemShareText.freeCompareNote("Dev User")))
        assertTrue(tagged("sharedCompareSides"))
        assertTrue(!tagged("sharedCompareNoTelemetry"))
        assertTrue(!tagged("channelProCard"))
    }

    @Test
    fun `a revoked comparison says so, with no retry`() {
        sharedStatus = HttpStatusCode.NotFound
        val model = showSharedCompare()
        assertTrue(shown(ItemShareText.NOT_FOUND))
        assertTrue(!(model.state as LoadState.Failed).retryable)
    }

    @Test
    fun `a revoked link says so, with no retry`() {
        sharedStatus = HttpStatusCode.NotFound
        val model = showShared()
        assertTrue(shown(ItemShareText.NOT_FOUND))
        val state = model.state as LoadState.Failed
        assertTrue(!state.retryable)
    }

    private companion object {
        val JSON = headersOf(HttpHeaders.ContentType, "application/json")
        const val TOKEN = "AAAAAAAAAAAAAAAAAAAAAA"

        private val repoRoot: File = run {
            var candidate: File? = File(System.getProperty("user.dir")).absoluteFile
            while (candidate != null) {
                if (File(candidate, "package.json").isFile) return@run candidate
                candidate = candidate.parentFile
            }
            error("repository root not found above ${System.getProperty("user.dir")}")
        }

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

        fun sharedJson(name: String, pro: Boolean): String {
            val body = goldenBody(name).jsonObject
            return JsonObject(
                body + mapOf(
                    "event" to uniqueIds(body["event"]!!.jsonObject),
                    "pro" to JsonPrimitive(pro),
                ),
            ).toString()
        }

        val EVENT_DETAIL: String = uniqueIds(goldenBody("event-detail").jsonObject).toString()
        val SHARED_EVENT: String = sharedJson("shared-event", pro = true)
        val TRACK_NAME: String = goldenBody("shared-event").jsonObject["event"]!!.jsonObject["track_name"]
            .toString().trim('"')
    }
}
