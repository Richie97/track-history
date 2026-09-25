package app.trackevolution.core

import app.trackevolution.core.model.CatalogCar
import app.trackevolution.core.model.GarageVehicle
import app.trackevolution.core.model.Part
import app.trackevolution.core.model.PartKind
import app.trackevolution.core.model.PartMount
import app.trackevolution.core.model.PartOdometer
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.model.VehicleOdometer
import app.trackevolution.core.model.WearEstimate
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
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
            assertEquals(case["isTire"]!!.jsonPrimitive.content.toBoolean(), Garage.isTireKind(kind), "isTireKind($kind)")
            assertEquals(
                case["swapKinds"]!!.jsonArray.map { it.jsonPrimitive.content },
                Garage.equipSwapKinds(kind).map { it.rawValue },
                "equipSwapKinds($kind)",
            )
        }

        // The Equipped switch (migration 0029): what equipping takes off.
        val equip = fixture["equip"]!!.jsonObject
        val shelf = equip["parts"]!!.jsonArray.map { element ->
            val row = element.jsonObject
            Part(
                id = row["id"]!!.jsonPrimitive.content.toInt(),
                vehicleId = 1,
                kind = PartKind(row["kind"]!!.jsonPrimitive.content),
                name = row["name"]!!.jsonPrimitive.content,
                size = row["size"]!!.jsonPrimitive.contentOrNullSafe(),
                installedOn = "2026-01-01",
                retiredOn = row["retired_on"]!!.jsonPrimitive.contentOrNullSafe(),
                equipped = row["equipped"]?.jsonPrimitive?.content?.toBoolean(),
                measurements = emptyList(),
                wear = wear(null),
            )
        }
        val equipCases = equip["cases"]!!.jsonArray
        for (element in equipCases) {
            val case = element.jsonObject
            val probe = case["part"]!!.jsonObject
            val id = probe["id"]!!.jsonPrimitive.contentOrNullSafe()?.toInt()
            val kind = PartKind(probe["kind"]!!.jsonPrimitive.content)
            assertEquals(
                case["swapsOff"]!!.jsonArray.map { it.jsonPrimitive.content.toInt() },
                Garage.equipSwapsOff(id, kind, shelf).map { it.id },
                "equipSwapsOff($id, $kind)",
            )
        }
        for (element in fixture["titles"]!!.jsonArray) {
            val case = element.jsonObject
            val part = case["part"]!!.jsonObject
            assertEquals(
                case["title"]!!.jsonPrimitive.content,
                Garage.partTitle(part["name"]!!.jsonPrimitive.content, part["size"]!!.jsonPrimitive.contentOrNullSafe()),
            )
        }
        assertTrue(equipCases.size >= 6, "equip fixture shrank")

        // The car's own odometer (#192).
        val odometer = fixture["odometer"]!!.jsonArray
        for (element in odometer) {
            val case = element.jsonObject
            val units = json.decodeFromJsonElement(UnitSystem.serializer(), case["units"]!!)
            val vehicle = case["vehicle"]!!.takeUnless { it is JsonNull }
                ?.let { json.decodeFromJsonElement(VehicleOdometer.serializer(), it) }
            assertEquals(
                case["line"]!!.jsonPrimitive.contentOrNullSafe(),
                Garage.vehicleOdometerLine(vehicle, units),
                "vehicleOdometerLine($vehicle, $units)",
            )
        }
        val partOdometer = fixture["partOdometer"]!!.jsonArray
        for (element in partOdometer) {
            val case = element.jsonObject
            val units = json.decodeFromJsonElement(UnitSystem.serializer(), case["units"]!!)
            val part = case["part"]!!.takeUnless { it is JsonNull }
                ?.let { json.decodeFromJsonElement(PartOdometer.serializer(), it) }
            assertEquals(
                case["line"]!!.jsonPrimitive.contentOrNullSafe(),
                Garage.partOdometerLine(part, units),
                "partOdometerLine($part, $units)",
            )
        }

        // A guard against the fixture silently emptying out and every loop above
        // passing vacuously.
        assertTrue(cases.size >= 10, "fixture shrank to ${cases.size} cases")
        assertTrue(odometer.size >= 8 && partOdometer.size >= 8, "odometer fixture shrank")
        assertEquals(PartKind.all.size, fixture["kinds"]!!.jsonArray.size)
    }

    // ---- Car catalog picker (#222) ----------------------------------------------

    private val catalogFixture = Json.parseToJsonElement(
        RepoRoot.path("contracts/logic/car-catalog-match.json").readText(),
    ).jsonObject

    @Test
    fun `matches the JavaScript catalog matcher on the shared fixture`() {
        val rows = json.decodeFromJsonElement(
            kotlinx.serialization.builtins.ListSerializer(CatalogCar.serializer()),
            catalogFixture["rows"]!!,
        )
        val byId = rows.associateBy { it.id }

        for (element in catalogFixture["labels"]!!.jsonArray) {
            val case = element.jsonObject
            val row = byId.getValue(case["id"]!!.jsonPrimitive.content.toInt())
            assertEquals(case["name"]!!.jsonPrimitive.content, Garage.catalogCarName(row), "name of ${row.id}")
            assertEquals(case["label"]!!.jsonPrimitive.content, Garage.catalogCarLabel(row), "label of ${row.id}")
        }

        val queries = catalogFixture["queries"]!!.jsonArray
        for (element in queries) {
            val case = element.jsonObject
            val query = case["query"]!!.jsonPrimitive.content
            assertEquals(
                case["ids"]!!.jsonArray.map { it.jsonPrimitive.content.toInt() },
                Garage.matchCatalogCars(query, rows).map { it.id },
                "query \"$query\"",
            )
        }

        val prefills = catalogFixture["prefill"]!!.jsonArray
        for (element in prefills) {
            val case = element.jsonObject
            val name = case["name"]!!.jsonPrimitive.content
            val row = byId.getValue(case["row"]!!.jsonPrimitive.content.toInt())
            val previous = case["previous"]!!.jsonPrimitive.contentOrNullSafe()?.let { byId.getValue(it.toInt()) }
            val current = case["current"]!!.jsonObject
            val plan = Garage.catalogPrefill(
                row,
                Garage.VehicleGeometry(
                    wheelbaseMm = current["wheelbase_mm"]!!.jsonPrimitive.contentOrNullSafe()?.toInt(),
                    steeringRatio = current["steering_ratio"]!!.jsonPrimitive.contentOrNullSafe()?.toDouble(),
                ),
                previous,
            )
            val expected = case["plan"]!!.jsonObject
            val wheelbase = expected["wheelbase_mm"]!!.jsonObject
            val steering = expected["steering_ratio"]!!.jsonObject
            assertEquals(wheelbase["action"]!!.jsonPrimitive.content, plan.wheelbaseMm.action.rawValue, "$name: wheelbase")
            assertEquals(wheelbase["value"]!!.jsonPrimitive.contentOrNullSafe()?.toInt(), plan.wheelbaseMm.value, "$name: wheelbase value")
            assertEquals(steering["action"]!!.jsonPrimitive.content, plan.steeringRatio.action.rawValue, "$name: ratio")
            assertEquals(steering["value"]!!.jsonPrimitive.contentOrNullSafe()?.toDouble(), plan.steeringRatio.value, "$name: ratio value")
        }

        assertTrue(queries.size >= 10, "fixture shrank to ${queries.size} queries")
        assertTrue(prefills.size >= 5, "fixture shrank to ${prefills.size} pre-fill cases")
    }

    @Test
    fun `every query token has to fit, so extra words narrow`() {
        assertEquals(listOf(3), Garage.matchCatalogCars("corvette c8", catalogRows).map { it.id })
        assertEquals(emptyList<Int>(), Garage.matchCatalogCars("corvette miata", catalogRows).map { it.id })
        assertEquals(listOf(1, 2, 3, 4, 5, 6), Garage.matchCatalogCars("", catalogRows).map { it.id })
    }

    @Test
    fun `ranks whole words over prefixes over substrings`() {
        // "e46" is a whole word on the M3; "e" is only inside the others' names.
        assertEquals(listOf(1, 2, 3, 5), Garage.matchCatalogCars("e", catalogRows).map { it.id })
        assertEquals(listOf(4), Garage.matchCatalogCars("mx5", catalogRows).map { it.id })
        assertEquals(listOf(2), Garage.matchCatalogCars("corvette 2017", catalogRows).map { it.id })
    }

    @Test
    fun `prefills silently only what is not the driver's`() {
        val c7 = catalogRows[1]
        val c8 = catalogRows[2]
        val cayman = catalogRows[4]
        val fill = Garage.CatalogPrefillAction.FILL
        val ask = Garage.CatalogPrefillAction.ASK
        val keep = Garage.CatalogPrefillAction.KEEP

        val empty = Garage.catalogPrefill(c7, Garage.VehicleGeometry(), null)
        assertEquals(Garage.CatalogPrefillStep(2710, fill), empty.wheelbaseMm)
        assertEquals(Garage.CatalogPrefillStep(16.25, fill), empty.steeringRatio)

        val typed = Garage.catalogPrefill(c7, Garage.VehicleGeometry(2700, 15.0), null)
        assertEquals(ask, typed.wheelbaseMm.action)
        assertEquals(ask, typed.steeringRatio.action)

        val repick = Garage.catalogPrefill(c8, Garage.VehicleGeometry(2710, 15.0), c7)
        assertEquals(fill, repick.wheelbaseMm.action)
        assertEquals(ask, repick.steeringRatio.action)

        // Never offers to replace the driver's number with nothing, but does
        // clear the previous car's ratio when the new car has none.
        assertEquals(keep, Garage.catalogPrefill(cayman, Garage.VehicleGeometry(2700, 15.0), null).steeringRatio.action)
        assertEquals(
            Garage.CatalogPrefillStep<Double>(null, fill),
            Garage.catalogPrefill(cayman, Garage.VehicleGeometry(2710, 16.25), c7).steeringRatio,
        )
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

    // ---- On the car, or on the shelf (migration 0029) -------------------------

    @Test
    fun `sorts the on-car, spare and retired parts apart`() {
        val onCar = part(1, 2.0).copy(equipped = true)
        val cached = part(2, 2.0) // no `equipped`: cached before 0029
        val spare = part(3, 2.0).copy(equipped = false)
        val retired = part(4, 2.0, retiredOn = "2026-03-01").copy(equipped = false)
        assertEquals(listOf(1, 2), listOf(onCar, cached, spare, retired).filter(Garage::isOnCar).map { it.id })
        assertEquals(listOf(3), listOf(onCar, cached, spare, retired).filter(Garage::isSpare).map { it.id })
    }

    @Test
    fun `lists parts in the car's order, newest first within a kind`() {
        val rotor = part(1, 2.0).copy(kind = PartKind.ROTORS_FRONT)
        val rearTires = part(2, 2.0).copy(kind = PartKind.TIRES_REAR)
        val oldPads = part(3, 2.0).copy(installedOn = "2025-06-01")
        val newPads = part(4, 2.0).copy(installedOn = "2026-06-01")
        val fullSet = part(5, 2.0).copy(kind = PartKind.TIRES)
        assertEquals(
            listOf(4, 3, 5, 2, 1),
            Garage.sortedByKind(listOf(rotor, rearTires, oldPads, newPads, fullSet)).map { it.id },
        )
    }

    @Test
    fun `bounds the swap date by the part's mounts`() {
        val fitted = part(1, 2.0).copy(
            equipped = true,
            mounts = listOf(
                PartMount("2026-01-01", "2026-02-01"),
                PartMount("2026-04-10", null),
            ),
        )
        assertEquals("2026-04-10", Garage.earliestSwapDate(fitted))
        assertEquals("2026-02-01", Garage.lastOff(fitted))

        val offSince = part(2, 2.0).copy(
            equipped = false,
            mounts = listOf(PartMount("2026-01-01", "2026-02-01"), PartMount("2026-03-01", "2026-05-20")),
        )
        assertEquals("2026-05-20", Garage.earliestSwapDate(offSince))

        val neverFitted = part(3, 2.0).copy(equipped = false, mounts = emptyList())
        assertNull(Garage.lastOff(neverFitted))
        assertEquals("2026-01-01", Garage.earliestSwapDate(neverFitted))
    }

    @Test
    fun `says what the switch will take off before it does`() {
        val fullSet = part(1, 2.0).copy(kind = PartKind.TIRES, name = "RE-71RS", size = "255/40R17", equipped = true)
        val front = part(2, 2.0).copy(kind = PartKind.TIRES_FRONT, name = "A7", equipped = false)
        val rear = part(3, 2.0).copy(kind = PartKind.TIRES_REAR, name = "A7", equipped = true)
        val spareSet = part(4, 2.0).copy(kind = PartKind.TIRES, name = "Street", equipped = false)
        val parts = listOf(fullSet, front, rear, spareSet)

        assertEquals(
            "Take it off the car? It moves to Spares with its history, and its wear stops until it goes back on.",
            Garage.equipNote(fullSet, parts),
        )
        assertEquals(
            "Put it on the car? This takes off RE-71RS · 255/40R17 — it moves to Spares.",
            Garage.equipNote(front, parts),
        )
        assertEquals(
            "Put it on the car? This takes off RE-71RS · 255/40R17 and A7 — they move to Spares.",
            Garage.equipNote(spareSet, parts),
        )
        assertEquals("Takes off Hawk DTC-60 — it moves to Spares.", Garage.addSwapNote(PartKind.PADS_FRONT, listOf(part(9, 2.0).copy(equipped = true))))
        assertNull(Garage.addSwapNote(PartKind.OTHER, parts))
        assertEquals(
            "Put it on the car? Its wear picks up from here.",
            Garage.equipNote(part(5, 2.0).copy(kind = PartKind.OIL, equipped = false), parts),
        )
    }

    // ---- Fixtures -----------------------------------------------------------

    /** The six rows `test/unit/garage.test.js` uses for the catalog cases. */
    private val catalogRows = listOf(
        car(1, "BMW", "M3", "E46", 2000, 2006, 2731, 15.4),
        car(2, "Chevrolet", "Corvette", "C7", 2014, 2019, 2710, 16.25),
        car(3, "Chevrolet", "Corvette", "C8", 2020, null, 2722, 15.7),
        car(4, "Mazda", "MX-5", "ND", 2015, null, 2310, 15.5),
        car(5, "Porsche", "718 Cayman", "982", 2016, null, 2475, null),
        car(6, "Toyota", "GR86", null, 2022, null, 2575, 13.5),
    )

    private fun car(
        id: Int, make: String, model: String, generation: String?, from: Int, to: Int?, wheelbase: Int, ratio: Double?,
    ) = CatalogCar(
        id = id, make = make, model = model, generation = generation, yearFrom = from, yearTo = to,
        wheelbaseMm = wheelbase, steeringRatio = ratio, source = "test",
    )

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
