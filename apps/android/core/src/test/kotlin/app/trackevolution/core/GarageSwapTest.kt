package app.trackevolution.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The swap-between-sessions picker (migration 0030) — `eventLastDay`,
 * `swapSessionEvent`, `swapSessionChoices` — and its agreement with the web app.
 *
 * Carries the JS cases from `test/unit/garage.test.js` (the
 * `swaps between sessions (migration 0030)` block) and asserts equality with
 * `contracts/logic/garage-swap.json`, which `npm run contracts:logic` generates
 * from `public/js/garage.js` — the same fixture the iOS Kit asserts against.
 */
class GarageSwapTest {

    private data class Ev(
        override val id: Int,
        override val vehicleId: Int?,
        override val startDate: String,
        override val days: Double,
    ) : Garage.SwapEvent

    private data class Sess(
        override val id: Int,
        override val label: String?,
        override val lapCount: Int,
    ) : Garage.SwapSession

    private val events = listOf(
        Ev(1, 10, "2026-05-02", 2.0),
        Ev(2, 10, "2026-06-06", 0.5),
        Ev(3, 11, "2026-05-02", 1.0),
        Ev(4, null, "2026-08-01", 1.0),
        Ev(5, 10, "2026-09-12", 3.0),
        Ev(6, 10, "2026-09-13", 1.0),
    )

    // ---- The JS cases ----------------------------------------------------------

    @Test
    fun `counts a part day whole and ends an event on its last day`() {
        assertEquals("2026-05-03", Garage.eventLastDay(Ev(0, null, "2026-05-02", 2.0)))
        assertEquals("2026-06-06", Garage.eventLastDay(Ev(0, null, "2026-06-06", 0.5)))
        assertEquals("2027-01-01", Garage.eventLastDay(Ev(0, null, "2026-12-31", 2.0)))
    }

    @Test
    fun `finds this car's event covering the date, and nothing else's`() {
        assertEquals(1, Garage.swapSessionEvent(10, "2026-05-03", events)?.id)
        assertNull(Garage.swapSessionEvent(10, "2026-05-04", events))
        assertEquals(3, Garage.swapSessionEvent(11, "2026-05-02", events)?.id)
        assertNull(Garage.swapSessionEvent(10, "2026-08-01", events)) // no vehicle_id: never matched
        assertNull(Garage.swapSessionEvent(10, "", events))
    }

    @Test
    fun `gives two covering events to the one that started later`() {
        assertEquals(6, Garage.swapSessionEvent(10, "2026-09-13", events)?.id)
        assertEquals(5, Garage.swapSessionEvent(10, "2026-09-14", events)?.id)
    }

    @Test
    fun `words the sessions as the moment before each one`() {
        assertEquals(
            listOf(
                Garage.SwapSessionChoice(21, "Before Morning · 3 laps"),
                Garage.SwapSessionChoice(22, "Before Session 2 · 1 lap"),
                Garage.SwapSessionChoice(23, "Before Session 3"),
            ),
            Garage.swapSessionChoices(listOf(Sess(21, "Morning", 3), Sess(22, null, 1), Sess(23, "  ", 0))),
        )
        assertTrue(Garage.swapSessionChoices(null).isEmpty())
    }

    // ---- Cross-language agreement ----------------------------------------------

    @Test
    fun `matches the JavaScript implementation on the shared fixture`() {
        val fixture = Json.parseToJsonElement(RepoRoot.path("contracts/logic/garage-swap.json").readText()).jsonObject
        val fixtureEvents = fixture["events"]!!.jsonArray.map {
            val o = it.jsonObject
            Ev(
                id = o.int("id")!!,
                vehicleId = o.int("vehicle_id"),
                startDate = o["start_date"]!!.jsonPrimitive.content,
                days = o["days"]!!.jsonPrimitive.doubleOrNull!!,
            )
        }

        val eventCases = fixture["eventCases"]!!.jsonArray
        assertTrue(eventCases.isNotEmpty())
        for (element in eventCases) {
            val c = element.jsonObject
            val vehicleId = c.int("vehicle_id")!!
            val date = c["date"]!!.jsonPrimitive.content
            assertEquals(
                c.int("event_id"),
                Garage.swapSessionEvent(vehicleId, date, fixtureEvents)?.id,
                "swapSessionEvent($vehicleId, \"$date\")",
            )
        }

        val lastDays = fixture["lastDays"]!!.jsonArray
        assertEquals(fixtureEvents.size, lastDays.size)
        for (element in lastDays) {
            val c = element.jsonObject
            val event = fixtureEvents.single { it.id == c.int("event_id") }
            assertEquals(c["last_day"]!!.jsonPrimitive.content, Garage.eventLastDay(event), "eventLastDay(${event.id})")
        }

        val choiceCases = fixture["choiceCases"]!!.jsonArray
        assertTrue(choiceCases.isNotEmpty())
        for (element in choiceCases) {
            val c = element.jsonObject
            val sessions = c["sessions"]!!.jsonArray.map {
                val o = it.jsonObject
                Sess(
                    id = o.int("id")!!,
                    label = (o["label"] as? JsonElement)?.takeUnless { l -> l is JsonNull }?.jsonPrimitive?.content,
                    lapCount = o["laps"]!!.jsonArray.size,
                )
            }
            val want = c["choices"]!!.jsonArray.map {
                val o = it.jsonObject
                Garage.SwapSessionChoice(o.int("id")!!, o["label"]!!.jsonPrimitive.content)
            }
            assertEquals(want, Garage.swapSessionChoices(sessions))
        }
    }

    private fun JsonObject.int(key: String): Int? = this[key]?.let {
        if (it is JsonNull) null else it.jsonPrimitive.intOrNull
    }
}
