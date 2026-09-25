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
 */
class VehicleModelTest {

    private val sent = java.util.concurrent.CopyOnWriteArrayList<HttpRequestData>()

    private fun api(
        garage: String = GARAGE,
        vehicles: String = VEHICLES,
        garageStatus: HttpStatusCode = HttpStatusCode.OK,
    ): ApiClient {
        val engine = MockEngine { request ->
            sent += request
            val path = request.url.encodedPath
            when {
                path.endsWith("/garage") -> respond(garage, garageStatus, JSON)
                path.endsWith("/vehicles") && request.method.value == "GET" -> respond(vehicles, HttpStatusCode.OK, JSON)
                path.endsWith("/events") -> respond(EVENTS, HttpStatusCode.OK, JSON)
                else -> respond("""{"ok":true}""", HttpStatusCode.OK, JSON)
            }
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
    fun `splits parts into on the car, spares and retired`() {
        val model = loaded()
        assertEquals(listOf(10, 11), model.activeParts.map { it.id })
        assertEquals(listOf(13), model.spareParts.map { it.id })
        assertEquals(listOf(12), model.retiredParts.map { it.id })
    }

    private fun sentTo(suffix: String): HttpRequestData = runBlocking {
        withTimeout(5_000) {
            var found = sent.firstOrNull { it.url.encodedPath.endsWith(suffix) }
            while (found == null) {
                delay(5)
                found = sent.firstOrNull { it.url.encodedPath.endsWith(suffix) }
            }
            found
        }
    }

    @Test
    fun `the Equipped switch posts equip or unequip with its date`() {
        val model = loaded()
        sent.clear()
        model.setEquipped(model.spareParts.single(), equipped = true, on = "2026-08-01")
        assertEquals("2026-08-01", bodyOf(sentTo("/parts/13/equip"))["on"]!!.jsonPrimitive.content)

        model.setEquipped(model.activeParts.first(), equipped = false, on = "2026-08-02")
        assertEquals("2026-08-02", bodyOf(sentTo("/parts/10/unequip"))["on"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a new set of a retired part goes on the car and swaps, or to the shelf`() {
        val model = loaded()
        sent.clear()
        model.refreshRetiredPart(12, on = "2026-08-01", equipped = true)
        val onCar = bodyOf(sentTo("/parts/12/refresh"))
        assertEquals("2026-08-01", onCar["installed_on"]!!.jsonPrimitive.content)
        assertEquals("true", onCar["equipped"]!!.jsonPrimitive.content)
        assertEquals("true", onCar["swap"]!!.jsonPrimitive.content)

        sent.clear()
        model.refreshRetiredPart(12, on = "2026-08-01", equipped = false)
        val shelf = bodyOf(sentTo("/parts/12/refresh"))
        assertEquals("false", shelf["equipped"]!!.jsonPrimitive.content)
        assertEquals("false", shelf["swap"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a spare's alert waits until it is back on the car`() {
        // 13 is all but worn out, but it's on the shelf and not wearing.
        assertEquals(listOf(10), loaded().alerts.map { it.part.id })
    }

    @Test
    fun `parts spend counts retired parts too`() {
        // What the car has cost you, not what is currently bolted to it — the
        // set of pads you wore out last season is exactly the spend worth seeing.
        val model = loaded()
        assertEquals(38900 + 120000, model.spendCents)
    }

    @Test
    fun `alerts come from this car alone`() {
        val model = loaded()
        // Part 10 is due; 11 has plenty left; 12 is retired and stays history.
        assertEquals(listOf(10), model.alerts.map { it.part.id })
    }

    @Test
    fun `a missing car says so rather than showing an empty page`() {
        // The free list decides whether there is a car at all (NS-37), not /garage.
        val model = loaded(api(vehicles = "[]"))
        assertEquals(LoadState.Failed("That car isn't in your garage any more."), model.state)
    }

    @Test
    fun `a free account gets the car with its Pro half locked, not a paywall`() {
        // NS-37: a 402 from /garage used to turn the whole page into a paywall,
        // which is why a free account's car had no page.
        val model = loaded(
            api(garage = """{"error":"pro required"}""", garageStatus = HttpStatusCode.PaymentRequired),
        )
        assertEquals(LoadState.Ready, model.state)
        assertTrue(model.proLocked)
        assertEquals(null, model.garage)
        assertEquals("Corvette Z06", model.vehicle?.name)
        assertEquals(emptyList<Any>(), model.activeParts)
        // The free half is the logbook, reduced from the cached events.
        assertEquals(2, model.logbook.events)
        assertEquals(3.0, model.logbook.trackDays, 0.0)
        assertEquals(listOf(100), model.logbook.bests.map { it.trackId })
    }

    @Test
    fun `deleting the car sends the delete and marks the page gone`() = runBlocking {
        val model = loaded()
        sent.clear()
        model.deleteVehicle()
        withTimeout(5_000) { while (!model.deleted) delay(5) }
        val delete = sent.single { it.method.value == "DELETE" }
        assertTrue(delete.url.encodedPath.endsWith("/vehicles/1"))
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
    fun `editing the car sends every field but only a changed default`() = runBlocking {
        val model = loaded()
        sent.clear()
        // The car is already the default, and the form left the switch on.
        model.updateVehicle(name = "Corvette Z06 ", notes = "  ", targetHotPsi = 34.5, isDefault = true)

        val put = withTimeout(5_000) {
            var found = sent.firstOrNull { it.method.value == "PUT" }
            while (found == null) {
                delay(5)
                found = sent.firstOrNull { it.method.value == "PUT" }
            }
            found
        }
        val body = bodyOf(put)
        assertEquals(
            setOf("name", "notes", "target_hot_psi", "catalog_id", "wheelbase_mm", "steering_ratio"),
            body.keys,
        )
        assertEquals("Corvette Z06", body["name"]!!.jsonPrimitive.content)
        // A blank notes field means cleared — an explicit null, not an omission.
        assertTrue(body["notes"] is kotlinx.serialization.json.JsonNull)
        assertEquals("34.5", body["target_hot_psi"]!!.jsonPrimitive.content)
        // The geometry goes the same way (#222): a form that shows every field
        // sends every field, so a cleared pick or number is an explicit null.
        assertTrue(body["catalog_id"] is kotlinx.serialization.json.JsonNull)
        assertTrue(body["wheelbase_mm"] is kotlinx.serialization.json.JsonNull)
    }

    @Test
    fun `a rejected write keeps the page and surfaces the server's message`() = runBlocking {
        val engine = MockEngine { request ->
            val path = request.url.encodedPath
            when {
                path.endsWith("/garage") -> respond(GARAGE, HttpStatusCode.OK, JSON)
                path.endsWith("/vehicles") -> respond(VEHICLES, HttpStatusCode.OK, JSON)
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

        const val VEHICLES = """[{"id":1,"name":"Corvette Z06","is_default":1},{"id":2,"name":"Miata","is_default":0}]"""

        /** Two past days on car 1 (one of them two days long), one on the Miata. */
        const val EVENTS = """
            [{"id":5,"track_id":100,"track_name":"VIR","start_date":"2026-04-11","days":2,
              "vehicle_id":1,"updated_at":1,"lap_count":0,"session_count":0,"best_ms":125000,"hours":4},
             {"id":6,"track_id":101,"track_name":"NCM","start_date":"2026-05-02","days":1,
              "vehicle_id":1,"updated_at":1,"lap_count":0,"session_count":0,"hours":2},
             {"id":7,"track_id":100,"track_name":"VIR","start_date":"2026-06-01","days":1,
              "vehicle_id":2,"updated_at":1,"lap_count":0,"session_count":0,"best_ms":139000,"hours":2}]
        """

        /** Part 10 is due, 11 is healthy, 12 is retired, 13 is a nearly-done spare on the shelf. */
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
                 "wear":{"hours":18,"events":6,"cycles":8,"remaining_hours":0,"pct_used":1}},
                {"id":13,"vehicle_id":1,"kind":"tires","name":"Street","size":"255/40R17",
                 "installed_on":"2025-06-01","equipped":false,
                 "mounts":[{"mounted_on":"2025-06-01","removed_on":"2026-02-01"}],"measurements":[],
                 "wear":{"hours":7,"events":2,"cycles":3,"remaining_hours":0.2,"pct_used":0.97}}]}]
        """
    }
}
