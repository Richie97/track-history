package app.trackevolution.screens

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.Session
import app.trackevolution.core.model.SessionChannels
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
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * The event page's analysis column (spec: NS-34 ticket 3).
 *
 * The spec's acceptance for this platform is "Robolectric under `w840dp`: panel
 * beside the map; under `w600dp`: the existing layout". Both halves matter, and
 * the second one more: the phone page is what almost every user sees, and a
 * column that leaked into it would be a regression nothing else catches.
 *
 * The event is the **golden contract's** own event detail rather than a
 * hand-written fixture. Models decode with `ignoreUnknownKeys = false`, so an
 * invented payload fails to decode rather than to render, and the failure looks
 * like a layout bug — which is exactly what happened writing this.
 */
@RunWith(RobolectricTestRunner::class)
class EventLayoutTest {

    @get:Rule
    val compose = createComposeRule()

    @Test
    @Config(qualifiers = "w1100dp-h800dp")
    fun `an expanded window puts the analysis beside the page`() {
        showEvent()

        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag("analysisColumn").fetchSemanticsNodes().isNotEmpty()
        }
        // The page is still there beside it — this is a column, not a replacement.
        assertTrue(
            "the event page should still be showing",
            compose.onAllNodesWithText(trackName).fetchSemanticsNodes().isNotEmpty(),
        )
    }

    @Test
    @Config(qualifiers = "w600dp-h900dp")
    fun `a medium window keeps the single-column page`() {
        showEvent()

        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(trackName).fetchSemanticsNodes().isNotEmpty()
        }
        assertEquals(
            "there is no analysis column below expanded width",
            0,
            compose.onAllNodesWithTag("analysisColumn").fetchSemanticsNodes().size,
        )
    }

    @Test
    @Config(qualifiers = "w400dp-h900dp")
    fun `a phone keeps the single-column page`() {
        showEvent()

        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(trackName).fetchSemanticsNodes().isNotEmpty()
        }
        assertEquals(0, compose.onAllNodesWithTag("analysisColumn").fetchSemanticsNodes().size)
    }

    /**
     * Which session the column opens on.
     *
     * Two conditions, not one — the best lap *among those that stored channels* —
     * and a quicker session without them is exactly the case that gets it wrong.
     * Pure, so it is checked directly rather than inferred from what is on screen.
     */
    @Test
    fun `the column opens on the best lap that has channels`() {
        val quickerWithoutChannels = session(id = 1, timeMs = 90_000, channels = null)
        val slowerWithChannels = session(
            id = 2,
            timeMs = 95_000,
            channels = SessionChannels(v = 1, dStepM = 20.0, laps = emptyList()),
        )
        assertEquals(
            "analysis it can draw beats a faster lap it cannot",
            2,
            defaultChannelSession(listOf(quickerWithoutChannels, slowerWithChannels))?.id,
        )
        assertEquals(
            "no channels anywhere is an empty column, not an arbitrary session",
            null,
            defaultChannelSession(listOf(quickerWithoutChannels)),
        )
    }

    private fun session(id: Int, timeMs: Int, channels: SessionChannels?) = Session(
        id = id,
        label = "Session $id",
        sort = id,
        channels = channels,
        laps = listOf(Lap(id = id, sessionId = id, lapNum = 1, timeMs = timeMs)),
    )

    private fun showEvent() {
        val model = loadedModel()
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
                    )
                }
            }
        }
    }

    private fun loadedModel(): EventModel = runBlocking {
        // `load()` fetches the event *and* the track list, concurrently. Answering
        // both with the event would fail the second decode, and the model treats a
        // failed load as a blank screen — which reads exactly like a broken layout.
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
        /** The repository root, found the way `:core`'s `RepoRoot` finds it. */
        private val repoRoot: File = run {
            var candidate: File? = File(System.getProperty("user.dir")).absoluteFile
            while (candidate != null) {
                if (File(candidate, "package.json").isFile) return@run candidate
                candidate = candidate.parentFile
            }
            error("repository root not found above ${System.getProperty("user.dir")}")
        }

        private val golden = Json.parseToJsonElement(
            File(repoRoot, "contracts/golden/event-detail.json").readText(),
        ).jsonObject

        val detailJson: String = golden["body"].toString()
        val trackName: String = golden["body"]!!.jsonObject["track_name"].toString().trim('"')
    }
}
