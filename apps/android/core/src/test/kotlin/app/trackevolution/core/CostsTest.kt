package app.trackevolution.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * The cost form's pure half (NS-40), asserted against
 * `contracts/logic/costs.json` — the output of `public/js/costs.js`.
 */
class CostsTest {
    private val fixture =
        Json.parseToJsonElement(RepoRoot.path("contracts/logic/costs.json").readText()).jsonObject

    @Test
    fun `the line items match the web's`() {
        assertEquals(
            fixture.getValue("COST_FIELDS").jsonArray.map { it.jsonArray.map { v -> v.jsonPrimitive.content } },
            Costs.COST_FIELDS.map { listOf(it.key, it.label, it.placeholder) },
        )
    }

    @Test
    fun `dollarsToCents matches, including the binary-rounding row`() {
        for (pair in fixture.getValue("dollarsToCents").jsonArray) {
            val (input, want) = pair.jsonArray
            val raw = if (input is JsonNull) null else input.jsonPrimitive.content
            val expected = if (want is JsonNull) null else want.jsonPrimitive.int
            assertEquals(expected, Costs.dollarsToCents(raw), "dollarsToCents($raw)")
        }
        // The port trap, stated outright: 0.285 × 100 is 28.499999999999996.
        assertEquals(28, Costs.dollarsToCents("0.285"))
        // `Number` refuses what Kotlin's parser would take.
        assertNull(Costs.dollarsToCents("1d"))
        assertNull(Costs.dollarsToCents("Infinity"))
    }

    @Test
    fun `centsToDollars and fmtSpend match`() {
        for (pair in fixture.getValue("centsToDollars").jsonArray) {
            val (input, want) = pair.jsonArray
            assertEquals(want.jsonPrimitive.content, Costs.centsToDollars(if (input is JsonNull) null else input.jsonPrimitive.int))
        }
        for (pair in fixture.getValue("fmtSpend").jsonArray) {
            val (input, want) = pair.jsonArray
            val expected = if (want is JsonNull) null else want.jsonPrimitive.content
            assertEquals(expected, Costs.fmtSpend(if (input is JsonNull) null else input.jsonPrimitive.int))
        }
    }

    @Test
    fun `eventCostCents is null, never zero, with nothing entered`() {
        assertNull(Costs.eventCostCents(null, null, null, null))
        assertEquals(0, Costs.eventCostCents(0, null, null, null))
        assertEquals(64_000, Costs.eventCostCents(45_000, 19_000, null, null))
    }
}
