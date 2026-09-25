package app.trackevolution.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onAllNodesWithTag
import app.trackevolution.core.api.ApiClient
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
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Equipped switch (migration 0029), driven through the vehicle page: the
 * switch opens a confirm that says what the swap takes off, and only the
 * confirm writes. The wording and the swap choice are pure and pinned in
 * `GarageTest`; this is the wiring — that a spare lands under *Spares*, that
 * flipping its switch names the set it displaces, and that *Equip* is what
 * posts.
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

    private fun api(): ApiClient = ApiClient(
        MockEngine { request ->
            sent += request
            val path = request.url.encodedPath
            when {
                path.endsWith("/garage") -> respond(GARAGE, HttpStatusCode.OK, JSON)
                path.endsWith("/vehicles") -> respond(VEHICLES, HttpStatusCode.OK, JSON)
                path.endsWith("/events") -> respond("[]", HttpStatusCode.OK, JSON)
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

    @Test
    fun `equipping a spare says what it takes off, and only the confirm posts`() {
        show()
        compose.onNodeWithText("Spares").assertIsDisplayed()

        compose.onNodeWithTag("equip-13").performClick()
        compose.onNodeWithText("Put it on the car? This takes off RE-71RS · 255/40R17 — it moves to Spares.")
            .assertIsDisplayed()
        // Nothing written yet: the switch only opened the confirm.
        assertTrue(sent.none { it.url.encodedPath.contains("/parts/") })

        compose.onNodeWithText("Equip").performClick()
        compose.waitUntil(5_000) { sent.any { it.url.encodedPath.endsWith("/parts/13/equip") } }
    }

    @Test
    fun `cancelling the confirm writes nothing`() {
        show()
        compose.onNodeWithTag("equip-11").performClick()
        compose.onNodeWithText(
            "Take it off the car? It moves to Spares with its history, and its wear stops until it goes back on.",
        ).assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        compose.waitForIdle()
        assertTrue(sent.none { it.url.encodedPath.contains("/parts/") })
    }

    private companion object {
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
