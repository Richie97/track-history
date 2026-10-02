package app.trackevolution.navigation

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.navigation.compose.rememberNavController
import app.trackevolution.auth.ChecklistTemplateStore
import app.trackevolution.auth.UnitsStore
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.api.ApiClient
import app.trackevolution.recording.RecorderState
import app.trackevolution.ui.ProvideLayoutMetrics
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.ui.theme.TrackTheme
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * What the detail pane shows when nothing is selected (spec: NS-34 ticket 2).
 *
 * The spec rules one thing out by name — the detail pane must **never show the
 * dashboard twice** — and the way this implementation honours it is subtle enough
 * to be worth a test: `Route.Dashboard` stays the graph's start destination at
 * every width (so deep links, `popUpTo` and back all keep working), and only what
 * that destination *draws* changes. A regression here looks like two identical
 * dashboards side by side, which nothing else would catch.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w1000dp-h800dp")
class DetailPaneTest {

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
    fun `the start destination draws the empty state when the dashboard is the list pane`() {
        showGraph(dashboardAsDetailPlaceholder = true)

        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Pick an event").fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue(
            "the detail pane must not be a second dashboard",
            compose.onAllNodesWithText("+ Add event").fetchSemanticsNodes().isEmpty(),
        )
    }

    @Test
    fun `the start destination is the dashboard when there is no list pane`() {
        showGraph(dashboardAsDetailPlaceholder = false)

        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("+ Add event").fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue(
            "the empty state belongs to the detail pane only",
            compose.onAllNodesWithText("Pick an event").fetchSemanticsNodes().isEmpty(),
        )
    }

    /** With nothing logged both halves say so (#344): the welcome card, and a pane that won't ask for a pick. */
    @Test
    fun `an empty logbook says so in both panes`() {
        showGraph(dashboardAsDetailPlaceholder = true, events = "[]")
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Add your first event and it opens here.").fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue(compose.onAllNodesWithText("Pick an event").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun `an empty logbook's dashboard is the welcome card`() {
        showGraph(dashboardAsDetailPlaceholder = false, events = "[]")
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Welcome to Track Evolution").fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue(compose.onAllNodesWithText("+ Add event").fetchSemanticsNodes().isEmpty())
    }

    private fun showGraph(dashboardAsDetailPlaceholder: Boolean, events: String = ONE_EVENT) {
        val engine = MockEngine { request ->
            val body = when {
                request.url.encodedPath.endsWith("/events") -> events
                request.url.encodedPath.endsWith("/tracks") -> "[]"
                request.url.encodedPath.endsWith("/garage") -> "[]"
                request.url.encodedPath.endsWith("/me") -> ME
                else -> """{"ok":true}"""
            }
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val api = ApiClient(engine, baseUrl = "https://example.test")
        compose.setContent {
            ProvideLayoutMetrics {
                TrackTheme {
                    AppNavHost(
                        nav = rememberNavController(),
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
                        dashboardAsDetailPlaceholder = dashboardAsDetailPlaceholder,
                    )
                }
            }
        }
    }

    private companion object {
        /** One past event, so the dashboard is a logbook rather than the welcome card. */
        const val ONE_EVENT = """[{"id":7,"track_id":1,"track_name":"Summit Point","start_date":"2026-01-01","days":1,"lap_count":0,"session_count":0,"hours":2,"updated_at":1}]"""

        const val ME = """
            {"user":{"id":1,"email":"e@example.test","name":"Eric","share_slug":"eric"},
             "totals":{"events":1,"track_days":1}}
        """
    }
}
