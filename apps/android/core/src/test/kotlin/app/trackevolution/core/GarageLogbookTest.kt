package app.trackevolution.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * A car's logbook (NS-37) — `vehicleLogbook` / `vehicleTileLine` — and its
 * agreement with the web app.
 *
 * Carries the JS cases from `test/unit/garage.test.js` (the
 * `vehicleLogbook / vehicleTileLine (NS-37)` block) and asserts field-for-field
 * equality with `contracts/logic/garage-logbook.json`, which
 * `npm run contracts:logic` generates from `public/js/garage.js` — the same
 * fixture the iOS Kit asserts against.
 */
class GarageLogbookTest {

    private data class Row(
        override val id: Int,
        override val vehicleId: Int? = 1,
        override val trackId: Int = 100,
        override val trackName: String = "VIR",
        override val startDate: String = "2026-06-01",
        override val days: Double = 1.0,
        override val bestMs: Int? = null,
    ) : Garage.LogbookEvent

    private val today = "2026-09-20"

    // ---- The JS cases ----------------------------------------------------------

    @Test
    fun `counts track days, not events, and a track day that starts today is past`() {
        val lb = Garage.vehicleLogbook(1, listOf(Row(1, days = 2.0), Row(2, startDate = today)), today)
        assertEquals(3.0, lb.trackDays)
        assertEquals(2, lb.events)
        assertEquals(2, lb.lastEvent?.id)
        assertNull(lb.nextEvent)
    }

    @Test
    fun `only counts rows the server matched to the car`() {
        val lb = Garage.vehicleLogbook(1, listOf(Row(1, vehicleId = null), Row(2, vehicleId = 2)), today)
        assertEquals(0, lb.events)
        assertEquals("No track days yet", Garage.vehicleTileLine(lb))
    }

    @Test
    fun `keeps one best per track — the fastest, the earlier event on a tie`() {
        val lb = Garage.vehicleLogbook(
            1,
            listOf(
                Row(1, bestMs = 90000),
                Row(2, startDate = "2026-07-01", bestMs = 90000),
                Row(3, startDate = "2026-08-01", bestMs = 95000),
            ),
            today,
        )
        assertEquals(
            listOf(Garage.LogbookBest(trackId = 100, trackName = "VIR", bestMs = 90000, eventId = 1, startDate = "2026-06-01")),
            lb.bests,
        )
    }

    @Test
    fun `orders tracks by the car's latest event there, event id breaking a date tie`() {
        val lb = Garage.vehicleLogbook(
            1,
            listOf(
                Row(1, trackId = 100, bestMs = 1),
                Row(2, trackId = 101, trackName = "NCM", startDate = "2026-07-01", bestMs = 2),
                Row(3, trackId = 102, trackName = "Summit", startDate = "2026-07-01", bestMs = 3),
                Row(4, trackId = 103, trackName = "Glen", startDate = "2026-08-01"),
            ),
            today,
        )
        assertEquals(listOf(102, 101, 100), lb.bests.map { it.trackId })
    }

    @Test
    fun `words the tile from the last event, else the next, else nothing yet`() {
        assertEquals("1 track day · last at VIR", Garage.vehicleTileLine(Garage.vehicleLogbook(1, listOf(Row(1)), today)))
        assertEquals(
            "3 track days · last at VIR",
            Garage.vehicleTileLine(Garage.vehicleLogbook(1, listOf(Row(1, days = 3.0)), today)),
        )
        assertEquals(
            "Next: Glen",
            Garage.vehicleTileLine(Garage.vehicleLogbook(1, listOf(Row(1, startDate = "2026-10-01", trackName = "Glen")), today)),
        )
    }

    @Test
    fun `a fractional day count prints the way JavaScript does`() {
        // `days` is REAL; `${1.5}` is "1.5" and `${2}` is "2", never "2.0".
        val lb = Garage.vehicleLogbook(1, listOf(Row(1, days = 0.5), Row(2, days = 1.0)), today)
        assertEquals("1.5 track days · last at VIR", Garage.vehicleTileLine(lb))
    }

    // ---- Cross-language agreement ----------------------------------------------

    @Test
    fun `matches the JavaScript implementation on the shared fixture`() {
        val fixture = Json.parseToJsonElement(RepoRoot.path("contracts/logic/garage-logbook.json").readText()).jsonObject
        val fixtureToday = fixture["today"]!!.jsonPrimitive.content
        val events = fixture["events"]!!.jsonArray.map { element ->
            val o = element.jsonObject
            Row(
                id = o.int("id")!!,
                vehicleId = o.int("vehicle_id"),
                trackId = o.int("track_id")!!,
                trackName = o["track_name"]!!.jsonPrimitive.content,
                startDate = o["start_date"]!!.jsonPrimitive.content,
                days = o["days"]!!.jsonPrimitive.doubleOrNull!!,
                bestMs = o.int("best_ms"),
            )
        }
        val cases = fixture["cases"]!!.jsonArray
        assertEquals(4, cases.size, "the fixture grew — check the new case is covered")
        for (element in cases) {
            val case = element.jsonObject
            val name = case["name"]!!.jsonPrimitive.content
            val vehicleId = case["vehicle_id"]!!.jsonPrimitive.int
            val expected = case["expected"]!!.jsonObject
            val want = expected["logbook"]!!.jsonObject
            val got = Garage.vehicleLogbook(vehicleId, events, fixtureToday)

            assertEquals(want["track_days"]!!.jsonPrimitive.doubleOrNull, got.trackDays, "$name: track_days")
            assertEquals(want.int("events"), got.events, "$name: events")
            assertEquals(ref(want["last_event"]!!), got.lastEvent, "$name: last_event")
            assertEquals(ref(want["next_event"]!!), got.nextEvent, "$name: next_event")
            val wantBests = want["bests"]!!.jsonArray.map {
                val b = it.jsonObject
                Garage.LogbookBest(
                    trackId = b.int("track_id")!!,
                    trackName = b["track_name"]!!.jsonPrimitive.content,
                    bestMs = b.int("best_ms")!!,
                    eventId = b.int("event_id")!!,
                    startDate = b["start_date"]!!.jsonPrimitive.content,
                )
            }
            assertEquals(wantBests, got.bests, "$name: bests")
            assertEquals(expected["tileLine"]!!.jsonPrimitive.content, Garage.vehicleTileLine(got), "$name: tileLine")
        }
    }

    private fun ref(element: JsonElement): Garage.LogbookEventRef? {
        if (element is JsonNull) return null
        val o = element.jsonObject
        return Garage.LogbookEventRef(
            id = o.int("id")!!,
            trackId = o.int("track_id")!!,
            trackName = o["track_name"]!!.jsonPrimitive.content,
            startDate = o["start_date"]!!.jsonPrimitive.content,
        )
    }

    private fun JsonObject.int(key: String): Int? = (this[key] as? JsonElement)?.let {
        if (it is JsonNull) null else it.jsonPrimitive.intOrNull
    }
}
