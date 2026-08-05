package app.trackevolution.screens

import app.trackevolution.core.api.ApiClient
import app.trackevolution.ui.LoadState
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The vehicle page's own rules — the ones that are about *this* car rather than
 * about wear arithmetic, which is the server's and is pinned in `GarageTest`.
 *
 * The ledger filter is the one worth a test: it has to drop other cars' events
 * **and** this car's upcoming ones, because an event that hasn't been driven has
 * accrued no hours — the server's wear window excludes it too, so a ledger that
 * listed it would not add up to the hours shown in the tile above it.
 */
class VehicleModelTest {

    private val sent = java.util.concurrent.CopyOnWriteArrayList<HttpRequestData>()

    private fun api(garage: String = GARAGE): ApiClient {
        val engine = MockEngine { request ->
            sent += request
            val path = request.url.encodedPath
            val body = when {
                path.endsWith("/garage") -> garage
                path.endsWith("/events") -> EVENTS
                else -> """{"ok":true}"""
            }
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        return ApiClient(engine, baseUrl = "https://example.test")
    }

    private fun loaded(api: ApiClient = api()): VehicleModel = runBlocking {
        val model = VehicleModel(CoroutineScope(Dispatchers.Default), api, vehicleId = 1)
        model.load()
        withTimeout(5_000) {
            while (model.state == LoadState.Loading) delay(5)
        }
        model
    }

    private fun bodyOf(request: HttpRequestData) =
        Json.parseToJsonElement((request.body as TextContent).text).jsonObject

    @Test
    fun `splits parts into in-service and retired`() {
        val model = loaded()
        assertEquals(listOf(10, 11), model.activeParts.map { it.id })
        assertEquals(listOf(12), model.retiredParts.map { it.id })
    }

    @Test
    fun `parts spend counts retired parts too`() {
        // What the car has cost you, not what is currently bolted to it — the
        // set of pads you wore out last season is exactly the spend worth seeing.
        val model = loaded()
        assertEquals(38900 + 120000, model.spendCents)
    }

    @Test
    fun `the ledger is this car's driven events only`() {
        val model = loaded()
        assertEquals(listOf(1), model.events.map { it.id })
    }

    @Test
    fun `alerts come from this car alone`() {
        val model = loaded()
        // Part 10 is due; 11 has plenty left; 12 is retired and stays history.
        assertEquals(listOf(10), model.alerts.map { it.part.id })
    }

    @Test
    fun `a missing car says so rather than showing an empty page`() {
        val model = loaded(api(garage = "[]"))
        assertEquals(LoadState.Failed("That car isn't in your garage any more."), model.state)
    }

    @Test
    fun `retiring sends a date rather than a flag`() = runBlocking {
        val model = loaded()
        sent.clear()
        model.retirePart(10, on = "2026-08-04")

        val put = withTimeout(5_000) {
            var found = sent.firstOrNull { it.method.value == "PUT" }
            while (found == null) {
                delay(5)
                found = sent.firstOrNull { it.method.value == "PUT" }
            }
            found
        }
        val body = bodyOf(put)
        assertEquals("2026-08-04", body["retired_on"]!!.jsonPrimitive.content)
        // Only the one column: the patch is three-state, and sending anything
        // else here would clear a field the user never touched.
        assertEquals(setOf("retired_on"), body.keys)
    }

    @Test
    fun `a rejected write keeps the page and surfaces the server's message`() = runBlocking {
        val engine = MockEngine { request ->
            val path = request.url.encodedPath
            when {
                path.endsWith("/garage") -> respond(GARAGE, HttpStatusCode.OK, JSON)
                path.endsWith("/events") -> respond(EVENTS, HttpStatusCode.OK, JSON)
                else -> respond(
                    """{"error":"A part needs an install date."}""",
                    HttpStatusCode.BadRequest,
                    JSON,
                )
            }
        }
        val model = loaded(ApiClient(engine, baseUrl = "https://example.test"))
        model.deletePart(10)

        withTimeout(5_000) {
            while (model.writeError == null) delay(5)
        }
        assertEquals("A part needs an install date.", model.writeError)
        // The car is still on screen — a rejected write must not cost the page.
        assertTrue(model.vehicle != null)
        assertEquals(LoadState.Ready, model.state)
    }

    private companion object {
        val JSON = headersOf(HttpHeaders.ContentType, "application/json")

        /** Part 10 is due, 11 is healthy, 12 is retired. */
        const val GARAGE = """
            [{"id":1,"name":"Corvette Z06","is_default":1,"updated_at":1,"hours":12.5,
              "event_count":4,"event_days":6,"parts":[
                {"id":10,"vehicle_id":1,"kind":"pads_front","name":"Hawk DTC-60",
                 "installed_on":"2026-01-01","cost_cents":38900,"measurements":[],
                 "wear":{"hours":9,"events":3,"cycles":4,"remaining_hours":0.5,"pct_used":0.95}},
                {"id":11,"vehicle_id":1,"kind":"tires","name":"RE-71RS",
                 "installed_on":"2026-02-01","measurements":[],
                 "wear":{"hours":4,"events":1,"cycles":2,"remaining_hours":20,"pct_used":0.2}},
                {"id":12,"vehicle_id":1,"kind":"rotors_front","name":"Girodisc",
                 "installed_on":"2025-01-01","retired_on":"2026-01-01","cost_cents":120000,
                 "measurements":[],
                 "wear":{"hours":18,"events":6,"cycles":8,"remaining_hours":0,"pct_used":1}}]}]
        """

        /**
         * Event 1 is this car, driven. 2 is this car but years out — the date is
         * deliberately far future so the "upcoming events aren't in the ledger"
         * rule keeps being tested rather than quietly expiring. 3 is another car.
         */
        const val EVENTS = """
            [{"id":1,"track_id":1,"track_name":"VIR (Full)","start_date":"2026-03-01","days":2,
              "vehicle_id":1,"lap_count":10,"session_count":2,"hours":4,"updated_at":1},
             {"id":2,"track_id":1,"track_name":"VIR (Full)","start_date":"2099-03-01","days":2,
              "vehicle_id":1,"lap_count":0,"session_count":0,"hours":4,"updated_at":2},
             {"id":3,"track_id":1,"track_name":"VIR (Full)","start_date":"2026-04-01","days":1,
              "vehicle_id":2,"lap_count":5,"session_count":1,"hours":2,"updated_at":3}]
        """
    }
}
