package app.trackevolution.core

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.StaticToken
import app.trackevolution.core.model.PartKind
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.offline.OfflineStore
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.roundToInt

/**
 * The unit-system port, and its agreement with the web app.
 *
 * The port carries the JS test cases with it (`test/unit/units.test.js`, the
 * "wear units" block of `test/unit/garage.test.js`) and adds the cross-language
 * fixture — `contracts/logic/units.json`, run through `public/js/units.js` by
 * `npm run contracts:logic`. The fixture is what catches the two quiet
 * divergences a port makes: JavaScript's `Math.round` on a negative tie, and
 * `toFixed` rounding the exact binary value rather than the printed decimal.
 */
class UnitsTest {

    private val fixture = Json.parseToJsonElement(
        RepoRoot.path("contracts/logic/units.json").readText(),
    ).jsonObject

    private fun units(id: String) = when (id) {
        "imperial" -> UnitSystem.IMPERIAL
        "metric" -> UnitSystem.METRIC
        else -> error("unknown unit system $id")
    }

    // ---- Cross-language agreement ------------------------------------------

    @Test
    fun `matches the JavaScript implementation on the shared fixture`() {
        assertEquals(listOf("imperial", "metric"), fixture["systems"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(Units.DEFAULT_UNITS, units(fixture["default"]!!.jsonPrimitive.content))
        assertEquals(Units.UNIT_SYSTEMS.map { it.units }, listOf(UnitSystem.IMPERIAL, UnitSystem.METRIC))

        var rows = 0
        for (element in fixture["speedKph"]!!.jsonArray) {
            val case = element.jsonObject
            val kph = case["kph"]!!.jsonPrimitive.double
            val dp = case["dp"]!!.jsonPrimitive.int
            val u = units(case["units"]!!.jsonPrimitive.content)
            assertEquals(case["output"]!!.jsonPrimitive.content, Units.fmtSpeedKph(kph, u, dp), "fmtSpeedKph($kph, $u, $dp)")
            rows++
        }
        for (element in fixture["speedMps"]!!.jsonArray) {
            val case = element.jsonObject
            val mps = case["mps"]!!.jsonPrimitive.double
            val u = units(case["units"]!!.jsonPrimitive.content)
            assertEquals(case["output"]!!.jsonPrimitive.double, Units.convSpeedMps(mps, u), 1e-9, "convSpeedMps($mps, $u)")
            rows++
        }
        for (element in fixture["dist"]!!.jsonArray) {
            val case = element.jsonObject
            val m = case["m"]!!.jsonPrimitive.double
            val u = units(case["units"]!!.jsonPrimitive.content)
            assertEquals(case["output"]!!.jsonPrimitive.content, Units.fmtDist(m, u), "fmtDist($m, $u)")
            rows++
        }
        for (element in fixture["accuracy"]!!.jsonArray) {
            val case = element.jsonObject
            val m = case["m"]!!.jsonPrimitive.double
            val u = units(case["units"]!!.jsonPrimitive.content)
            assertEquals(case["output"]!!.jsonPrimitive.content, Units.fmtAccuracy(m, u), "fmtAccuracy($m, $u)")
            rows++
        }
        for (element in fixture["temp"]!!.jsonArray) {
            val case = element.jsonObject
            val f = case["f"]!!.jsonPrimitive.int
            val u = units(case["units"]!!.jsonPrimitive.content)
            assertEquals(case["display"]!!.jsonPrimitive.int, Units.tempToDisplay(f, u), "tempToDisplay($f, $u)")
            assertEquals(case["text"]!!.jsonPrimitive.content, Units.fmtTemp(f, u), "fmtTemp($f, $u)")
            rows++
        }
        for (element in fixture["tempToStored"]!!.jsonArray) {
            val case = element.jsonObject
            val v = case["v"]!!.jsonPrimitive.double
            val u = units(case["units"]!!.jsonPrimitive.content)
            assertEquals(case["output"]!!.jsonPrimitive.int, Units.tempToStored(v, u), "tempToStored($v, $u)")
            rows++
        }
        for ((id, spec) in fixture["tempInputSpec"]!!.jsonObject) {
            val expected = spec.jsonObject
            val actual = Units.tempInputSpec(units(id))
            assertEquals(expected["min"]!!.jsonPrimitive.int, actual.min, "$id min")
            assertEquals(expected["max"]!!.jsonPrimitive.int, actual.max, "$id max")
            assertEquals(expected["placeholder"]!!.jsonPrimitive.int, actual.placeholder, "$id placeholder")
            rows++
        }
        for (element in fixture["wearLimitHint"]!!.jsonArray) {
            val case = element.jsonObject
            val kind = PartKind(case["kind"]!!.jsonPrimitive.content)
            val u = units(case["units"]!!.jsonPrimitive.content)
            assertEquals(case["output"]!!.jsonPrimitive.content, Garage.wearLimitHint(kind, u), "wearLimitHint($kind, $u)")
            rows++
        }
        for (element in fixture["defaultMeasurementUnit"]!!.jsonArray) {
            val case = element.jsonObject
            val kind = PartKind(case["kind"]!!.jsonPrimitive.content)
            val u = units(case["units"]!!.jsonPrimitive.content)
            assertEquals(
                case["output"]!!.jsonPrimitive.content,
                Garage.defaultMeasurementUnit(kind, u),
                "defaultMeasurementUnit($kind, $u)",
            )
            rows++
        }
        // A guard against the fixture silently emptying out and every loop above
        // passing vacuously.
        assertTrue(rows >= 100, "fixture shrank to $rows rows")
    }

    // ---- test/unit/units.test.js ---------------------------------------------

    @Test
    fun `offers exactly imperial and metric, defaulting to what the app always showed`() {
        assertEquals(listOf("Imperial", "Metric"), Units.UNIT_SYSTEMS.map { it.label })
        assertEquals(UnitSystem.IMPERIAL, Units.DEFAULT_UNITS)
        assertTrue(Units.isMetric(UnitSystem.METRIC))
        assertFalse(Units.isMetric(UnitSystem.IMPERIAL))
    }

    @Test
    fun `converts speed to mph or leaves kph alone`() {
        assertEquals("mph", Units.speedUnit(UnitSystem.IMPERIAL))
        assertEquals("km/h", Units.speedUnit(UnitSystem.METRIC))
        assertEquals("121 mph", Units.fmtSpeedKph(194.5, UnitSystem.IMPERIAL))
        assertEquals("195 km/h", Units.fmtSpeedKph(194.5, UnitSystem.METRIC))
        assertEquals("100.0 km/h", Units.fmtSpeedKph(100.0, UnitSystem.METRIC, 1))
    }

    @Test
    fun `agrees with itself between the kph and m per s paths`() {
        // 30 m/s = 108 km/h; both routes to mph must land on the same number.
        assertEquals((108 * 0.621371).roundToInt(), Units.convSpeedMps(30.0, UnitSystem.IMPERIAL).roundToInt())
        assertEquals(108.0, Units.convSpeedMps(30.0, UnitSystem.METRIC), 1e-9)
    }

    @Test
    fun `formats metric axis ticks as before`() {
        assertEquals("0 m", Units.fmtDist(0.0, UnitSystem.METRIC))
        assertEquals("940 m", Units.fmtDist(940.0, UnitSystem.METRIC))
        assertEquals("2 km", Units.fmtDist(2000.0, UnitSystem.METRIC))
        assertEquals("2.4 km", Units.fmtDist(2400.0, UnitSystem.METRIC))
    }

    @Test
    fun `uses feet under a quarter mile and miles above, opening the axis in miles`() {
        assertEquals("0 mi", Units.fmtDist(0.0, UnitSystem.IMPERIAL))
        assertEquals("328 ft", Units.fmtDist(100.0, UnitSystem.IMPERIAL))
        assertEquals("0.25 mi", Units.fmtDist(0.25 * 1609.344, UnitSystem.IMPERIAL))
        assertEquals("0.5 mi", Units.fmtDist(0.5 * 1609.344, UnitSystem.IMPERIAL))
        assertEquals("1 mi", Units.fmtDist(1609.344, UnitSystem.IMPERIAL))
        assertEquals("2.49 mi", Units.fmtDist(4000.0, UnitSystem.IMPERIAL))
    }

    @Test
    fun `formats GPS accuracy`() {
        assertEquals("±4 m", Units.fmtAccuracy(4.2, UnitSystem.METRIC))
        assertEquals("±14 ft", Units.fmtAccuracy(4.2, UnitSystem.IMPERIAL))
    }

    @Test
    fun `shows °F as-is and °C rounded`() {
        assertEquals("72°F", Units.fmtTemp(72, UnitSystem.IMPERIAL))
        assertEquals("22°C", Units.fmtTemp(72, UnitSystem.METRIC))
        assertEquals("0°C", Units.fmtTemp(32, UnitSystem.METRIC))
        assertEquals("", Units.fmtTemp(null, UnitSystem.METRIC))
        assertNull(Units.tempToDisplay(null, UnitSystem.METRIC))
    }

    @Test
    fun `stores form input as whole °F and round-trips whole degrees stably`() {
        assertEquals(72, Units.tempToStored(72.0, UnitSystem.IMPERIAL))
        assertEquals(72, Units.tempToStored(72.4, UnitSystem.IMPERIAL))
        assertEquals(72, Units.tempToStored(22.0, UnitSystem.METRIC))
        assertNull(Units.tempToStored(null, UnitSystem.METRIC))
        // Every whole °C from -40 to 65 survives a save-and-edit cycle unchanged:
        // the stored °F is rounded, so a metric user must never watch their own
        // entry drift by a degree on the next edit.
        for (c in -40..65) {
            assertEquals(c, Units.tempToDisplay(Units.tempToStored(c.toDouble(), UnitSystem.METRIC), UnitSystem.METRIC), "$c °C")
        }
    }

    @Test
    fun `bounds the input to what the server accepts`() {
        val f = Units.tempInputSpec(UnitSystem.IMPERIAL)
        val c = Units.tempInputSpec(UnitSystem.METRIC)
        assertEquals(listOf(-40, 150), listOf(f.min, f.max))
        // The °C bounds convert to inside isValidTemp's -40…150 °F window.
        assertTrue(Units.tempToStored(c.min.toDouble(), UnitSystem.METRIC)!! >= -40)
        assertTrue(Units.tempToStored(c.max.toDouble(), UnitSystem.METRIC)!! <= 150)
    }

    @Test
    fun `rounds like JavaScript, not like the printed decimal`() {
        // (0.15).toFixed(1) is "0.1": the double is 0.1499999…, and a port on
        // `%.1f` says "0.2". Math.round's tie goes toward +infinity on both sides
        // of zero, which is what makes -0.5 °F store as 0 rather than -1.
        assertEquals("0.1", Units.toFixed(0.15, 1))
        assertEquals("2.5", Units.toFixed(2.45, 1))
        assertEquals("3", Units.toFixed(2.5, 0))
        assertEquals("-2", Units.toFixed(-2.5, 0))
        assertEquals("0", Units.toFixed(-0.4, 0))
        assertEquals(0, Units.tempToStored(-0.5, UnitSystem.IMPERIAL))
    }

    // ---- the "wear units" block of test/unit/garage.test.js ----------------------

    @Test
    fun `suggests tread depth in 32nds only for imperial users`() {
        assertEquals("3 (32nds)", Garage.wearLimitHint(PartKind.TIRES, UnitSystem.IMPERIAL))
        assertEquals("3 (mm)", Garage.wearLimitHint(PartKind.TIRES, UnitSystem.METRIC))
        assertEquals("3 (mm)", Garage.wearLimitHint(PartKind.PADS_FRONT, UnitSystem.METRIC))
        assertEquals("", Garage.wearLimitHint(PartKind.OIL, UnitSystem.METRIC))
        assertEquals("32nds", Garage.defaultMeasurementUnit(PartKind.TIRES, UnitSystem.IMPERIAL))
        assertEquals("mm", Garage.defaultMeasurementUnit(PartKind.TIRES, UnitSystem.METRIC))
        assertEquals("mm", Garage.defaultMeasurementUnit(PartKind.PADS_REAR, UnitSystem.IMPERIAL))
        // The imperial table the garage fixture pins is unchanged by all this.
        assertEquals("3 (32nds)", PartKind.TIRES.wearLimitHint)
        assertEquals("32nds", PartKind.TIRES.defaultUnit)
    }

    // ---- the two older enums ------------------------------------------------------

    @Test
    fun `maps the account's choice onto the conditions and health enums`() {
        assertEquals(SessionConditions.Units.US, Units.condUnits(UnitSystem.IMPERIAL))
        assertEquals(SessionConditions.Units.METRIC, Units.condUnits(UnitSystem.METRIC))
        assertEquals(Health.Units.US, Units.healthUnits(UnitSystem.IMPERIAL))
        assertEquals(Health.Units.METRIC, Units.healthUnits(UnitSystem.METRIC))
    }

    // ---- PUT /me/units --------------------------------------------------------------

    @Test
    fun `sets the unit system with the wire spelling, and never queues it offline`() = runTest {
        val sent = ArrayList<HttpRequestData>()
        val engine = MockEngine { request ->
            sent += request
            respond("""{"ok":true}""", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val api = ApiClient(engine, baseUrl = "https://example.test", tokens = StaticToken("t"))
        api.setUnits(UnitSystem.METRIC)
        api.setUnits(UnitSystem.IMPERIAL)

        assertEquals(listOf("PUT", "PUT"), sent.map { it.method.value })
        assertEquals(listOf("/api/me/units", "/api/me/units"), sent.map { it.url.encodedPath })
        val bodies = sent.map { Json.parseToJsonElement((it.body as TextContent).text).jsonObject["units"]!!.jsonPrimitive.content }
        assertEquals(listOf("metric", "imperial"), bodies)

        // Like the checklist template and the garage: a preference the server
        // refused needs the server's reason, not a silent replay later.
        assertFalse(OfflineStore.isQueueable("PUT", "/me/units"))
    }
}
