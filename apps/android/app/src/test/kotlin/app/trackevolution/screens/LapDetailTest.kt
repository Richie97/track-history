package app.trackevolution.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import app.trackevolution.core.LapTime
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.EventDetail
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.Session
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.core.model.TracePoint
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.ProvideLayoutMetrics
import app.trackevolution.ui.theme.TrackTheme
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * The lap detail (#268): the rules behind it, pure, and the screen over the
 * golden contract's own event — the same fixture `EventLayoutTest` renders,
 * for the same reason (models decode with `ignoreUnknownKeys = false`, so an
 * invented payload fails to decode rather than to render).
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w400dp-h900dp")
class LapDetailTest {

    @get:Rule
    val compose = createComposeRule()

    // ---- the rules ---------------------------------------------------------

    private fun lap(id: Int, num: Int, ms: Int) = Lap(id = id, sessionId = 10, lapNum = num, timeMs = ms)

    private fun entry(n: Int, ms: Int) = LapChannels(n, ms, speed = List(40) { 100.0 + it % 7 })

    /** Twelve points is above `TrackMap`'s floor of ten. */
    private val trace = List(12) { TracePoint(x = it.toDouble(), y = it * 2.0, v = 30.0) }

    private fun session(
        laps: List<Lap>,
        channels: SessionChannels? = null,
        trace: List<TracePoint>? = null,
    ) = Session(id = 10, label = "Session 2", sort = 1, channels = channels, laps = laps, trace = trace)

    private fun detail(session: Session) = EventDetail(
        event = json.decodeFromJsonElement(Event.serializer(), goldenEvent),
        sessions = listOf(session),
        setups = emptyList(),
    )

    @Test
    fun `the best lap gets the racing line and the others do not`() {
        val d = detail(session(listOf(lap(1, 1, 125_000), lap(2, 2, 121_500), lap(3, 3, 123_000)), trace = trace))

        val best = LapDetail.build(d, sessionId = 10, lapId = 2)!!
        assertTrue(best.isBest)
        assertEquals(0, best.gapMs)
        assertEquals("the stored trace is the best lap's", 12, best.trace?.size)
        assertEquals("Lap 2 of 3 · Session 2 · ★ best of the session", best.subtitle)

        val other = LapDetail.build(d, sessionId = 10, lapId = 3)!!
        assertFalse(other.isBest)
        assertEquals(1_500, other.gapMs)
        assertNull("a slower lap was never on the stored line", other.trace)
        assertEquals("Lap 3 of 3 · Session 2 · ${LapTime.fmtDelta(1_500)} vs best", other.subtitle)
    }

    @Test
    fun `a short trace draws no map`() {
        val d = detail(session(listOf(lap(1, 1, 121_500)), trace = trace.take(5)))
        assertNull(LapDetail.build(d, sessionId = 10, lapId = 1)!!.trace)
    }

    @Test
    fun `the lap's own entry is carved out alone, and the compare lights it beside the best`() {
        // Lap 2 was added by hand after the import, so it has no entry.
        val s = session(
            listOf(lap(1, 1, 125_000), lap(2, 2, 130_000), lap(3, 3, 121_500)),
            channels = SessionChannels(v = 1, dStepM = 20.0, laps = listOf(entry(1, 125_000), entry(3, 121_500))),
        )
        val d = detail(s)

        val first = LapDetail.build(d, sessionId = 10, lapId = 1)!!
        assertEquals(0, first.chIdx)
        assertEquals("one entry, this lap's", listOf(125_000), first.channels?.laps?.map { it.timeMs })
        assertEquals(20.0, first.channels?.dStepM)
        assertEquals("this lap first, the best beside it", listOf(0, 1), LapDetail.comparePreselect(s, 1))
        assertTrue(first.canCompare)

        assertEquals("the best alone: nothing to put beside it", listOf(1), LapDetail.comparePreselect(s, 3))

        val handAdded = LapDetail.build(d, sessionId = 10, lapId = 2)!!
        assertNull(handAdded.channels)
        assertNull(handAdded.chIdx)
        assertNull("nothing of its own to light; the panel picks the fastest", LapDetail.comparePreselect(s, 2))
        assertNull("no lap named: the panel's default", LapDetail.comparePreselect(s, null))
        assertTrue("the session still has an overlay to open", handAdded.canCompare)
    }

    @Test
    fun `a hand-entered session has nothing to compare`() {
        val s = session(listOf(lap(1, 1, 125_000)))
        val view = LapDetail.build(detail(s), sessionId = 10, lapId = 1)!!
        assertNull(view.channels)
        assertNull(view.trace)
        assertFalse(view.canCompare)
        assertNull(LapDetail.comparePreselect(s, 1))
    }

    @Test
    fun `a missing session or lap is null`() {
        val d = detail(session(listOf(lap(1, 1, 125_000))))
        assertNull(LapDetail.build(d, sessionId = 10, lapId = 99))
        assertNull(LapDetail.build(d, sessionId = 99, lapId = 1))
    }

    // ---- the screen --------------------------------------------------------

    /**
     * A hand-entered lap is a time and a sentence: no map, no compare, nothing
     * drawn empty. The golden's ids are all 1, so this is session 1's first lap.
     */
    @Test
    fun `renders a hand-entered lap as its time and a sentence`() {
        val model = loadedModel()
        compose.setContent {
            ProvideLayoutMetrics {
                TrackTheme {
                    LapDetailScreen(
                        model = model,
                        sessionId = 1,
                        lapId = 1,
                        canViewChannels = true,
                        onCompare = {},
                    )
                }
            }
        }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag("lapDetail").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(LapTime.fmtMs(firstLapMs)).assertIsDisplayed()
        compose.onNodeWithText("Lap 1 of 4", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("compareLaps").assertDoesNotExist()
        compose.onNodeWithTag("trackMap").assertDoesNotExist()
        compose.onNodeWithTag("lapFacts").assertDoesNotExist()
        compose.onNodeWithText("No telemetry for this lap", substring = true).assertIsDisplayed()
    }

    private fun loadedModel(): EventModel = runBlocking {
        val engine = MockEngine { request ->
            val body = if (request.url.encodedPath.endsWith("/tracks")) "[]" else detailJson
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val model = EventModel(
            CoroutineScope(Dispatchers.Default),
            ApiClient(engine, baseUrl = "https://example.test"),
            1,
        )
        model.load()
        withTimeout(5_000) { while (model.state != LoadState.Ready) delay(5) }
        model
    }

    private companion object {
        private val repoRoot: File = run {
            var candidate: File? = File(System.getProperty("user.dir")).absoluteFile
            while (candidate != null) {
                if (File(candidate, "package.json").isFile) return@run candidate
                candidate = candidate.parentFile
            }
            error("repository root not found above ${System.getProperty("user.dir")}")
        }

        private val json = Json { ignoreUnknownKeys = false }

        private val golden = Json.parseToJsonElement(
            File(repoRoot, "contracts/golden/event-detail.json").readText(),
        ).jsonObject

        private val detailJson: String = golden["body"].toString()

        /** The event half of the golden detail, for the pure tests' `EventDetail`. */
        private val goldenEvent = Json.parseToJsonElement(detailJson).jsonObject.let { body ->
            kotlinx.serialization.json.JsonObject(body.filterKeys { it != "sessions" && it != "setups" })
        }

        private val firstLapMs: Int = 128_400
    }
}
