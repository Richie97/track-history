package app.trackevolution.core

import app.trackevolution.core.model.AxleValues
import app.trackevolution.core.model.CornerValues
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.core.model.Setup
import app.trackevolution.core.model.SetupSheet
import app.trackevolution.core.model.UnitSystem
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The setup notebook's pure half (NS-40) — `Garage`'s setup-sheet helpers and
 * `Health`'s pressure loop — asserted against `contracts/logic/setups.json`,
 * which `npm run contracts:logic` generates from `public/js/garage.js` and
 * `public/js/health.js`. The same fixture the iOS Kit asserts against.
 */
class SetupsTest {
    private val fixture: JsonObject =
        Json.parseToJsonElement(RepoRoot.path("contracts/logic/setups.json").readText()).jsonObject
    private val health: JsonObject =
        Json.parseToJsonElement(RepoRoot.path("contracts/logic/health.json").readText()).jsonObject
    private val lenient = Json { ignoreUnknownKeys = true }

    private fun units(name: String) = if (name == "metric") UnitSystem.METRIC else UnitSystem.IMPERIAL
    private fun sheet(e: JsonElement): SetupSheet = lenient.decodeFromJsonElement(SetupSheet.serializer(), e)
    private fun encode(s: SetupSheet): JsonElement = Json.encodeToJsonElement(SetupSheet.serializer(), s)
    private fun num(e: JsonElement): Double? = if (e is JsonNull) null else e.jsonPrimitive.doubleOrNull

    private fun assertSameJson(want: JsonElement, got: JsonElement, what: String) {
        assertNull(JsonShape.difference(JsonShape.normalize(want), JsonShape.normalize(got)), what)
    }

    @Test
    fun `the field spec matches the web's`() {
        val want = fixture.getValue("SETUP_FIELDS").jsonArray.map { it.jsonObject }
        assertEquals(want.map { it.getValue("key").jsonPrimitive.content }, Garage.SETUP_FIELDS.map { it.key })
        for ((w, f) in want.zip(Garage.SETUP_FIELDS)) {
            assertEquals(w.getValue("label").jsonPrimitive.content, f.label)
            assertEquals(w.getValue("unit").jsonPrimitive.content, f.unit)
            assertEquals(w.getValue("shape").jsonPrimitive.content, f.shape.name.lowercase())
            assertEquals(w.getValue("step").jsonPrimitive.double, f.step)
        }
        assertEquals(
            fixture.getValue("PART_REFS").jsonArray.map { it.jsonArray.map { v -> v.jsonPrimitive.content } },
            Garage.PART_REFS.map { listOf(it.key, it.label, it.kind.rawValue) },
        )
        assertEquals(
            fixture.getValue("CORNER_KEYS").jsonArray.map { it.jsonArray.map { v -> v.jsonPrimitive.content } },
            Garage.CORNER_KEYS.map { listOf(it.first, it.second) },
        )
    }

    @Test
    fun `display and stored conversions match in both systems`() {
        for (row in fixture.getValue("fields").jsonArray.map { it.jsonObject }) {
            val f = Garage.SETUP_FIELDS.single { it.key == row.getValue("key").jsonPrimitive.content }
            val u = units(row.getValue("units").jsonPrimitive.content)
            val what = "${f.key} ${row.getValue("units")}"
            assertEquals(row.getValue("unit").jsonPrimitive.content, Garage.setupUnit(f, u), what)
            assertEquals(row.getValue("step").jsonPrimitive.double, Garage.setupStep(f, u), what)
            for (pair in row.getValue("display").jsonArray) {
                val (input, out) = pair.jsonArray
                assertEquals(num(out)!!, Garage.setupToDisplay(f, num(input), u)!!, 1e-9, "$what display $input")
            }
            for (pair in row.getValue("stored").jsonArray) {
                val (input, out) = pair.jsonArray
                assertEquals(num(out)!!, Garage.setupToStored(f, num(input), u)!!, 1e-9, "$what stored $input")
            }
        }
    }

    @Test
    fun `flattening, labels, units and value text match`() {
        for (pair in fixture.getValue("fieldFor").jsonArray) {
            val (key, field) = pair.jsonArray
            val want = if (field is JsonNull) null else field.jsonPrimitive.content
            assertEquals(want, Garage.setupFieldFor(key.jsonPrimitive.content)?.key, key.toString())
        }
        val flat = fixture.getValue("flat").jsonObject
        val full = sheet(flat.getValue("sheet"))
        val want = flat.getValue("flatten").jsonArray.map { it.jsonArray[0].jsonPrimitive.content to it.jsonArray[1].jsonPrimitive.double }
        assertEquals(want, Garage.flattenSetup(full))
        for (pair in flat.getValue("labels").jsonArray) {
            val (key, label) = pair.jsonArray
            assertEquals(label.jsonPrimitive.content, Garage.flatLabel(key.jsonPrimitive.content))
        }
        assertEquals(flat.getValue("unknownLabel").jsonPrimitive.content, Garage.flatLabel("nonsense"))
        assertTrue(Garage.flattenSetup(null).isEmpty())
        for (system in flat.getValue("units").jsonArray.map { it.jsonObject }) {
            val u = units(system.getValue("units").jsonPrimitive.content)
            for (pair in system.getValue("units_of").jsonArray) {
                val (key, unit) = pair.jsonArray
                assertEquals(unit.jsonPrimitive.content, Garage.flatUnit(key.jsonPrimitive.content, u))
            }
            for (triple in system.getValue("values").jsonArray) {
                val (key, v, text) = triple.jsonArray
                assertEquals(text.jsonPrimitive.content, Garage.fmtSetupValue(key.jsonPrimitive.content, num(v), u), "$key $v $u")
            }
        }
    }

    @Test
    fun `diffs match`() {
        val diff = fixture.getValue("diff").jsonObject
        fun changes(e: JsonElement) = e.jsonArray.map {
            val o = it.jsonObject
            Garage.SetupChange(o.getValue("key").jsonPrimitive.content, num(o.getValue("from")), num(o.getValue("to")))
        }
        assertEquals(changes(diff.getValue("changes")), Garage.diffSetups(sheet(diff.getValue("prev")), sheet(diff.getValue("cur"))))
        assertEquals(
            changes(diff.getValue("fromNothing")),
            Garage.diffSetups(null, SetupSheet(tpCold = CornerValues(fl = 26.0), fuel = 10.0)),
        )
        assertEquals(
            changes(diff.getValue("toNothing")),
            Garage.diffSetups(SetupSheet(camber = AxleValues(f = -3.0)), null),
        )
        assertTrue(Garage.diffSetups(sheet(diff.getValue("prev")), sheet(diff.getValue("prev"))).isEmpty())
    }

    @Test
    fun `previousSheet matches`() {
        val prev = fixture.getValue("previous").jsonObject
        val setups = prev.getValue("setups").jsonArray.map {
            Setup(it.jsonObject.getValue("day").jsonPrimitive.int, sheet(it.jsonObject.getValue("data")))
        }
        for (pair in prev.getValue("cases").jsonArray) {
            val (day, want) = pair.jsonArray
            val got = Garage.previousSheet(setups, day.jsonPrimitive.int)
            if (want is JsonNull) assertNull(got, "day $day") else assertSameJson(want, encode(got!!), "day $day")
        }
        assertNull(Garage.previousSheet(emptyList(), 2))
    }

    @Test
    fun `the pressure loop and the sheets its buttons write match`() {
        val loopFx = fixture.getValue("loop").jsonObject
        val channels = lenient.decodeFromJsonElement(
            SessionChannels.serializer(),
            health.getValue("input").jsonObject.getValue("channels"),
        )
        val sheet = sheet(loopFx.getValue("sheet"))
        val target = loopFx.getValue("targetPsi").jsonPrimitive.double
        val loop = Health.pressureLoop(channels, sheet, target)!!
        val noTarget = Health.pressureLoop(channels, sheet, null)!!

        val wantLoop = loopFx.getValue("loop").jsonObject
        assertSameJson(wantLoop.getValue("hotSheet"), Json.encodeToJsonElement(CornerValues.serializer(), loop.hotSheet), "hotSheet")
        assertSameJson(wantLoop.getValue("coldSheet"), Json.encodeToJsonElement(CornerValues.serializer(), loop.coldSheet!!), "coldSheet")
        val rows = wantLoop.getValue("rows").jsonArray.map { it.jsonObject }
        assertEquals(rows.size, loop.rows.size)
        for ((w, r) in rows.zip(loop.rows)) {
            assertEquals(w.getValue("corner").jsonPrimitive.content, r.corner)
            assertEquals(num(w.getValue("coldPsi")), r.coldPsi)
            assertEquals(num(w.getValue("hotPsi"))!!, r.hotPsi!!, 1e-9)
            assertEquals(w.getValue("hotChIdx").jsonPrimitive.int, r.hotChIdx)
            val s = w.getValue("suggestion")
            if (s is JsonNull) {
                assertNull(r.suggestion)
            } else {
                assertEquals(s.jsonObject.getValue("suggestedPsi").jsonPrimitive.double, r.suggestion!!.suggestedPsi, 1e-9)
            }
        }
        assertNull(noTarget.coldSheet)
        assertEquals(loopFx.getValue("loopNoSheet").jsonObject.getValue("coldSheet"), JsonNull)
        assertNull(Health.pressureLoop(channels, null, target)!!.coldSheet)

        assertEquals(loopFx.getValue("note").jsonPrimitive.content, Health.nextTimeNote(loop))
        assertEquals(JsonNull, loopFx.getValue("noteNoTarget"))
        assertNull(Health.nextTimeNote(noTarget))

        val once = Health.recordHotSheet(sheet, loop)
        assertSameJson(loopFx.getValue("recordedOnce"), encode(once), "recordedOnce")
        assertSameJson(loopFx.getValue("recordedTwice"), encode(Health.recordHotSheet(once, loop)), "recordedTwice")
        assertSameJson(loopFx.getValue("recordedOnNothing"), encode(Health.recordHotSheet(null, loop)), "recordedOnNothing")

        val full = sheet(fixture.getValue("flat").jsonObject.getValue("sheet"))
        assertSameJson(loopFx.getValue("nextFromToday"), encode(Health.nextDaySheet(null, full, loop)), "nextFromToday")
        assertSameJson(
            loopFx.getValue("nextKeepsItsOwn"),
            encode(
                Health.nextDaySheet(
                    SetupSheet(camber = AxleValues(f = -2.0), tpCold = CornerValues(fl = 20.0)),
                    full,
                    loop,
                ),
            ),
            "nextKeepsItsOwn",
        )
        assertSameJson(loopFx.getValue("nextNoSuggestion"), encode(Health.nextDaySheet(null, full, noTarget)), "nextNoSuggestion")
    }

    @Test
    fun `withSheetValue sets, clears and drops an emptied group`() {
        var s = SetupSheet()
        s = Garage.withSheetValue(s, "tp_cold.fl", 26.0)
        s = Garage.withSheetValue(s, "tires_f_id", 12.0)
        assertEquals(26.0, Garage.sheetValue(s, "tp_cold.fl"))
        assertEquals(12.0, Garage.sheetValue(s, "tires_f_id"))
        s = Garage.withSheetValue(s, "tp_cold.fl", null)
        assertNull(s.tpCold, "a group with nothing left is dropped, as sanitizeSetup drops it")
        assertTrue(!Garage.isEmptySheet(s))
        assertTrue(Garage.isEmptySheet(Garage.withSheetValue(s, "tires_f_id", null)))
    }
}
