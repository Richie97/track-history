package app.trackevolution.navigation

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.navigation.compose.rememberNavController
import app.trackevolution.auth.ChecklistTemplateStore
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

    private fun showGraph(dashboardAsDetailPlaceholder: Boolean) {
        val engine = MockEngine { request ->
            val body = when {
                request.url.encodedPath.endsWith("/events") -> "[]"
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
        const val ME = """
            {"user":{"id":1,"email":"e@example.test","name":"Eric","share_slug":"eric"},
             "totals":{"events":1,"track_days":1}}
        """
    }
}
