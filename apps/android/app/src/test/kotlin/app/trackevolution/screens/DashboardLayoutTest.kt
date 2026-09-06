package app.trackevolution.screens

import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import app.trackevolution.core.api.ApiClient
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.PageColumn
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The dashboard's card grid at each layout class (spec: NS-34, ticket 1).
 *
 * What is worth asserting here is not the arithmetic — `LayoutClassTest` pins
 * that against the web's `auto-fill` rule — but that the screen is *wired* to it:
 * that the tracks grid takes a second column when the window has room, and, at
 * least as importantly, that a phone still gets exactly one card per row. The
 * spec's first acceptance criterion is that the compact layout is unchanged, and
 * a grid is the easiest way to break it by accident.
 *
 * Two cards are on the same row when they share a top edge, which is a claim
 * about layout that survives a restyle — unlike counting pixels.
 */
@RunWith(RobolectricTestRunner::class)
class DashboardLayoutTest {

    @get:Rule
    val compose = createComposeRule()

    @Test
    @Config(qualifiers = "w400dp-h900dp")
    fun `a phone puts one track card per row`() {
        showDashboard()
        assertEquals("compact must stay one column", 1, cardsOnTheFirstRow())
    }

    /**
     * 700dp: a folded-open Fold's half, or a tablet in portrait. The column is
     * capped and centred here, and 700 − 2 × 28 = 644 fits two 280dp cards.
     */
    @Test
    @Config(qualifiers = "w700dp-h1000dp")
    fun `a medium window puts two track cards per row`() {
        showDashboard()
        assertEquals(2, cardsOnTheFirstRow())
    }

    /** 1000 − 2 × 28 = 944, which fits three 280dp cards (3 × 280 + 2 × 12 = 864). */
    @Test
    @Config(qualifiers = "w1000dp-h800dp")
    fun `an expanded window puts three track cards per row`() {
        showDashboard()
        assertEquals(3, cardsOnTheFirstRow())
    }

    /**
     * The page stops at `--page-max` rather than running to the window's edge.
     *
     * Asserted on a window wider than the cap, since that is the only place the
     * cap does anything — and it is the case that made the app look worse than
     * the same logbook in a browser beside it.
     */
    @Test
    @Config(qualifiers = "w1400dp-h900dp")
    fun `the content column stops at page-max`() {
        showDashboard()
        val card = compose.onNodeWithText(FIRST_TRACK).getBoundsInRoot()
        // The card sits inside the capped column, so its right edge cannot be
        // out at the window's.
        assertTrue(
            "the page should be capped well inside a 1400dp window, card ended at ${card.right}",
            card.right.value < 1200f,
        )
    }

    // ---- helpers -----------------------------------------------------------

    /**
     * How many track cards share the topmost row.
     *
     * Found by taking the smallest top edge rather than by assuming which card
     * comes first: the dashboard orders tracks by their last event, most recent
     * first, so the card at the top is a property of the fixture and not
     * something a layout test should be asserting by accident.
     */
    private fun cardsOnTheFirstRow(): Int {
        val tops = TRACK_NAMES.mapNotNull { name ->
            val nodes = compose.onAllNodesWithText(name)
            if (nodes.fetchSemanticsNodes().isEmpty()) null else nodes.onFirst().getBoundsInRoot().top
        }
        val first = tops.minOrNull() ?: return 0
        // Same row = same top edge. A dp of rounding is not a new row.
        return tops.count { kotlin.math.abs((it - first).value) < 2f }
    }

    private fun showDashboard() {
        val model = loadedModel()
        compose.setContent {
            ProvideLayoutMetrics {
                TrackTheme {
                    // Through the page column, as `AppNavHost.pageComposable`
                    // composes it — the cap is part of the page, not of the test.
                    PageColumn {
                        DashboardScreen(
                            model = model,
                            onOpenEvent = {},
                            onOpenTrack = {},
                            onOpenVehicle = {},
                            onNewEvent = {},
                            onOpenSettings = {},
                            onRecord = {},
                            recorderIdle = true,
                        )
                    }
                }
            }
        }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(FIRST_TRACK).fetchSemanticsNodes().isNotEmpty()
        }
    }

    /** Real dispatchers, as the other dashboard tests do — see `DashboardRecordTest`. */
    private fun loadedModel(): DashboardModel = runBlocking {
        val engine = MockEngine { request ->
            val body = when {
                request.url.encodedPath.endsWith("/tracks") -> TRACKS
                request.url.encodedPath.endsWith("/events") -> "[]"
                request.url.encodedPath.endsWith("/garage") -> "[]"
                request.url.encodedPath.endsWith("/me") -> ME
                else -> """{"ok":true}"""
            }
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val model = DashboardModel(CoroutineScope(Dispatchers.Default), ApiClient(engine, baseUrl = "https://example.test"))
        model.load()
        withTimeout(5_000) { while (model.state != LoadState.Ready) delay(5) }
        model
    }

    private companion object {
        val TRACK_NAMES = listOf("Summit Point", "Watkins Glen", "Virginia International Raceway", "Dominion Raceway")
        const val FIRST_TRACK = "Summit Point"

        const val ME = """
            {"user":{"id":1,"email":"e@example.test","name":"Eric","share_slug":"eric"},
             "totals":{"events":1,"track_days":1}}
        """

        /** Four tracks, most recent first, so a row can hold more than one. */
        val TRACKS: String = TRACK_NAMES.mapIndexed { index, name ->
            """
            {"id":${index + 1},"name":"$name","event_count":2,"track_days":3,"best_ms":121500,
             "goal_ms":null,"last_date":"2026-0${index + 1}-01","notes":null,"catalog_id":null,
             "series":[],"updated_at":0}
            """.trimIndent()
        }.joinToString(",", prefix = "[", postfix = "]")
    }
}
