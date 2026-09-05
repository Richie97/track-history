package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The port of `test/unit/health.test.js`, case for case, plus the
 * cross-language pin against `contracts/logic/health.json`.
 */
class HealthTest {

    /**
     * A lap with everything inside its lines and one past every one of them —
     * the two cases the shading has to tell apart — plus a hand-entered lap.
     */
    private val cool = LapChannels(
        n = 1,
        timeMs = 118_000,
        boost = listOf(12.0, 88.0, 141.5),
        oilC = 104.0,
        oilKpa = 340.0,
        coolantC = 96.0,
        transC = 88.0,
        fuelPct = 62.0,
        battV = 13.8,
        tyreKpaLF = 214.0,
        tyreKpaRF = 210.0,
        tyreKpaLR = 206.0,
        tyreKpaRR = 205.0,
        tyreCLF = 78.0,
        tyreCRF = 71.0,
        tyreCLR = 66.0,
        tyreCRR = 64.0,
    )
    private val hot = LapChannels(
        n = 2,
        timeMs = 119_900,
        oilC = 134.0,
        oilKpa = 110.0,
        coolantC = 122.0,
        transC = 128.0,
        fuelPct = 41.0,
        battV = 12.2,
        tyreKpaLF = 244.0,
        tyreKpaRF = 236.0,
        tyreKpaLR = 225.0,
        tyreKpaRR = 221.0,
        tyreCLF = 108.0,
        tyreCRF = 92.0,
        tyreCLR = 77.0,
        tyreCRR = 75.0,
    )
    private val bare = LapChannels(n = 3, timeMs = 121_000, speed = listOf(80.0, 90.0, 100.0))

    private val channels = SessionChannels(v = 1, dStepM = 20.0, laps = listOf(cool, hot, bare))

    private fun sessionOf(vararg laps: LapChannels) =
        SessionChannels(v = 1, dStepM = 20.0, laps = laps.toList())

    private fun fuelSession(vararg pcts: Double) = SessionChannels(
        v = 1,
        dStepM = 20.0,
        laps = pcts.mapIndexed { i, pct -> LapChannels(n = i + 1, timeMs = 118_000, fuelPct = pct) },
    )

    @Test
    fun `reads the stored scalar and derives only boost`() {
        assertEquals(104.0, Health.lapValue(cool, "oilC"))
        assertEquals(64.0, Health.lapValue(cool, "tyreCRR"))
        // The one derivation: the peak of the gridded trace.
        assertEquals(141.5, Health.lapValue(cool, "boost"))
        assertNull(Health.lapValue(hot, "boost"))
        assertNull(Health.lapValue(bare, "oilC"))
        assertNull(Health.lapValue(null, "oilC"))
    }

    @Test
    fun `knows which laps have anything to show`() {
        assertTrue(Health.hasHealthData(cool))
        assertFalse(Health.hasHealthData(bare))
        assertEquals(listOf(0, 1), Health.healthLaps(channels).map { it.chIdx })
        assertTrue(Health.healthLaps(null).isEmpty())
    }

    @Test
    fun `shades both bounds inclusively and reads a floor downward`() {
        val oil = Health.defFor("oilC")
        assertEquals(Health.Status.OK, Health.healthStatus(oil, 119.9))
        assertEquals(Health.Status.LOW, Health.healthStatus(oil, 120.0)) // the watch line counts
        assertEquals(Health.Status.DUE, Health.healthStatus(oil, 130.0)) // and so does the over line
        // A floor column: the hazard is below the lines, not above them.
        val pressure = Health.defFor("oilKpa")
        assertEquals(Health.Status.OK, Health.healthStatus(pressure, 200.1))
        assertEquals(Health.Status.LOW, Health.healthStatus(pressure, 200.0))
        assertEquals(Health.Status.DUE, Health.healthStatus(pressure, 120.0))
        // A column with no line has no status, however hot it reads.
        assertNull(Health.healthStatus(Health.defFor("tyreCLF"), 300.0))
        assertNull(Health.healthStatus(null, 1.0))
    }

    @Test
    fun `takes the worst case per column by that column's own rule`() {
        val sh = Health.sessionHealth(channels)!!
        assertEquals(listOf(0, 1), sh.laps.map { it.chIdx })
        val oil = sh.columns.first { it.key == "oilC" }
        assertEquals(134.0, oil.extreme.v) // a peak column takes the maximum
        assertEquals(Health.Status.DUE, oil.status)
        val pressure = sh.columns.first { it.key == "oilKpa" }
        assertEquals(110.0, pressure.extreme.v) // a floor column takes the minimum
        assertEquals(Health.Status.DUE, pressure.status)
        // The boost column exists only because one lap stored the trace.
        assertEquals(1, sh.columns.first { it.key == "boost" }.series.size)
        assertNull(Health.sessionHealth(sessionOf(bare)))
        assertNull(Health.sessionHealth(null))
    }

    @Test
    fun `needs all four corners for a spread`() {
        val spread = Health.tyreSpread(cool)!!
        assertEquals(78.0 - 71, spread.front)
        assertEquals(66.0 - 64, spread.rear)
        assertEquals((78.0 + 71) / 2 - (66.0 + 64) / 2, spread.axle)
        // Three corners and a guess is not a spread.
        assertNull(Health.tyreSpread(cool.copy(tyreCRR = null)))
        // The same reduction over the pressures.
        assertEquals(214.0 - 210, Health.tyreSpread(cool, "tyreKpa")!!.front)
        assertEquals(listOf(0, 1), Health.sessionSpread(channels).map { it.chIdx })
    }

    @Test
    fun `takes the median drop and skips a refuel`() {
        // Drops of 12, 11 and 11 — the increase at the refuel is skipped, not
        // counted as a negative drop.
        val fuel = Health.fuelBurn(fuelSession(80.0, 68.0, 57.0, 95.0, 84.0))!!
        assertEquals(3, fuel.drops)
        assertEquals(11.0, fuel.perLapPct)
        assertEquals(84.0, fuel.lastPct)
        assertEquals(7, fuel.lapsRemaining)
        // One drop is one lap's noise.
        assertNull(Health.fuelBurn(fuelSession(50.0, 42.0)))
        assertNull(Health.fuelBurn(channels))
    }

    @Test
    fun `takes the highest end-of-lap reading per corner`() {
        val hotP = Health.hotPressures(channels)!!
        assertEquals(244.0, hotP["LF"]!!.peakKpa)
        assertEquals(1, hotP["LF"]!!.peakChIdx)
        assertEquals(221.0, hotP["RR"]!!.peakKpa)
        assertNull(Health.hotPressures(sessionOf(bare)))
    }

    @Test
    fun `suggests a cold pressure on the sheet's own step`() {
        // Grew 5 psi, wants to land 2 psi lower: start 2 psi lower.
        val s = Health.suggestCold(31.0, 36.0, 34.0)!!
        assertEquals(29.0, s.suggestedPsi)
        assertEquals(-2.0, s.deltaPsi)
        // Rounded to the sheet's half-psi step.
        assertEquals(28.5, Health.suggestCold(31.4, 36.9, 34.0)!!.suggestedPsi)
        // A tyre that didn't grow enough wants more cold pressure, not less.
        assertEquals(4.0, Health.suggestCold(30.0, 30.0, 34.0)!!.deltaPsi)
        assertNull(Health.suggestCold(null, 36.0, 34.0))
        assertNull(Health.suggestCold(31.0, 36.0, null))
        assertEquals(34.5, Health.roundPsi(34.26))
    }

    @Test
    fun `converts for display without touching the stored value`() {
        val oil = Health.defFor("oilC")!!
        assertEquals("100 °C", Health.displayValue(oil, 100.0, Health.Units.METRIC).text)
        assertEquals("212 °F", Health.displayValue(oil, 100.0, Health.Units.US).text)
        assertEquals(
            "14.5 psi",
            Health.displayValue(Health.defFor("tyreKpaLF")!!, 100.0, Health.Units.US).text,
        )
        // A delta scales but does not offset: +10 °C is +18 °F, not 50.
        assertEquals("+18 °F", Health.displayDelta(oil, 10.0, Health.Units.US).text)
        assertEquals("+10 °C", Health.displayDelta(oil, 10.0, Health.Units.METRIC).text)
    }

    @Test
    fun `names every figure past its line, worst first`() {
        assertEquals(
            "car: oil temp 134 °C, coolant 122 °C, transmission 128 °C, oil pressure 110 kPa, battery 12.2 V",
            Health.healthSummary(channels, Health.Units.METRIC),
        )
        // Nothing past a line and no fuel figure: no sentence at all.
        assertNull(Health.healthSummary(sessionOf(cool), Health.Units.METRIC))
        assertNull(Health.healthSummary(sessionOf(bare), Health.Units.METRIC))
    }

    @Test
    fun `counts the fuel left in laps`() {
        // Singular, because "1 laps of fuel" is how a port announces itself.
        assertEquals(
            "car: ≈1 lap of fuel at this rate",
            Health.healthSummary(fuelSession(30.0, 20.0, 10.0), Health.Units.METRIC),
        )
    }

    // ---- cross-language pin ------------------------------------------------

    @Serializable
    private data class ColumnRow(
        val key: String,
        val series: List<Health.SeriesPoint>,
        val extreme: Health.SeriesPoint,
        val status: Health.Status? = null,
    )

    @Serializable
    private data class LapRow(val chIdx: Int, val values: Map<String, Double>)

    @Serializable
    private data class SessionRow(val laps: List<LapRow>, val columns: List<ColumnRow>)

    /**
     * The JS implementation's own output for a shared input has to come back out
     * of this port: the wording exactly, the doubles to 1e-9.
     */
    @Test
    fun `matches the JavaScript implementation on a shared fixture`() {
        val json = Json { ignoreUnknownKeys = false }
        val fixture = Json.parseToJsonElement(
            RepoRoot.path("contracts/logic/health.json").readText(),
        ).jsonObject
        val input = fixture["input"]!!.jsonObject
        val expected = fixture["expected"]!!.jsonObject
        val fixtureChannels = json.decodeFromJsonElement<SessionChannels>(input["channels"]!!)
        val fuelChannels = json.decodeFromJsonElement<SessionChannels>(input["fuelChannels"]!!)
        val oneDropChannels = json.decodeFromJsonElement<SessionChannels>(input["oneDropChannels"]!!)
        val lastLapChannels = json.decodeFromJsonElement<SessionChannels>(input["lastLapChannels"]!!)

        // The columns themselves: a port that drops one or reorders them fails
        // here rather than on a screen.
        assertEquals(json.decodeFromJsonElement<List<Health.Def>>(input["defs"]!!), Health.HEALTH_DEFS)
        assertEquals(
            json.decodeFromJsonElement<List<List<String>>>(input["groups"]!!),
            Health.HEALTH_GROUPS.map { listOf(it.first, it.second) },
        )
        assertEquals(
            json.decodeFromJsonElement<List<List<String>>>(input["corners"]!!),
            Health.TYRE_CORNERS.map { listOf(it.first, it.second) },
        )

        val full = fixtureChannels.laps[0]
        val partial = fixtureChannels.laps[3]
        for (row in expected["lapValues"]!!.jsonArray) {
            val cells = row.jsonArray
            val key = cells[0].jsonPrimitive.content
            assertEquals(doubleOrNull(cells[1]), Health.lapValue(full, key), "lapValue $key on the full lap")
            assertEquals(doubleOrNull(cells[2]), Health.lapValue(partial, key), "lapValue $key on the partial lap")
        }
        assertEquals(expected["boostPeak"]!!.jsonPrimitive.content.toDouble(), Health.lapValue(full, "boost"))
        assertNull(Health.lapValue(fixtureChannels.laps[2], "boost"))
        assertEquals(
            json.decodeFromJsonElement<List<Boolean>>(expected["hasData"]!!),
            fixtureChannels.laps.map { Health.hasHealthData(it) },
        )
        assertEquals(
            json.decodeFromJsonElement<List<Int>>(expected["healthLaps"]!!),
            Health.healthLaps(fixtureChannels).map { it.chIdx },
        )
        assertEquals(
            json.decodeFromJsonElement<List<Health.SeriesPoint>>(expected["series"]!!),
            Health.scalarSeries(fixtureChannels, "oilC"),
        )

        val probes = input["statusProbes"]!!.jsonArray.map {
            it.jsonArray[0].jsonPrimitive.content to it.jsonArray[1].jsonPrimitive.content.toDouble()
        }
        assertEquals(
            json.decodeFromJsonElement<List<Health.Status?>>(expected["statuses"]!!),
            probes.map { (key, v) -> Health.healthStatus(Health.defFor(key), v) },
        )

        val wantSession = json.decodeFromJsonElement<SessionRow>(expected["session"]!!)
        val session = Health.sessionHealth(fixtureChannels)!!
        assertEquals(wantSession.columns.map { it.key }, session.columns.map { it.key })
        session.columns.forEachIndexed { i, col ->
            val w = wantSession.columns[i]
            assertEquals(w.status, col.status, "column ${col.key} status")
            assertEquals(w.extreme, col.extreme, "column ${col.key} extreme")
            assertEquals(w.series, col.series, "column ${col.key} series")
        }
        assertEquals(wantSession.laps.map { it.chIdx }, session.laps.map { it.chIdx })
        session.laps.forEachIndexed { i, row ->
            assertEquals(wantSession.laps[i].values, row.values, "lap ${row.chIdx} values")
        }
        assertTrue(expected["noData"] is kotlinx.serialization.json.JsonNull)
        assertNull(Health.sessionHealth(sessionOf(fixtureChannels.laps[4])))

        assertEquals(
            json.decodeFromJsonElement<Health.Spread>(expected["spreadFull"]!!),
            Health.tyreSpread(full),
        )
        assertEquals(
            json.decodeFromJsonElement<Health.Spread>(expected["spreadPressures"]!!),
            Health.tyreSpread(full, "tyreKpa"),
        )
        assertNull(Health.tyreSpread(partial))
        assertEquals(
            json.decodeFromJsonElement<List<Health.LapSpread>>(expected["sessionSpread"]!!),
            Health.sessionSpread(fixtureChannels),
        )

        assertEquals(
            json.decodeFromJsonElement<Health.FuelBurn>(expected["fuel"]!!),
            Health.fuelBurn(fuelChannels),
        )
        assertNull(Health.fuelBurn(oneDropChannels))

        assertEquals(
            json.decodeFromJsonElement<Map<String, Health.HotPressure>>(expected["hot"]!!),
            Health.hotPressures(fixtureChannels),
        )
        assertNull(Health.hotPressures(sessionOf(fixtureChannels.laps[4])))

        assertEquals(
            json.decodeFromJsonElement<List<Double>>(expected["roundPsi"]!!),
            json.decodeFromJsonElement<List<Double>>(input["psiProbes"]!!).map { Health.roundPsi(it) },
        )
        val wantSuggestions = json.decodeFromJsonElement<List<Health.ColdSuggestion?>>(expected["suggestions"]!!)
        (input["suggestProbes"]!!.jsonArray as JsonArray).forEachIndexed { i, probe ->
            val cells = probe.jsonArray
            assertEquals(
                wantSuggestions[i],
                Health.suggestCold(doubleOrNull(cells[0]), doubleOrNull(cells[1]), doubleOrNull(cells[2])),
                "suggestion $i",
            )
        }

        val wantMetric = json.decodeFromJsonElement<List<Health.Display>>(expected["displayMetric"]!!)
        val wantUs = json.decodeFromJsonElement<List<Health.Display>>(expected["displayUs"]!!)
        Health.HEALTH_DEFS.forEachIndexed { i, def ->
            assertEquals(wantMetric[i], Health.displayValue(def, 100.0, Health.Units.METRIC), "${def.key} metric")
            assertEquals(wantUs[i], Health.displayValue(def, 100.0, Health.Units.US), "${def.key} us")
        }
        val wantDeltaMetric = json.decodeFromJsonElement<List<Health.DisplayDelta>>(expected["deltaMetric"]!!)
        val wantDeltaUs = json.decodeFromJsonElement<List<Health.DisplayDelta>>(expected["deltaUs"]!!)
        val tyreC = Health.defFor("tyreCLF")!!
        val tyreKpa = Health.defFor("tyreKpaLF")!!
        assertEquals(wantDeltaMetric[0], Health.displayDelta(tyreC, 10.0, Health.Units.METRIC))
        assertEquals(wantDeltaMetric[1], Health.displayDelta(tyreKpa, 13.8, Health.Units.METRIC))
        assertEquals(wantDeltaUs[0], Health.displayDelta(tyreC, 10.0, Health.Units.US))
        assertEquals(wantDeltaUs[1], Health.displayDelta(tyreKpa, 13.8, Health.Units.US))

        assertEquals(
            expected["summaryMetric"]!!.jsonPrimitive.content,
            Health.healthSummary(fixtureChannels, Health.Units.METRIC),
        )
        assertEquals(
            expected["summaryUs"]!!.jsonPrimitive.content,
            Health.healthSummary(fixtureChannels, Health.Units.US),
        )
        assertEquals(
            expected["summaryFuelOnly"]!!.jsonPrimitive.content,
            Health.healthSummary(fuelChannels, Health.Units.METRIC),
        )
        assertEquals(
            expected["summaryOneLap"]!!.jsonPrimitive.content,
            Health.healthSummary(lastLapChannels, Health.Units.METRIC),
        )
        assertTrue(expected["summaryQuiet"] is kotlinx.serialization.json.JsonNull)
        assertTrue(expected["summaryNoData"] is kotlinx.serialization.json.JsonNull)
    }

    private fun doubleOrNull(element: kotlinx.serialization.json.JsonElement): Double? =
        if (element is kotlinx.serialization.json.JsonNull) null else element.jsonPrimitive.content.toDouble()
}
