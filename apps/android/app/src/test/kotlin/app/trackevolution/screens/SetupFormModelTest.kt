package app.trackevolution.screens

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.model.CornerValues
import app.trackevolution.core.model.SetupSheet
import app.trackevolution.core.model.UnitSystem
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
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The setup form's model (NS-40), over the real `ApiClient` and `MockEngine`:
 * where the draft starts, that it is typed in the driver's units and sent in
 * stored ones, that a part reference the form has no picker for survives, and
 * that a sheet with nothing on it is refused rather than sent.
 */
class SetupFormModelTest {

    private val sent = java.util.concurrent.CopyOnWriteArrayList<HttpRequestData>()

    /** A two-day event whose day 1 carries a sheet with cold pressures, a camber and a front-tire ref. */
    private val eventJson = """
        {"id":10,"track_id":1,"track_name":"VIR (Full)","start_date":"2026-05-01","days":2,
         "vehicle_id":null,"updated_at":1,"lap_count":0,"session_count":0,"hours":2.5,
         "sessions":[],
         "setups":[{"day":1,"data":{"tp_cold":{"fl":29,"fr":29,"rl":27,"rr":27},"camber":{"f":-3.2},"tires_f_id":7,"notes":"baseline"}}]}
    """.trimIndent()

    private fun api(prefillStatus: Int = 200, prefill: String = """{"data":null}"""): ApiClient {
        val engine = MockEngine { request ->
            sent += request
            val path = request.url.encodedPath
            val (status, body) = when {
                path.endsWith("/setups/prefill") -> prefillStatus to prefill
                path.endsWith("/events/10") -> 200 to eventJson
                path.endsWith("/garage") -> 200 to "[]"
                else -> 200 to """{"ok":true}"""
            }
            respond(body, HttpStatusCode.fromValue(status), headersOf(HttpHeaders.ContentType, "application/json"))
        }
        return ApiClient(engine, baseUrl = "https://example.test")
    }

    private fun loaded(model: SetupFormModel): SetupFormModel = runBlocking {
        model.load()
        withTimeout(5_000) { while (model.state == LoadState.Loading) delay(5) }
        model
    }

    private fun awaitPut(model: SetupFormModel): HttpRequestData = runBlocking {
        withTimeout(5_000) {
            while (sent.none { it.method.value == "PUT" } && (model.saving || model.error == null)) delay(5)
        }
        sent.first { it.method.value == "PUT" }
    }

    private fun bodyOf(request: HttpRequestData) =
        Json.parseToJsonElement((request.body as TextContent).text).jsonObject

    private fun model(day: Int, units: UnitSystem = UnitSystem.IMPERIAL, startFrom: SetupSheet? = null, api: ApiClient = api()) =
        SetupFormModel(CoroutineScope(Dispatchers.Default), api, eventId = 10, day = day, startFrom = startFrom, units = units)

    @Test
    fun `an existing sheet opens as typed text in the driver's units`() {
        val m = loaded(model(day = 1, units = UnitSystem.METRIC))
        assertTrue(m.existing)
        // 29 psi is 2.00 bar to the display unit's two places.
        assertEquals("2", m.values["tp_cold.fl"])
        assertEquals("-3.2", m.values["camber.f"])
        assertEquals("7", m.values["tires_f_id"])
        assertEquals("baseline", m.notes)
    }

    @Test
    fun `a save converts back to stored units and keeps the part reference`() {
        val m = loaded(model(day = 1, units = UnitSystem.METRIC))
        m.setValue("tp_cold.fl", "1,9")
        m.save()
        val body = bodyOf(awaitPut(m))
        assertEquals("/api/events/10/setups/1", sent.first { it.method.value == "PUT" }.url.encodedPath)
        // 1.9 bar × 14.503774 = 27.56 psi, two decimals as sanitizeSetup keeps.
        assertEquals(27.56, body["tp_cold"]!!.jsonObject["fl"]!!.jsonPrimitive.double, 1e-9)
        assertEquals(7, body["tires_f_id"]!!.jsonPrimitive.int)
        assertEquals("baseline", body["notes"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a new day starts from the server's copy-forward prefill`() {
        val m = loaded(model(day = 2, api = api(prefill = """{"data":{"fuel":11.5}}""")))
        assertFalse(m.existing)
        assertEquals("11.5", m.values["fuel"])
        assertNotNull(m.source)
    }

    @Test
    fun `with the prefill unreachable it copies the previous day from the cached event`() {
        val m = loaded(model(day = 2, api = api(prefillStatus = 503)))
        assertEquals("29", m.values["tp_cold.fl"])
        assertEquals("Copied from day 1", m.source)
    }

    @Test
    fun `the pressure loop's next-day sheet wins over everything`() {
        val start = SetupSheet(tpCold = CornerValues(fl = 25.5, fr = 26.0, rl = 25.5, rr = 26.0))
        val m = loaded(model(day = 2, startFrom = start))
        assertEquals("25.5", m.values["tp_cold.fl"])
        assertNull(m.values["camber.f"])
    }

    @Test
    fun `a sheet with nothing on it, or a field that isn't a number, is refused`() {
        val empty = loaded(model(day = 2))
        empty.save()
        assertNotNull(empty.error)
        assertTrue(sent.none { it.method.value == "PUT" })

        val bad = loaded(model(day = 1))
        bad.setValue("camber.r", "two")
        bad.save()
        assertEquals("Couldn't read Camber R \"two\".", bad.error)
        assertTrue(sent.none { it.method.value == "PUT" })
    }
}
