package app.trackevolution.core

import app.trackevolution.core.model.GarageVehicle
import app.trackevolution.core.model.Part
import app.trackevolution.core.model.PartKind
import app.trackevolution.core.model.WearEstimate
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The garage's presentation logic, and its agreement with the web app.
 *
 * The port carries the JS test cases with it (`test/unit/garage.test.js`) and
 * adds the cross-language fixture — `contracts/logic/garage-status.json`, run
 * through `public/js/garage.js` by `npm run contracts:logic`, and the same file
 * the iOS port asserts against. The due/low thresholds are exactly the kind of
 * thing that drifts silently: a boundary an hour out still looks entirely
 * reasonable on screen.
 */
class GarageTest {

    private val json = Json { ignoreUnknownKeys = false }

    private val fixture = Json.parseToJsonElement(
        RepoRoot.path("contracts/logic/garage-status.json").readText(),
    ).jsonObject

    // ---- Cross-language agreement ------------------------------------------

    @Test
    fun `matches the JavaScript implementation on the shared fixture`() {
        val cases = fixture["cases"]!!.jsonArray
        for (element in cases) {
            val case = element.jsonObject
            val name = case["name"]!!.jsonPrimitive.content
            val wear = json.decodeFromJsonElement(WearEstimate.serializer(), case["wear"]!!)

            val status = Garage.partStatus(wear)?.rawValue
            val expectedStatus = case["status"]!!.jsonPrimitive.contentOrNullSafe()
            assertEquals(expectedStatus, status, "$name: status")

            val expectedRemaining = case["remaining"]!!.jsonPrimitive.contentOrNullSafe()
            assertEquals(expectedRemaining, Garage.fmtRemaining(wear), "$name: remaining phrasing")
        }

        for (element in fixture["hours"]!!.jsonArray) {
            val case = element.jsonObject
            val input = case["input"]!!.jsonPrimitive.contentOrNullSafe()?.toDouble()
            assertEquals(
                case["output"]!!.jsonPrimitive.content,
                Garage.fmtHours(input),
                "fmtHours($input)",
            )
        }

        for (element in fixture["cost"]!!.jsonArray) {
            val case = element.jsonObject
            val input = case["input"]!!.jsonPrimitive.contentOrNullSafe()?.toInt()
            assertEquals(
                case["output"]!!.jsonPrimitive.contentOrNullSafe(),
                Garage.fmtCost(input),
                "fmtCost($input)",
            )
        }

        for (element in fixture["kinds"]!!.jsonArray) {
            val case = element.jsonObject
            val kind = PartKind(case["kind"]!!.jsonPrimitive.content)
            assertEquals(case["label"]!!.jsonPrimitive.content, kind.label)
            assertEquals(
                case["wearLimitHint"]!!.jsonPrimitive.contentOrNullSafe(),
                kind.wearLimitHint,
            )
        }

        // A guard against the fixture silently emptying out and every loop above
        // passing vacuously.
        assertTrue(cases.size >= 10, "fixture shrank to ${cases.size} cases")
        assertEquals(PartKind.all.size, fixture["kinds"]!!.jsonArray.size)
    }

    // ---- Status thresholds --------------------------------------------------

    @Test
    fun `has no status without a projection`() {
        assertNull(Garage.partStatus(null))
        assertNull(Garage.partStatus(wear(remaining = null)))
    }

    @Test
    fun `treats a fully used part as due even with hours left`() {
        // The measured fit and the expectation can disagree; the pessimistic one
        // wins, because "you have 1.5 h left" on a pad at its limit is the one
        // wrong answer that costs a rotor.
        assertEquals(Garage.PartStatus.DUE, Garage.partStatus(wear(remaining = 1.5, pctUsed = 1.0)))
    }

    @Test
    fun `the low threshold is two track days inclusive`() {
        assertEquals(Garage.PartStatus.LOW, Garage.partStatus(wear(remaining = 4.0)))
        assertEquals(Garage.PartStatus.OK, Garage.partStatus(wear(remaining = 4.1)))
    }

    // ---- Alerts -------------------------------------------------------------

    @Test
    fun `alerts skip retired parts, healthy parts and unestimated ones`() {
        val garage = listOf(
            vehicle(
                id = 1,
                parts = listOf(
                    part(id = 10, remaining = 0.5),
                    part(id = 11, remaining = 40.0),
                    part(id = 12, remaining = null),
                    part(id = 13, remaining = 0.1, retiredOn = "2026-01-01"),
                ),
            ),
        )
        assertEquals(listOf(10), Garage.garageAlerts(garage).map { it.part.id })
    }

    @Test
    fun `due parts sort ahead of low ones, and ties keep their order`() {
        val garage = listOf(
            vehicle(id = 1, parts = listOf(part(id = 10, remaining = 3.0), part(id = 11, remaining = 0.0))),
            vehicle(id = 2, parts = listOf(part(id = 20, remaining = 2.0))),
        )
        // 11 is due; 10 and 20 are low and stay in the order they arrived — a
        // reminder list that reshuffles between refreshes is unreadable.
        assertEquals(listOf(11, 10, 20), Garage.garageAlerts(garage).map { it.part.id })
    }

    @Test
    fun `an absent garage produces no alerts rather than throwing`() {
        assertEquals(emptyList<Garage.Alert>(), Garage.garageAlerts(null))
    }

    // ---- Fixtures -----------------------------------------------------------

    private fun wear(remaining: Double?, pctUsed: Double? = null) = WearEstimate(
        hours = 3.0,
        events = 2,
        cycles = 2,
        remainingHours = remaining,
        pctUsed = pctUsed,
    )

    private fun part(id: Int, remaining: Double?, retiredOn: String? = null) = Part(
        id = id,
        vehicleId = 1,
        kind = PartKind.PADS_FRONT,
        name = "Hawk DTC-60",
        installedOn = "2026-01-01",
        retiredOn = retiredOn,
        measurements = emptyList(),
        wear = wear(remaining),
    )

    private fun vehicle(id: Int, parts: List<Part>) = GarageVehicle(
        id = id,
        name = "Corvette Z06",
        isDefault = id == 1,
        updatedAt = 1,
        hours = 10.0,
        eventCount = 5,
        eventDays = 5,
        parts = parts,
    )
}

/** `JsonPrimitive.content` is "null" for a JSON null; this is the honest read. */
private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullSafe(): String? =
    if (this is kotlinx.serialization.json.JsonNull) null else content
