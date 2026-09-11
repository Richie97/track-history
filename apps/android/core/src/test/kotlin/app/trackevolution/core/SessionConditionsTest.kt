package app.trackevolution.core

import app.trackevolution.core.model.ChannelMeta
import kotlin.math.abs
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The cases from `test/unit/conditions.test.js`, ported with the code they
 * cover, plus the cross-language pin against `contracts/logic/conditions.json`.
 */
class SessionConditionsTest {

    /** An event in four fields — the shape the rules actually need. */
    private data class Ev(
        override val ambientLoC: Double? = null,
        override val ambientHiC: Double? = null,
        override val elevationM: Double? = null,
        override val tempF: Int? = null,
    ) : SessionConditions.AmbientEvent

    private val cool = Ev(10.0, 10.0)
    private val hot = Ev(30.0, 30.0)

    private fun assertClose(expected: Double?, actual: Double?, what: String = "") {
        if (expected == null || actual == null) {
            assertEquals(expected, actual, what)
            return
        }
        assertTrue(abs(expected - actual) <= 1e-9, "$what: expected $expected, got $actual")
    }

    // ---- units -------------------------------------------------------------

    @Test
    fun `converts both ways`() {
        assertEquals(32.0, SessionConditions.cToF(0.0))
        assertEquals(212.0, SessionConditions.cToF(100.0))
        assertEquals(0.0, SessionConditions.fToC(32.0))
        assertEquals(22, SessionConditions.roundHalfUp(SessionConditions.fToC(72.0)))
    }

    @Test
    fun `words a temperature in either system`() {
        assertEquals("71 °F", SessionConditions.tempText(21.4, SessionConditions.Units.US))
        assertEquals("21 °C", SessionConditions.tempText(21.4))
    }

    /**
     * The port trap the fixture probes: JS rounds a tie *up*, so -12.5 °C is
     * -12 °C. Kotlin's own `round()` is half away from zero and would say -13.
     */
    @Test
    fun `rounds ties toward plus infinity like JavaScript`() {
        assertEquals("-12 °C", SessionConditions.tempText(-12.5))
        assertEquals("0 °C", SessionConditions.tempText(-0.5)) // and never "-0"
        assertEquals("22 °C", SessionConditions.tempText(21.5))
    }

    // ---- reading a session -------------------------------------------------

    @Test
    fun `prefers the column and falls back to the channel meta`() {
        assertEquals(18.5, SessionConditions.sessionAmbientC(18.5, ChannelMeta(ambientC = 99.0)))
        // A free account's channels are stripped and the column is not; a
        // response cached before migration 0020 is the other way round.
        assertEquals(24.0, SessionConditions.sessionAmbientC(null, ChannelMeta(ambientC = 24.0)))
        assertEquals(38.0, SessionConditions.sessionElevationM(null, ChannelMeta(elevationM = 38.0)))
    }

    @Test
    fun `has nothing for a hand-entered or recorded session`() {
        assertNull(SessionConditions.sessionAmbientC(null, null))
        assertNull(SessionConditions.sessionElevationM(null, ChannelMeta()))
        assertNull(SessionConditions.sessionAmbientC(null as app.trackevolution.core.model.Session?))
    }

    // ---- eventAmbient ------------------------------------------------------

    @Test
    fun `uses the recorded range when there is one`() {
        assertEquals(
            SessionConditions.Ambient(14.2, 31.8, SessionConditions.Source.RECORDED),
            SessionConditions.eventAmbient(Ev(14.2, 31.8, tempF = 61)),
        )
    }

    @Test
    fun `falls back to the typed fahrenheit`() {
        val a = SessionConditions.eventAmbient(Ev(tempF = 68))!!
        assertEquals(SessionConditions.Source.MANUAL, a.source)
        assertClose(20.0, a.loC)
        assertEquals(a.loC, a.hiC)
    }

    @Test
    fun `has nothing when neither exists`() {
        assertNull(SessionConditions.eventAmbient(Ev()))
        assertNull(SessionConditions.eventAmbient(null))
    }

    @Test
    fun `orders a reversed range rather than trusting the column order`() {
        val a = SessionConditions.eventAmbient(Ev(30.0, 12.0))!!
        assertEquals(12.0, a.loC)
        assertEquals(30.0, a.hiC)
    }

    // ---- words -------------------------------------------------------------

    @Test
    fun `says one figure or the day's range`() {
        val range = SessionConditions.Ambient(14.2, 31.8, SessionConditions.Source.RECORDED)
        val one = SessionConditions.Ambient(20.0, 20.0, SessionConditions.Source.RECORDED)
        assertEquals("68 °F", SessionConditions.ambientText(one, SessionConditions.Units.US))
        assertEquals("58–89 °F", SessionConditions.ambientText(range, SessionConditions.Units.US))
        assertEquals("14–32 °C", SessionConditions.ambientText(range))
        assertEquals("", SessionConditions.ambientText(null, SessionConditions.Units.US))
    }

    @Test
    fun `collapses a range that rounds to one number`() {
        // 21.4 and 21.8 °C are 70.5 and 71.2 °F: one number, not "71–71 °F".
        val a = SessionConditions.Ambient(21.4, 21.8, SessionConditions.Source.RECORDED)
        assertEquals("71 °F", SessionConditions.ambientText(a, SessionConditions.Units.US))
    }

    @Test
    fun `takes the largest elevation range and words it in one line`() {
        assertEquals(41.0, SessionConditions.trackElevationM(listOf(Ev(elevationM = 38.0), Ev(elevationM = 41.0), Ev())))
        assertNull(SessionConditions.trackElevationM(listOf(Ev(), Ev())))
        assertNull(SessionConditions.trackElevationM(emptyList()))
        assertEquals("135 ft of elevation change", SessionConditions.elevationText(41.0, SessionConditions.Units.US))
        assertEquals("41 m of elevation change", SessionConditions.elevationText(41.0))
        assertEquals("", SessionConditions.elevationText(null, SessionConditions.Units.US))
    }

    // ---- the band ----------------------------------------------------------

    @Test
    fun `normalizes over the events in view`() {
        val band = SessionConditions.conditionsBand(listOf(cool, Ev(20.0, 20.0), hot))!!
        assertEquals(10.0, band.loC)
        assertEquals(30.0, band.hiC)
        assertEquals(listOf(0.0, 0.5, 1.0), band.cells.map { it?.intensity })
        assertClose(SessionConditions.BAND_MIN_ALPHA, band.cells[0]?.alpha)
        assertClose(SessionConditions.BAND_MAX_ALPHA, band.cells[2]?.alpha)
    }

    @Test
    fun `shades by the midpoint of a day that warmed up`() {
        val band = SessionConditions.conditionsBand(listOf(cool, Ev(14.0, 26.0), hot))!!
        assertEquals(20.0, band.cells[1]?.c)
        assertEquals(0.5, band.cells[1]?.intensity)
    }

    @Test
    fun `draws nothing for an event with no reading`() {
        val band = SessionConditions.conditionsBand(listOf(cool, Ev(), hot))!!
        assertNull(band.cells[1])
        assertNotNull(band.cells[0])
    }

    @Test
    fun `counts a typed temperature too`() {
        // Most logbooks have no telemetry and must still get a band.
        val band = SessionConditions.conditionsBand(listOf(Ev(tempF = 50), Ev(tempF = 90)))!!
        assertTrue(band.cells.all { it != null })
    }

    @Test
    fun `refuses a spread too small to mean anything`() {
        val atLimit = Ev(10 + SessionConditions.BAND_MIN_SPAN_C, 10 + SessionConditions.BAND_MIN_SPAN_C)
        assertNull(SessionConditions.conditionsBand(listOf(cool, Ev(12.9, 12.9))))
        assertNotNull(SessionConditions.conditionsBand(listOf(cool, atLimit)))
    }

    @Test
    fun `refuses a single known event and an empty list`() {
        assertNull(SessionConditions.conditionsBand(listOf(cool, Ev(), Ev())))
        assertNull(SessionConditions.conditionsBand(emptyList()))
        assertNull(SessionConditions.conditionsBand(null))
    }

    @Test
    fun `clamps the wash to its range`() {
        assertEquals(SessionConditions.BAND_MIN_ALPHA, SessionConditions.bandAlpha(-1.0))
        assertEquals(SessionConditions.BAND_MAX_ALPHA, SessionConditions.bandAlpha(2.0))
    }

    @Test
    fun `speaks the shading for a screen reader`() {
        val band = SessionConditions.conditionsBand(listOf(cool, hot))
        assertEquals(
            "shaded by ambient temperature, 50 °F to 86 °F",
            SessionConditions.bandLabel(band, SessionConditions.Units.US),
        )
        assertEquals("", SessionConditions.bandLabel(null, SessionConditions.Units.US))
    }

    // ---- the cross-language fixture ----------------------------------------

    /**
     * The JS implementation's own output for a shared input has to come back out
     * of this port: the wording exactly, the doubles to 1e-9.
     */
    @Test
    fun `matches the JavaScript implementation on a shared fixture`() {
        val json = Json { ignoreUnknownKeys = false }
        val fixture = Json.parseToJsonElement(
            RepoRoot.path("contracts/logic/conditions.json").readText(),
        ).jsonObject
        val input = fixture["input"]!!.jsonObject
        val expected = fixture["expected"]!!.jsonObject

        fun events(key: String): List<Ev> =
            input[key]!!.jsonArray.map { row ->
                val o = row.jsonObject
                fun num(name: String) = o[name]?.jsonPrimitive?.contentOrNullDouble()
                Ev(
                    ambientLoC = num("ambient_lo_c"),
                    ambientHiC = num("ambient_hi_c"),
                    elevationM = num("elevation_m"),
                    tempF = num("temp_f")?.toInt(),
                )
            }

        // The constants themselves, so a port that quietly retunes one fails
        // here rather than by drawing a band nobody asked for.
        val constants = input["constants"]!!.jsonObject
        assertEquals(constants["BAND_MIN_EVENTS"]!!.jsonPrimitive.int(), SessionConditions.BAND_MIN_EVENTS)
        assertEquals(constants["BAND_MIN_SPAN_C"]!!.jsonPrimitive.double(), SessionConditions.BAND_MIN_SPAN_C)
        assertEquals(constants["BAND_MIN_ALPHA"]!!.jsonPrimitive.double(), SessionConditions.BAND_MIN_ALPHA)
        assertEquals(constants["BAND_MAX_ALPHA"]!!.jsonPrimitive.double(), SessionConditions.BAND_MAX_ALPHA)

        val convert = expected["convert"]!!.jsonObject
        val wantCToF = json.decodeFromJsonElement<List<Double>>(convert["cToF"]!!)
        assertClose(wantCToF[0], SessionConditions.cToF(0.0))
        assertClose(wantCToF[1], SessionConditions.cToF(21.4))
        assertClose(wantCToF[2], SessionConditions.cToF(-40.0))
        val wantFToC = json.decodeFromJsonElement<List<Double>>(convert["fToC"]!!)
        assertClose(wantFToC[0], SessionConditions.fToC(32.0))
        assertClose(wantFToC[1], SessionConditions.fToC(86.0))
        assertClose(wantFToC[2], SessionConditions.fToC(-40.0))
        val wantMToFt = json.decodeFromJsonElement<List<Double>>(convert["mToFt"]!!)
        assertClose(wantMToFt[0], SessionConditions.mToFt(41.4))
        assertClose(wantMToFt[1], SessionConditions.mToFt(1.0))

        // Sessions: the column, the blob fallback, and nothing at all.
        val sessions = input["sessions"]!!.jsonArray.map { it.jsonObject }
        val wantAmbient = json.decodeFromJsonElement<List<Double?>>(expected["sessionAmbientC"]!!)
        val wantElevation = json.decodeFromJsonElement<List<Double?>>(expected["sessionElevationM"]!!)
        sessions.forEachIndexed { i, o ->
            // `channels: null` is a JSON null, not an absent key — asking a
            // JsonNull for its object throws rather than answering null.
            val meta = (o["channels"] as? kotlinx.serialization.json.JsonObject)
                ?.get("meta")
                ?.let { json.decodeFromJsonElement<ChannelMeta>(it) }
            val ambientC = o["ambient_c"]?.jsonPrimitive?.contentOrNullDouble()
            val elevationM = o["elevation_m"]?.jsonPrimitive?.contentOrNullDouble()
            assertClose(wantAmbient[i], SessionConditions.sessionAmbientC(ambientC, meta), "session $i ambient")
            assertClose(wantElevation[i], SessionConditions.sessionElevationM(elevationM, meta), "session $i elevation")
        }

        val fixtureEvents = events("events")
        val wantEventAmbient = expected["eventAmbient"]!!.jsonArray
        val wantMids = json.decodeFromJsonElement<List<Double?>>(expected["ambientMidC"]!!)
        fixtureEvents.forEachIndexed { i, event ->
            val got = SessionConditions.eventAmbient(event)
            val want = wantEventAmbient[i]
            if (want.jsonPrimitiveOrNull() != null) {
                assertNull(got, "event $i")
            } else {
                val o = want.jsonObject
                assertEquals(o["source"]!!.jsonPrimitive.content.uppercase(), got!!.source.name, "event $i source")
                assertClose(o["loC"]!!.jsonPrimitive.double(), got.loC, "event $i lo")
                assertClose(o["hiC"]!!.jsonPrimitive.double(), got.hiC, "event $i hi")
            }
            assertClose(wantMids[i], SessionConditions.ambientMidC(got), "event $i midpoint")
        }
        val reversed = expected["reversedRange"]!!.jsonObject
        val gotReversed = SessionConditions.eventAmbient(Ev(30.0, 12.0))!!
        assertClose(reversed["loC"]!!.jsonPrimitive.double(), gotReversed.loC)
        assertClose(reversed["hiC"]!!.jsonPrimitive.double(), gotReversed.hiC)

        val wantElev = json.decodeFromJsonElement<List<Double?>>(expected["trackElevationM"]!!)
        assertClose(wantElev[0], SessionConditions.trackElevationM(fixtureEvents))
        assertNull(SessionConditions.trackElevationM(emptyList()))

        val tempProbes = json.decodeFromJsonElement<List<Double>>(input["tempProbes"]!!)
        assertEquals(
            json.decodeFromJsonElement<List<String>>(expected["tempTextMetric"]!!),
            tempProbes.map { SessionConditions.tempText(it, SessionConditions.Units.METRIC) },
        )
        assertEquals(
            json.decodeFromJsonElement<List<String>>(expected["tempTextUs"]!!),
            tempProbes.map { SessionConditions.tempText(it, SessionConditions.Units.US) },
        )
        val elevProbes = json.decodeFromJsonElement<List<Double>>(input["elevProbes"]!!)
        assertEquals(
            json.decodeFromJsonElement<List<String>>(expected["elevationTextMetric"]!!),
            elevProbes.map { SessionConditions.elevationText(it, SessionConditions.Units.METRIC) },
        )
        assertEquals(
            json.decodeFromJsonElement<List<String>>(expected["elevationTextUs"]!!),
            elevProbes.map { SessionConditions.elevationText(it, SessionConditions.Units.US) },
        )
        assertEquals(
            expected["noElevationText"]!!.jsonPrimitive.content,
            SessionConditions.elevationText(null, SessionConditions.Units.US),
        )

        val wantText = json.decodeFromJsonElement<List<String>>(expected["ambientText"]!!)
        val warmDay = SessionConditions.eventAmbient(fixtureEvents[1])
        assertEquals(wantText[0], SessionConditions.ambientText(warmDay, SessionConditions.Units.US))
        assertEquals(wantText[1], SessionConditions.ambientText(warmDay, SessionConditions.Units.METRIC))
        assertEquals(
            wantText[2],
            SessionConditions.ambientText(SessionConditions.eventAmbient(fixtureEvents[2]), SessionConditions.Units.US),
        )
        assertEquals(wantText[3], SessionConditions.ambientText(null, SessionConditions.Units.US))
        assertEquals(
            wantText[4],
            SessionConditions.ambientText(
                SessionConditions.Ambient(21.4, 21.8, SessionConditions.Source.RECORDED),
                SessionConditions.Units.US,
            ),
        )

        val band = SessionConditions.conditionsBand(fixtureEvents)!!
        val wantBand = expected["band"]!!.jsonObject
        assertClose(wantBand["loC"]!!.jsonPrimitive.double(), band.loC)
        assertClose(wantBand["hiC"]!!.jsonPrimitive.double(), band.hiC)
        val wantCells = wantBand["cells"]!!.jsonArray
        assertEquals(wantCells.size, band.cells.size)
        band.cells.forEachIndexed { i, cell ->
            val want = wantCells[i]
            if (want.jsonPrimitiveOrNull() != null) {
                assertNull(cell, "cell $i")
            } else {
                val o = want.jsonObject
                assertClose(o["c"]!!.jsonPrimitive.double(), cell!!.c, "cell $i midpoint")
                assertClose(o["intensity"]!!.jsonPrimitive.double(), cell.intensity, "cell $i intensity")
                assertClose(o["alpha"]!!.jsonPrimitive.double(), cell.alpha, "cell $i alpha")
            }
        }
        // Inclusive at the limit, nothing under it, nothing on one event.
        assertNotNull(SessionConditions.conditionsBand(events("spanAtLimit")))
        assertNotNull(expected["bandAtLimit"]!!.jsonObject)
        assertNull(SessionConditions.conditionsBand(events("spanUnder")))
        assertNotNull(expected["bandUnder"]!!.jsonPrimitiveOrNull())
        assertNull(SessionConditions.conditionsBand(events("oneKnown")))
        assertNotNull(expected["bandOneKnown"]!!.jsonPrimitiveOrNull())
        assertNotNull(expected["bandEmpty"]!!.jsonPrimitiveOrNull())

        val alphaProbes = json.decodeFromJsonElement<List<Double>>(input["alphaProbes"]!!)
        val wantAlpha = json.decodeFromJsonElement<List<Double>>(expected["bandAlpha"]!!)
        alphaProbes.forEachIndexed { i, probe ->
            assertClose(wantAlpha[i], SessionConditions.bandAlpha(probe), "alpha probe $probe")
        }
        val wantLabels = json.decodeFromJsonElement<List<String>>(expected["bandLabel"]!!)
        assertEquals(wantLabels[0], SessionConditions.bandLabel(band, SessionConditions.Units.US))
        assertEquals(wantLabels[1], SessionConditions.bandLabel(band, SessionConditions.Units.METRIC))
        assertEquals(wantLabels[2], SessionConditions.bandLabel(null, SessionConditions.Units.US))
    }
}

/** `null` in the fixture decodes as a JSON null primitive, not as an object. */
private fun kotlinx.serialization.json.JsonElement.jsonPrimitiveOrNull():
    kotlinx.serialization.json.JsonPrimitive? =
    (this as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.content == "null" }

private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullDouble(): Double? =
    if (content == "null") null else content.toDouble()

private fun kotlinx.serialization.json.JsonPrimitive.double(): Double = content.toDouble()

private fun kotlinx.serialization.json.JsonPrimitive.int(): Int = content.toInt()
