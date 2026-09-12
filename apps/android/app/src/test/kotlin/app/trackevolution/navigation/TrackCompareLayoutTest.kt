package app.trackevolution.navigation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.rememberNavController
import app.trackevolution.auth.ChecklistTemplateStore
import app.trackevolution.auth.UnitsStore
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.api.ApiClient
import app.trackevolution.recording.RecorderState
import app.trackevolution.ui.PaneWidth
import app.trackevolution.ui.ProvideLayoutMetrics
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.ui.theme.TrackTheme
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * Where the two-lap compare opens (spec: NS-34 ticket 3).
 *
 * Beside the track page when the page's own column has room for two, and as its
 * own destination when it does not. The arithmetic is
 * `LayoutMetrics.sideColumnWidth` and `LayoutClassTest` pins it; what this pins
 * is that the *track page asks it* — which is the half that shipped wrong.
 *
 * It read the window's [app.trackevolution.ui.LayoutClass] instead, and the two
 * answers disagree in exactly one place, which is also a common one: a tablet in
 * portrait is an expanded **window** whose detail pane has around 627dp to give.
 * Splitting that put the compare in its 380dp floor and left the track page about
 * 230dp. The event and vehicle pages took this fix in `c1f9300`; this one lives
 * in the graph rather than in `TrackScreen`, and was missed with it.
 *
 * The claim asserted is behavioural rather than geometric — after tapping
 * *Compare laps*, is the track page still on screen beside it? — because that is
 * the difference between a column and a destination, and it stays true whatever
 * widths the two containers go on to choose.
 */
@RunWith(RobolectricTestRunner::class)
class TrackCompareLayoutTest {

    @get:Rule
    val compose = createComposeRule()

    private object NoTemplate : ChecklistTemplateStore {
        override val items: List<String> = emptyList()
        override suspend fun set(items: List<String>) = Unit
    }

    private object NoUnits : UnitsStore {
        override val units: UnitSystem = UnitSystem.IMPERIAL
        override suspend fun set(units: UnitSystem) = Unit
    }

    @Test
    @Config(qualifiers = "w1400dp-h1000dp")
    fun `a wide page opens the compare beside it`() {
        showTrack(paneWidth = null)
        tapCompare()

        assertTrue(
            "the track page should still be showing beside the compare column",
            compose.onAllNodesWithText(PAGE_MARKER).fetchSemanticsNodes().isNotEmpty(),
        )
    }

    /**
     * The portrait-tablet case: an expanded window, and a detail pane with no
     * room for two columns. The compare is a destination there, so the page it
     * came from is gone rather than squeezed into a quarter of the pane.
     */
    @Test
    @Config(qualifiers = "w1000dp-h1300dp")
    fun `a narrow pane in an expanded window opens the compare as a destination`() {
        showTrack(paneWidth = 627.dp)
        tapCompare()

        assertTrue(
            "the compare should have replaced the page, not split it",
            compose.onAllNodesWithText(PAGE_MARKER).fetchSemanticsNodes().isEmpty(),
        )
    }

    private fun tapCompare() {
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Compare laps").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Compare laps").performClick()
        compose.waitForIdle()
    }

    /**
     * The graph, opened on the track page — and optionally inside a pane of a
     * fixed width, which is what the two-pane shell hands the detail.
     */
    private fun showTrack(paneWidth: Dp?) {
        val engine = MockEngine { request ->
            val path = request.url.encodedPath
            val body = when {
                path.endsWith("/tracks") -> tracksJson
                path.endsWith("/events") -> eventsJson
                path.endsWith("/garage") -> "[]"
                path.endsWith("/me") -> ME
                else -> """{"ok":true}"""
            }
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val api = ApiClient(engine, baseUrl = "https://example.test")
        compose.setContent {
            ProvideLayoutMetrics {
                TrackTheme {
                    val graph = @Composable {
                        val nav = rememberNavController()
                        LaunchedEffect(Unit) { nav.navigate(Route.Track(trackId)) }
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
                        )
                    }
                    if (paneWidth == null) {
                        graph()
                    } else {
                        // Exactly what `TwoPaneShell` does to the detail: a real
                        // width constraint, with the metrics republished for it
                        // while the *window's* class stays expanded. Reading that
                        // class is the fault; reading this width is the fix.
                        Box(Modifier.width(paneWidth)) { PaneWidth { graph() } }
                    }
                }
            }
        }
    }

    private companion object {
        const val ME = """
            {"user":{"id":1,"email":"e@example.test","name":"Eric","share_slug":"eric"},
             "totals":{"events":1,"track_days":1}}
        """

        private val repoRoot: File = run {
            var candidate: File? = File(System.getProperty("user.dir")).absoluteFile
            while (candidate != null) {
                if (File(candidate, "package.json").isFile) return@run candidate
                candidate = candidate.parentFile
            }
            error("could not find the repository root")
        }

        /**
         * A line only the track page draws — the compare screen's own heading is
         * "Compare two laps". Marking the page by its heading rather than by the
         * track name keeps the assertion about which *screen* is on show.
         */
        const val PAGE_MARKER = "Personal best "

        // The golden contract's own bodies, one row each: models decode with
        // ignoreUnknownKeys = false, so an invented payload fails to decode
        // rather than to render, and that failure looks like a layout bug. One
        // row because these captures are per-endpoint rather than one coherent
        // dataset and every row in them carries id 1 — three of those in a
        // keyed grid is a duplicate-key crash, not a layout to assert about.
        private fun goldenBody(name: String) =
            Json.parseToJsonElement(File(repoRoot, "contracts/golden/$name").readText())
                .jsonObject["body"]!!.jsonArray

        // The track with laps behind it, and the event that has them: the
        // compare is only offered where there is something to compare.
        private val track = goldenBody("tracks-list.json")
            .map { it.jsonObject }
            .first { it["name"].toString().trim('"') == TRACK }
        private val event = goldenBody("events-list.json")
            .map { it.jsonObject }
            .first { it["track_name"].toString().trim('"') == TRACK }

        const val TRACK = "Virginia International Raceway (Full)"
        val tracksJson: String = "[$track]"
        val eventsJson: String = "[$event]"
        val trackId: Int = track["id"].toString().trim('"').toInt()
    }
}
