package app.trackevolution.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.navigation.compose.rememberNavController
import app.trackevolution.auth.ChecklistTemplateStore
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.model.Entitlement
import app.trackevolution.navigation.AppNavHost
import app.trackevolution.recording.RecorderState
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.theme.ThemeChoice
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.LocalDate

/**
 * The dashboard's door into the recorder (#108).
 *
 * Two things are worth asserting and one deliberately isn't. The **target
 * event** matters because a recording that lands in the wrong event silently
 * corrupts a logbook entry — though the rule itself is `RemoteRecording`'s and
 * is pinned against the web implementation by `contracts/logic/remote-attach.json`
 * in `RemoteRecordingTest`, so what is tested here is that the dashboard asks it
 * rather than inventing a second answer. The **idle-only** rule matters because
 * a second control offering to start a recording while one is already running is
 * how you end up with two answers to "what is the recorder doing".
 *
 * What isn't re-tested is the attachment arithmetic — fractional days, the tie
 * break, the local-vs-UTC date. That lives one layer down and has the contract
 * fixture behind it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp")
class DashboardRecordTest {

    @get:Rule
    val compose = createComposeRule()

    private val today: String = LocalDate.now().toString()
    private val lastMonth: String = LocalDate.now().minusMonths(1).toString()

    /** The template store is only ever touched by Settings, which never composes here. */
    private object NoTemplate : ChecklistTemplateStore {
        override val items: List<String> = emptyList()
        override suspend fun set(items: List<String>) = Unit
    }

    private fun api(events: String): ApiClient {
        val engine = MockEngine { request ->
            val path = request.url.encodedPath
            val body = when {
                path.endsWith("/events") -> events
                path.endsWith("/tracks") -> "[]"
                path.endsWith("/garage") -> "[]"
                path.endsWith("/me") -> ME
                else -> """{"ok":true}"""
            }
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        return ApiClient(engine, baseUrl = "https://example.test")
    }

    /**
     * Real dispatchers, as the other model tests do: the HTTP call runs on the
     * client's own dispatcher, which a `TestScope` scheduler never drives.
     */
    private fun loadedModel(events: String): DashboardModel = runBlocking {
        val model = DashboardModel(CoroutineScope(Dispatchers.Default), api(events))
        model.load()
        withTimeout(5_000) {
            while (model.state != LoadState.Ready) delay(5)
        }
        model
    }

    // ---- which event the laps land in --------------------------------------

    @Test
    fun `todays event is the one whose days cover today`() {
        val model = loadedModel(eventsJson(startDate = today, days = 1))
        assertEquals(7, model.todaysEvent?.id)
    }

    @Test
    fun `no event today records unattached rather than guessing at a near one`() {
        val model = loadedModel(eventsJson(startDate = lastMonth, days = 1))
        assertNull(
            "an event a month ago must not adopt today's recording",
            model.todaysEvent,
        )
    }

    // ---- what the button says ----------------------------------------------

    /**
     * The label is the screen reader's only route to where the laps are going —
     * the visible text can't carry a subtitle without pushing the fold down on
     * every day that isn't a track day. Same wording as iOS, deliberately.
     */
    @Test
    fun `content description names the target event`() {
        val model = loadedModel(eventsJson(startDate = today, days = 1))
        setDashboard(model, recorderIdle = true)
        compose.waitUntil(10_000) { model.state == LoadState.Ready }

        compose.onNodeWithContentDescription("Record laps at Summit Point (Shenandoah)")
            .assertIsDisplayed()
    }

    @Test
    fun `content description says so when there is no event today`() {
        val model = loadedModel(eventsJson(startDate = lastMonth, days = 1))
        setDashboard(model, recorderIdle = true)
        compose.waitUntil(10_000) { model.state == LoadState.Ready }

        compose.onNodeWithContentDescription(
            "Record laps. No event today — the recording is saved to one afterwards.",
        ).assertIsDisplayed()
    }

    // ---- idle only ---------------------------------------------------------

    @Test
    fun `the button is not drawn while the recorder is busy`() {
        val model = loadedModel(eventsJson(startDate = today, days = 1))
        setDashboard(model, recorderIdle = false)
        compose.waitUntil(10_000) { model.state == LoadState.Ready }

        compose.onNodeWithTag("dashboardRecord").assertDoesNotExist()
    }

    // ---- dashboard to a recorder ready to start ----------------------------

    /**
     * The whole path through the real graph: the dashboard's button, the route
     * it navigates to, and a record screen that is ready to start. Stops at
     * Start rather than pressing it — recording end to end needs location fixes,
     * which is `RecorderCore`'s territory and not a UI question.
     */
    @Test
    fun `tapping it lands on the record screen ready to start`() {
        val api = api(eventsJson(startDate = today, days = 1))
        var startedWith: Int? = null
        var started = false

        compose.setContent {
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
                    onStartRecording = { startedWith = it; started = true },
                    onStopRecording = {},
                    onSignOut = {},
                    // Pro: the recorder's Start is gated since phase D, and
                    // this test is about where the laps get filed, not about
                    // the paywall (which EntitlementTest covers).
                    entitlement = PRO,
                )
            }
        }

        compose.waitUntil(15_000) {
            compose.onAllNodesWithTag("dashboardRecord").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("dashboardRecord").performClick()

        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Start recording").fetchSemanticsNodes().isNotEmpty()
        }

        // The screen must agree with the button that opened it. It used to say
        // "Not attached to an event yet" here — the laps were filed correctly,
        // but a driver reading this line was told the opposite of what the
        // button's own label had just promised.
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Laps will be saved to Summit Point (Shenandoah).")
                .fetchSemanticsNodes().isNotEmpty()
        }

        compose.onNodeWithText("Start recording").assertIsDisplayed().performClick()

        assertEquals("the recording should attach to today's event", 7, startedWith)
        assert(started)
    }

    // ---- helpers -----------------------------------------------------------

    private val PRO = Entitlement(tier = Entitlement.Tier.PRO, source = Entitlement.Source.GOOGLE, expiresAt = null)

    private fun setDashboard(model: DashboardModel, recorderIdle: Boolean) {
        compose.setContent {
            TrackTheme {
                DashboardScreen(
                    model = model,
                    onOpenEvent = {},
                    onOpenTrack = {},
                    onOpenVehicle = {},
                    onNewEvent = {},
                    onOpenSettings = {},
                    onRecord = {},
                    recorderIdle = recorderIdle,
                )
            }
        }
    }

    private fun eventsJson(startDate: String, days: Int) = """
        [{"id":7,"track_id":1,"track_name":"Summit Point (Shenandoah)",
          "start_date":"$startDate","days":$days,"lap_count":0,"session_count":0,
          "hours":2,"updated_at":1}]
    """

    private companion object {
        const val ME = """
            {"user":{"id":1,"email":"e@example.test","name":"Eric","share_slug":"eric"},
             "totals":{"events":1,"track_days":1}}
        """
    }
}
