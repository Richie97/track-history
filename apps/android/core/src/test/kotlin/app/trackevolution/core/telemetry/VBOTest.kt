package app.trackevolution.core.telemetry

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/**
 * `test/unit/vbo.test.js`'s cases that the contract doesn't already pin, plus
 * the Kotlin-only seams (the name dispatch, `Number()`, the review strings).
 *
 * The JS builds its inputs with `buildVboText`; this suite starts from the
 * committed contract files instead and edits them, so it needs no second copy
 * of the fixture builder.
 */
class VBOTest {

    private val noLine = VBOFixtures.text("vbox-noline.vbo")
    private val withLine = VBOFixtures.text("vbox-laptiming.vbo")
    private val trackPrecision = VBOFixtures.text("trackprecision-2026-06-06-09-53-45.vbo")

    @Test
    fun `parses the created date, GPS points and duration`() {
        val out = VBO.parseVboText(noLine)
        assertEquals(ParsedTelemetry.Kind.VBO, out.kind)
        assertEquals("2026-06-20", out.date)
        assertEquals("09:15:00", out.time)
        assertEquals(dataRows(noLine).size, out.gps!!.size)
        // Racelogic's west-positive longitude comes back east-positive.
        assertTrue(out.gps!![0].lon < 0, "longitude is negated into east-positive degrees")
    }

    @Test
    fun `normalizes the km-h velocity column to m-s`() {
        // The fixture writes 40 m/s as 144 km/h under a "velocity kmh" header.
        val out = VBO.parseVboText(noLine)
        assertEquals(40.0, out.gps!![10].v!!, 1e-9)
    }

    @Test
    fun `reads mph and knots velocity headers`() {
        val mph = VBO.parseVboText(noLine.replace("velocity kmh", "velocity mph"))
        assertEquals(144 * 0.44704, mph.gps!![10].v!!, 1e-9)
        val kts = VBO.parseVboText(noLine.replace("velocity kmh", "velocity knots"))
        assertEquals(144 * 0.514444, kts.gps!![10].v!!, 1e-9)
    }

    @Test
    fun `takes the gate direction from the trace, so a clockwise session times too`() {
        // The same circle driven the other way: coordinates reversed, clock kept.
        val rows = dataRows(withLine).map { it.split(Regex("\\s+")) }
        val reversed = rows.indices.map { i ->
            val coords = rows[rows.size - 1 - i]
            listOf(rows[i][0], rows[i][1], coords[2], coords[3], coords[4]).joinToString(" ")
        }
        val head = withLine.substringBefore("[data]")
        val out = VBO.parseVboText(head + "[data]\n" + reversed.joinToString("\n") + "\n")
        assertEquals(3, out.laps.size)
        assertFalse(out.needsLine)
    }

    @Test
    fun `falls back to the export date when the name has none`() {
        assertEquals("2026-09-22", VBO.parseVboText(trackPrecision, "session.vbo").date)
        // …and the name wins when it has one, the export line being no recording's date.
        assertEquals("2026-06-06", VBO.parseVboText(trackPrecision, "recording-2026-06-06-14-59-38.vbo").date)
        // No "created on" line: the time is the first sample's time of day.
        assertEquals("09:15:00", VBO.parseVboText(trackPrecision, "session.vbo").time)
    }

    @Test
    fun `parses the Porsche Track Precision layout and its car channels`() {
        val out = VBO.parseVboText(trackPrecision, "recording-2026-06-06-09-53-45.vbo")
        val ch = out.carChannels
        val present = TelemetryChannels.CHANNEL_NAMES.map { it.first }.filter { ch[it] != null }.sorted()
        assertEquals(listOf("brake", "gear", "latG", "rpm", "steering", "throttle"), present)
        // the pedal fraction becomes a percentage
        assertEquals(100.0, ch.throttle!!.maxOf { it.v }, 0.5)
        // brake pressure becomes a percentage of the file's peak
        assertEquals(100.0, ch.brake!!.maxOf { it.v }, 1e-5)
        assertEquals(0.0, ch.brake!!.minOf { it.v })
        // true G (LatAcc_PTPA) over the /9.81 `latacc` column, as a magnitude
        assertEquals(0.9, ch.latG!!.maxOf { it.v }, 0.005)
        assertEquals(setOf(3.0, 4.0), ch.gear!!.map { it.v }.toSet())
        // bar -> kPa; the 3276.8 "no reading" sentinel is dropped
        assertEquals(210.0, out.lapScalarChannels["tyreKpaLF"]!![0].v, 1e-5)
        assertNull(out.lapScalarChannels["tyreKpaRF"])
        // the all-zero yaw column is no channel at all
        assertNull(ch.yaw)
    }

    @Test
    fun `asks for a line when there is no laptiming section`() {
        val out = VBO.parseVboText(noLine)
        assertTrue(out.needsLine)
        assertEquals(emptyList<ParsedLap>(), out.laps)
    }

    @Test
    fun `rejects files without the expected structure`() {
        val noColumns = assertThrows<TelemetryParseException> { VBO.parseVboText("not a vbo") }
        assertTrue(noColumns.message.contains("column names"), noColumns.message)
        val noGps = assertThrows<TelemetryParseException> {
            VBO.parseVboText("[column names]\nsats time lat long\n[data]\n008 091500.00 2193.6 4752.0")
        }
        assertTrue(noGps.message.contains("no usable GPS"), noGps.message)
        val missing = assertThrows<TelemetryParseException> {
            VBO.parseVboText("[column names]\nsats time lat\n[data]\n008 091500.00 2193.6")
        }
        assertTrue(missing.message.contains("time/lat/long"), missing.message)
    }

    @Test
    fun `computes an elevation range from a height column`() {
        val rows = dataRows(noLine).mapIndexed { i, row -> "$row ${100 + (i % 40)}" }
        val head = noLine.substringBefore("[data]").replace("sats time lat long velocity", "sats time lat long velocity height")
        val out = VBO.parseVboText(head + "[data]\n" + rows.joinToString("\n"))
        assertEquals(39.0, out.sessionMeta!!.elevationM!!, 1e-9)
    }

    // ---- Kotlin-only seams ----------------------------------------------------

    @Test
    fun `dispatches by file name, not by content`() {
        val bytes = VBOFixtures.bytes("vbox-laptiming.vbo")
        val out = Telemetry.parseTelemetryFile(ByteArraySource(bytes), "SESSION.VBO")
        assertEquals(ParsedTelemetry.Kind.VBO, out.kind)
        // attachLapChannels ran: the laps carry channel arrays.
        assertEquals(3, out.lapChannels!!.laps.size)
        // Without the name it is treated as video and refused as one.
        assertThrows<TelemetryParseException> { Telemetry.parseTelemetryFile(ByteArraySource(bytes)) }
    }

    @Test
    fun `Number() semantics`() {
        assertEquals(3.5, VBO.number("+003.5"))
        assertEquals(-0.0, VBO.number("-0"))
        assertEquals(0.0, VBO.number(""))
        assertEquals(26.0, VBO.number("0x1A"))
        assertEquals(5.0, VBO.number("5."))
        assertEquals(0.5, VBO.number(".5"))
        assertEquals(1500.0, VBO.number("1.5e3"))
        assertEquals(Double.NEGATIVE_INFINITY, VBO.number("-Infinity"))
        for (bad in listOf("1f", "1d", "NaN", "0x1p3", "1,5", "-0x10", "abc", ".")) {
            assertTrue(VBO.number(bad).isNaN(), "Number(\"$bad\") is NaN")
        }
    }

    @Test
    fun `reads the review strings the web writes for a vbo`() {
        val out = VBOFixtures.parse("vbox-laptiming.vbo")
        assertEquals("VBO 09:15:00", Telemetry.defaultLabel(out, "vbox-laptiming.vbo"))
        assertEquals(
            "Imported from vbox-laptiming.vbo — lap times derived from GPS start/finish crossings (~±0.1–0.3s)",
            Telemetry.importNotes(out, "vbox-laptiming.vbo"),
        )
    }

    private fun dataRows(text: String): List<String> =
        text.substringAfter("[data]").lines().map { it.trim() }.filter { it.isNotEmpty() }
}
