package app.trackevolution.core.telemetry

import app.trackevolution.core.GeoTrace
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/**
 * `test/unit/csv.test.js`'s cases that the contract doesn't already pin, plus
 * the Kotlin-only seams (the name dispatch, the BOM `Blob.text()` strips).
 *
 * The JS builds its inputs with `buildTrackPrecisionCsv`; this suite starts from
 * the committed contract files instead and edits them, so it needs no second
 * copy of the fixture builder.
 */
class TrackPrecisionCsvTest {

    private val current = CsvFixtures.text("recording-2026-06-06-09-53-45.csv")
    private val name = "recording-2026-06-06-09-53-45.csv"

    @Test
    fun `is reached through parseTelemetryFile by its extension`() {
        val out = CsvFixtures.parse(name)
        assertEquals(ParsedTelemetry.Kind.TRACK_PRECISION, out.kind)
        assertEquals(3, out.lapChannels!!.laps.size)
        assertTrue(Telemetry.SUPPORTED_EXT.containsMatchIn("x.CSV"))
    }

    @Test
    fun `strips a byte-order mark, as Blob text() does`() {
        val out = TrackPrecisionCsv.parseTrackPrecisionCsv("﻿" + current, name)
        assertEquals(3, out.laps.size)
        assertTrue(out.carChannels["rpm"] != null, "the first header still maps")
    }

    @Test
    fun `reads the app's timer exactly`() {
        val out = TrackPrecisionCsv.parseTrackPrecisionCsv(current, name)
        for (lap in out.laps) {
            assertEquals(false, lap.estimated)
            assertEquals(47124.0, lap.timeMs.toDouble(), 1.0)
        }
    }

    @Test
    fun `skips a duplicated row`() {
        val lines = current.trimEnd().split("\n")
        val doubled = (listOf(lines[0]) + lines.drop(1).flatMap { listOf(it, it) }).joinToString("\n")
        val out = TrackPrecisionCsv.parseTrackPrecisionCsv(doubled, name)
        assertEquals(lines.size - 1, out.gps!!.size)
    }

    @Test
    fun `rejects a CSV that isn't Track Precision's`() {
        val e = assertThrows<TelemetryParseException> { TrackPrecisionCsv.parseTrackPrecisionCsv("a,b,c\n1,2,3\n", "x.csv") }
        assertTrue(e.message!!.contains("Track Precision"))
        val header = current.substringBefore("\n")
        val empty = assertThrows<TelemetryParseException> { TrackPrecisionCsv.parseTrackPrecisionCsv("$header\n", name) }
        assertTrue(empty.message!!.contains("no usable GPS"))
    }

    @Test
    fun `speedToMs falls back to km-h with nothing to go on`() {
        val gps = CsvFixtures.parse(name).gps!!
        val trace = GeoTrace.projectTrace(gps, gps[0])
        assertEquals(1 / 3.6, TrackPrecisionCsv.speedToMs(trace, gps.map { null }), 1e-12)
        assertEquals(1.0, TrackPrecisionCsv.speedToMs(trace, gps.map { 40.0 }), 1e-12)
        assertEquals(1 / 2.2369362920544, TrackPrecisionCsv.speedToMs(trace, gps.map { 89.477 }), 1e-12)
    }
}
