package app.trackevolution.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performTextReplacement
import app.trackevolution.core.EventDates
import app.trackevolution.core.api.ApiClient
import io.ktor.http.content.TextContent
import app.trackevolution.ui.LoadState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import app.trackevolution.ui.theme.TrackTheme
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Equipped switch (migration 0029) and where in a track day a swap sits
 * (migration 0030), driven through the vehicle page: turning a spare on is one
 * tap with no point, taking one off confirms with its date and — on a track
 * day — the "When in the day" picker, and the edit form moves when a part went
 * on through `PUT /parts/:id/mount`. The wording and the choices are pure and
 * pinned in `GarageTest` / `GarageSwapTest`; this is the wiring.
 *
 * Tall for the reason `VehicleFormCatalogTest` gives: the page is one
 * `LazyColumn`, and a card below the fold is not composed at all.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w480dp-h3200dp")
class VehicleEquipTest {

    @get:Rule
    val compose = createComposeRule()

    private val sent = java.util.concurrent.CopyOnWriteArrayList<HttpRequestData>()

    private val today = EventDates.todayIso()

    /** The cached `/events`; empty unless a test puts a track day on the car. */
    private var events = "[]"

    private fun api(): ApiClient = ApiClient(
        MockEngine { request ->
            sent += request
            val path = request.url.encodedPath
            when {
                path.endsWith("/garage") -> respond(GARAGE, HttpStatusCode.OK, JSON)
                path.endsWith("/vehicles") -> respond(VEHICLES, HttpStatusCode.OK, JSON)
                path.endsWith("/events") -> respond(events, HttpStatusCode.OK, JSON)
                path.endsWith("/events/5") -> respond(eventDetail(today), HttpStatusCode.OK, JSON)
                path.endsWith("/mount") -> respond("""{"ok":true,"moved":[]}""", HttpStatusCode.OK, JSON)
                path.endsWith("/equip") -> respond("""{"ok":true,"unequipped":[11]}""", HttpStatusCode.OK, JSON)
                else -> respond("""{"ok":true}""", HttpStatusCode.OK, JSON)
            }
        },
        baseUrl = "https://example.test",
    )

    /**
     * Loaded before it is composed, as the other screen tests do: a model still
     * loading draws a spinner, and an infinite animation never lets Compose idle.
     */
    private fun show() {
        val model = runBlocking {
            val model = VehicleModel(CoroutineScope(Dispatchers.Default), api(), vehicleId = 1)
            model.load()
            withTimeout(5_000) { while (model.state == LoadState.Loading) delay(5) }
            model
        }
        compose.setContent { TrackTheme { VehicleScreen(model) } }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("equip-13").fetchSemanticsNodes().isNotEmpty() }
    }

    private fun bodyText(suffix: String): String {
        compose.waitUntil(5_000) { sent.any { it.url.encodedPath.endsWith(suffix) } }
        return (sent.first { it.url.encodedPath.endsWith(suffix) }.body as TextContent).text
    }

    @Test
    fun `equipping a spare is one tap and names no point in the day`() {
        // Migration 0030: no confirm row — today, at the server's point.
        show()
        compose.onNodeWithText("Spares").assertIsDisplayed()
        compose.onNodeWithTag("equip-13").performClick()
        assertEquals("{}", bodyText("/parts/13/equip"))
    }

    @Test
    fun `cancelling the take-off writes nothing`() {
        show()
        compose.onNodeWithTag("equip-11").performClick()
        compose.onNodeWithText(
            "Take it off the car? It moves to Spares with its history, and its wear stops until it goes back on.",
        ).assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        compose.waitForIdle()
        assertTrue(sent.none { it.url.encodedPath.contains("/parts/") })
    }

    @Test
    fun `taking off on a track day sends the point picked, after the last session by default`() {
        events = trackDayToday()
        show()
        compose.onNodeWithTag("equip-11").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("swapSession").fetchSemanticsNodes().isNotEmpty() }
        // The server's own choice is preselected: after the last session logged.
        compose.onNodeWithText("After Session 2").assertIsDisplayed()

        compose.onNodeWithTag("swapSession").performClick()
        compose.onNodeWithText("After Morning · 1 lap").performClick()
        compose.onNodeWithText("Take off").performClick()
        assertTrue(bodyText("/parts/11/unequip").contains("\"after_session_id\":51"))
    }

    @Test
    fun `the start of the day is sent as an explicit null`() {
        events = trackDayToday()
        show()
        compose.onNodeWithTag("equip-11").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("swapSession").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("swapSession").performClick()
        compose.onNodeWithText("Start of the day").performClick()
        compose.onNodeWithText("Take off").performClick()
        assertTrue(bodyText("/parts/11/unequip").contains("\"after_session_id\":null"))
    }

    @Test
    fun `a day with no track day offers no picker and leaves the point to the server`() {
        show()
        compose.onNodeWithTag("equip-11").performClick()
        compose.waitForIdle()
        assertTrue(compose.onAllNodesWithTag("swapSession").fetchSemanticsNodes().isEmpty())
        compose.onNodeWithText("Take off").performClick()
        assertTrue(!bodyText("/parts/11/unequip").contains("after_session_id"))
    }

    @Test
    fun `editing when a part fitted at install went on moves the mount, not the part's date`() {
        show()
        compose.onAllNodesWithText("Edit")[0].performClick()
        compose.onNodeWithTag("partInstalled").performTextReplacement("2026-02-03")
        compose.onNodeWithText("Save changes").performClick()

        val mount = bodyText("/parts/11/mount")
        assertTrue(mount, mount.contains("\"mounted_on\":\"2026-02-03\""))
        // No track day on that date: the point is the server's to pick.
        assertTrue(mount, !mount.contains("after_session_id"))
        val part = (sent.first { it.method.value == "PUT" && it.url.encodedPath.endsWith("/parts/11") }.body as TextContent).text
        // The mount route moves the install date of a part fitted the day it went in.
        assertTrue(part, !part.contains("installed_on"))
    }

    @Test
    fun `an edit that moves nothing makes no mount request`() {
        show()
        compose.onAllNodesWithText("Edit")[0].performClick()
        compose.onNodeWithText("Save changes").performClick()
        compose.waitUntil(5_000) { sent.any { it.method.value == "PUT" && it.url.encodedPath.endsWith("/parts/11") } }
        compose.waitForIdle()
        assertTrue(sent.none { it.url.encodedPath.endsWith("/mount") })
    }

    private fun trackDayToday() = """[{"id":5,"track_id":100,"track_name":"VIR","start_date":"$today","days":1,
        "vehicle_id":1,"updated_at":1,"lap_count":1,"session_count":2,"hours":2}]"""

    private companion object {
        fun eventDetail(date: String) = """
            {"id":5,"track_id":100,"track_name":"VIR","start_date":"$date","days":1,
             "vehicle_id":1,"updated_at":1,"lap_count":1,"session_count":2,"hours":2,
             "sessions":[
               {"id":51,"label":"Morning","sort":0,"laps":[{"id":1,"session_id":51,"lap_num":1,"time_ms":126000}]},
               {"id":52,"label":"","sort":1,"laps":[]}],
             "setups":[]}
        """

        val JSON = headersOf(HttpHeaders.ContentType, "application/json")

        const val VEHICLES = """[{"id":1,"name":"Corvette Z06","is_default":1}]"""

        /** A full set on the car (11) and a spare full set on the shelf (13). */
        const val GARAGE = """
            [{"id":1,"name":"Corvette Z06","is_default":1,"updated_at":1,"hours":12.5,
              "event_count":4,"event_days":6,"parts":[
                {"id":11,"vehicle_id":1,"kind":"tires","name":"RE-71RS","size":"255/40R17",
                 "installed_on":"2026-02-01","equipped":true,
                 "mounts":[{"mounted_on":"2026-02-01","removed_on":null}],"measurements":[],
                 "wear":{"hours":4,"events":1,"cycles":2,"remaining_hours":20,"pct_used":0.2}},
                {"id":13,"vehicle_id":1,"kind":"tires","name":"Street",
                 "installed_on":"2025-06-01","equipped":false,
                 "mounts":[{"mounted_on":"2025-06-01","removed_on":"2026-02-01"}],"measurements":[],
                 "wear":{"hours":7,"events":2,"cycles":3,"remaining_hours":10,"pct_used":0.4}}]}]
        """
    }
}
