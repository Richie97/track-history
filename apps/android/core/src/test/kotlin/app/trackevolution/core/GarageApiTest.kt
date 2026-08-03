package app.trackevolution.core

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.MeasurementDraft
import app.trackevolution.core.model.PartDraft
import app.trackevolution.core.model.PartKind
import app.trackevolution.core.model.PartPatch
import app.trackevolution.core.model.PartRefreshDraft
import app.trackevolution.core.model.Patch
import app.trackevolution.core.model.VehicleDraft
import app.trackevolution.core.model.VehiclePatch
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The garage endpoints' request shaping.
 *
 * What the responses decode into is `GoldenContractTest`'s job — it already
 * covers `garage` — so these only assert what this client sends: URLs, methods,
 * and the three-state patch bodies where "leave alone" and "clear" are
 * different requests.
 */
class GarageApiTest {

    private val recorded = mutableListOf<HttpRequestData>()

    private fun client(
        handler: MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ): ApiClient {
        val engine = MockEngine { request ->
            recorded += request
            handler(request)
        }
        return ApiClient(engine, baseUrl = "https://example.test", tokens = StaticToken("tok"))
    }

    private fun MockRequestHandleScope.ok(json: String) = respond(
        json,
        HttpStatusCode.OK,
        headersOf(HttpHeaders.ContentType, "application/json"),
    )

    private fun bodyOf(request: HttpRequestData): JsonObject =
        Json.parseToJsonElement((request.body as TextContent).text).jsonObject

    // ---- Vehicles ----------------------------------------------------------

    @Test
    fun `creates a vehicle`() = runTest {
        val api = client { ok("""{"id":3,"name":"Corvette Z06","notes":null,"is_default":1}""") }
        val created = api.createVehicle(VehicleDraft(name = "Corvette Z06", isDefault = true))

        val request = recorded.single()
        assertEquals("POST", request.method.value)
        assertEquals("https://example.test/api/vehicles", request.url.toString())
        assertEquals("Corvette Z06", bodyOf(request)["name"]!!.jsonPrimitive.content)
        assertTrue(bodyOf(request)["is_default"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(3, created.id)
    }

    @Test
    fun `omits an unchanged field and sends an explicit null for a cleared one`() = runTest {
        val api = client { ok("""{"ok":true}""") }
        api.updateVehicle(3, VehiclePatch(notes = Patch.Set(null)))

        val body = bodyOf(recorded.single())
        // The whole point of the three-state patch: the server writes only the
        // columns present, so an absent key and a null are different requests.
        assertFalse("name" in body, "an unchanged field must not be sent")
        assertTrue("notes" in body)
        assertTrue(body["notes"] is kotlinx.serialization.json.JsonNull)
    }

    @Test
    fun `deletes a vehicle`() = runTest {
        val api = client { ok("""{"ok":true}""") }
        api.deleteVehicle(3)
        assertEquals("DELETE", recorded.single().method.value)
        assertEquals("https://example.test/api/vehicles/3", recorded.single().url.toString())
    }

    // ---- The garage --------------------------------------------------------

    @Test
    fun `reads the garage`() = runTest {
        val api = client { ok(Goldens.bodyText("garage")) }
        val garage = api.garage()
        assertEquals("https://example.test/api/garage", recorded.single().url.toString())
        assertTrue(garage.isNotEmpty(), "the golden fixture should carry a vehicle")
    }

    // ---- Parts -------------------------------------------------------------

    @Test
    fun `creates a part under its vehicle, leaving expected life to the server`() = runTest {
        val api = client { ok("""{"id":11}""") }
        val id = api.createPart(
            3,
            PartDraft(kind = PartKind.PADS_FRONT, name = "PFC 11", installedOn = "2026-05-01"),
        )

        val request = recorded.single()
        assertEquals("https://example.test/api/vehicles/3/parts", request.url.toString())
        val body = bodyOf(request)
        assertEquals("pads_front", body["kind"]!!.jsonPrimitive.content)
        assertEquals("2026-05-01", body["installed_on"]!!.jsonPrimitive.content)
        // Omitted so the server can default it from retired lifecycles of the
        // same kind — a better guess than anything typed on the first set.
        assertFalse("expected_hours" in body)
        assertEquals(11, id)
    }

    @Test
    fun `retires a part by setting its retirement date`() = runTest {
        val api = client { ok("""{"ok":true}""") }
        api.updatePart(11, PartPatch(retiredOn = Patch.Set("2026-08-01")))

        val body = bodyOf(recorded.single())
        assertEquals("2026-08-01", body["retired_on"]!!.jsonPrimitive.content)
        assertFalse("kind" in body)
    }

    @Test
    fun `refreshes a part with no body fields at all`() = runTest {
        val api = client { ok("""{"retired_id":11,"id":12}""") }
        val refresh = api.refreshPart(11)

        val request = recorded.single()
        assertEquals("POST", request.method.value)
        assertEquals("https://example.test/api/parts/11/refresh", request.url.toString())
        // Every field optional: the successor inherits the retired part's spec,
        // which is what makes it one tap.
        assertTrue(bodyOf(request).isEmpty())
        assertEquals(12, refresh.id)
    }

    @Test
    fun `carries a swap date and cost when the driver supplies them`() = runTest {
        val api = client { ok("""{"retired_id":11,"id":12}""") }
        api.refreshPart(11, PartRefreshDraft(installedOn = "2026-08-02", costCents = 42_000))

        val body = bodyOf(recorded.single())
        assertEquals("2026-08-02", body["installed_on"]!!.jsonPrimitive.content)
        assertEquals("42000", body["cost_cents"]!!.jsonPrimitive.content)
    }

    @Test
    fun `deletes a part`() = runTest {
        val api = client { ok("""{"ok":true}""") }
        api.deletePart(11)
        assertEquals("DELETE", recorded.single().method.value)
        assertEquals("https://example.test/api/parts/11", recorded.single().url.toString())
    }

    // ---- Measurements ------------------------------------------------------

    @Test
    fun `logs a wear measurement`() = runTest {
        val api = client { ok("""{"id":5}""") }
        val id = api.addMeasurement(
            11,
            MeasurementDraft(measuredOn = "2026-07-01", value = 6.5, unit = "mm"),
        )

        val request = recorded.single()
        assertEquals("https://example.test/api/parts/11/measurements", request.url.toString())
        val body = bodyOf(request)
        assertEquals("2026-07-01", body["measured_on"]!!.jsonPrimitive.content)
        assertEquals("6.5", body["value"]!!.jsonPrimitive.content)
        assertEquals("mm", body["unit"]!!.jsonPrimitive.content)
        assertEquals(5, id)
    }

    @Test
    fun `deletes a measurement under its part`() = runTest {
        val api = client { ok("""{"ok":true}""") }
        api.deleteMeasurement(partId = 11, id = 5)
        assertEquals(
            "https://example.test/api/parts/11/measurements/5",
            recorded.single().url.toString(),
        )
    }

    // ---- The offline rule --------------------------------------------------

    @Test
    fun `garage writes are not on the offline queue`() {
        // Deliberate, and the same call iOS and the web app make: retiring a
        // part rewrites its neighbours' wear, a new part's expected life is
        // defaulted server-side, and a refresh is a retire-plus-create whose
        // successor id the client cannot invent. So the garage reads from the
        // cache offline and fails to write, rather than queueing something the
        // server would resolve differently.
        assertFalse(app.trackevolution.core.offline.OfflineStore.isQueueable("POST", "/vehicles"))
        assertFalse(app.trackevolution.core.offline.OfflineStore.isQueueable("PUT", "/vehicles/3"))
        assertFalse(app.trackevolution.core.offline.OfflineStore.isQueueable("DELETE", "/vehicles/3"))
        assertFalse(app.trackevolution.core.offline.OfflineStore.isQueueable("POST", "/vehicles/3/parts"))
        assertFalse(app.trackevolution.core.offline.OfflineStore.isQueueable("PUT", "/parts/11"))
        assertFalse(app.trackevolution.core.offline.OfflineStore.isQueueable("POST", "/parts/11/refresh"))
        assertFalse(
            app.trackevolution.core.offline.OfflineStore.isQueueable("POST", "/parts/11/measurements"),
        )
    }
}
