package app.trackevolution.core.telemetry

import app.trackevolution.core.GeoTrace
import app.trackevolution.core.JsMath
import app.trackevolution.core.ParsedRecording
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.Locale

/**
 * `test/unit/import-parse.test.js` and `import-ui.test.js`, over the committed
 * fixtures. The `.vbo` cases stay behind with the parser.
 */
class TelemetryTest {

    private val lapS = 2 * Math.PI * 300 / 40
    private val lapMs = JsMath.roundToInt(lapS * 1000) // 47124

    private lateinit var previousLocale: Locale

    @BeforeEach
    fun pinLocale() {
        // `toLocaleString()` grouping is locale-dependent in the JS too; the
        // expected strings are the en-US ones the web tests assert.
        previousLocale = Locale.getDefault()
        Locale.setDefault(Locale.US)
    }

    @AfterEach
    fun restoreLocale() {
        Locale.setDefault(previousLocale)
    }

    // ---- parseTelemetryFile dispatch ---------------------------------------------

    @Test
    fun `parses Corvette PDR MP4s with beacons and a GPS trace`() {
        val out = VideoFixtures.parse("pdr-beacons.mp4")
        assertEquals(ParsedTelemetry.Kind.PDR, out.kind)
        assertEquals(listOf(lapMs, lapMs), out.laps.map { it.timeMs })
        assertTrue(out.laps.all { !it.estimated })
        assertFalse(out.needsLine)
        assertEquals(3, out.beaconCount)
        // beacon laps are untouched by the GPS channels, which cut the best lap's trace
        assertTrue(given(out.gps).size > 100)
        assertTrue(given(out.bestLapTrace).size > 10)
    }

    @Test
    fun `falls through to GoPro GPMF for non-PDR MP4s`() {
        val out = VideoFixtures.parse("gopro.mp4")
        assertEquals(ParsedTelemetry.Kind.GOPRO, out.kind)
        assertTrue(out.needsLine)
        assertTrue(given(out.gps).size > 100)
    }

    @Test
    fun `reports a combined error for MP4s with neither telemetry flavour`() {
        val err = assertThrows(TelemetryParseException::class.java) {
            Telemetry.parseTelemetryFile(ByteArraySource(GPMFTest.emptyMp4()))
        }
        assertEquals("No PDR or GoPro telemetry in this video", err.message)
    }

    @Test
    fun `reports a garbage file as not an MP4`() {
        val err = assertThrows(TelemetryParseException::class.java) {
            Telemetry.parseTelemetryFile(ByteArraySource(ByteArray(64) { 0x01 }))
        }
        assertTrue(err.message.contains("MP4"), err.message)
    }

    @Test
    fun `beacon-timed laps cut a best-lap trace from the delta-decoded GPS`() {
        val out = VideoFixtures.parse("pdr-delta.mp4")
        assertEquals(ParsedTelemetry.Kind.PDR, out.kind)
        assertEquals(2, out.laps.size)
        assertFalse(out.needsLine)
        assertTrue(given(out.gps).size > 100)
        assertTrue(given(out.bestLapTrace).size > 10)
        assertTrue(given(out.metrics?.topSpeedKph) > 140)
    }

    @Test
    fun `sends a beacon-less recording to the line picker on its GPS trace`() {
        val out = VideoFixtures.parse("pdr-delta-nobeacon.mp4")
        assertEquals(ParsedTelemetry.Kind.PDR, out.kind)
        assertTrue(out.laps.isEmpty())
        assertTrue(out.needsLine) // GPS decoded -> picker, not lat+odo recovery
        assertNull(out.lapRecovery)
        assertTrue(given(out.gps).size > 100)
    }

    @Test
    fun `real-firmware beacon laps are untouched and no GPS trace decodes from one lon fix`() {
        val out = VideoFixtures.parse("pdr-real-beacons.mp4")
        assertEquals(ParsedTelemetry.Kind.PDR, out.kind)
        assertNull(out.gps)
        assertFalse(out.needsLine)
        assertNull(out.lapRecovery) // beacons already produced laps
        val exact = out.laps.filter { !it.estimated }
        assertTrue(exact.size >= 2)
        for (lap in exact) assertTrue(Math.abs(lap.timeMs - lapMs) < 50)
    }

    @Test
    fun `recovers laps from latitude plus odometer when there are no beacons`() {
        val out = VideoFixtures.parse("pdr-real-shifted.mp4")
        assertEquals(ParsedTelemetry.Kind.PDR, out.kind)
        assertNull(out.gps)
        assertFalse(out.needsLine) // no GPS -> the line picker can't help
        val recovery = given(out.lapRecovery)
        assertFalse(recovery.anchored)
        assertEquals(3, out.laps.size) // 3.3 revolutions
        for (lap in out.laps) {
            assertTrue(lap.estimated)
            assertTrue(Math.abs(lap.timeMs - lapMs) < 300)
        }
    }

    // ---- applyGate across longitude sign conventions ------------------------------

    @Test
    fun `applies one picked line to a trace with the opposite longitude sign`() {
        // A west-positive (Racelogic) trace of the same laps as the GoPro clip.
        val gps = given(VideoFixtures.parse("gopro.mp4").gps)
        val displayed = ParsedTelemetry(kind = ParsedTelemetry.Kind.GOPRO, needsLine = true, gps = gps)
        val mirrored = ParsedTelemetry(kind = ParsedTelemetry.Kind.GOPRO, needsLine = true, gps = gps.map { it.copy(lon = -it.lon) })

        val origin = gps[0]
        val gate = given(GeoTrace.buildGate(GeoTrace.projectTrace(gps, origin), JsMath.roundToInt(0.25 * lapS * 10)))

        val a = Telemetry.applyGate(displayed, origin, gate)
        val b = Telemetry.applyGate(mirrored, origin, gate)
        assertEquals(3, a.laps.size)
        assertEquals(3, b.laps.size) // mirrored automatically
        for (lap in a.laps + b.laps) assertTrue(Math.abs(lap.timeMs - lapMs) < 300)
    }

    @Test
    fun `leaves laps empty when a trace is genuinely elsewhere`() {
        val gps = given(VideoFixtures.parse("gopro.mp4").gps)
        val other = gps.map { it.copy(lat = it.lat + 3.44, lon = it.lon + 4.2) } // a different track
        val origin = gps[0]
        val gate = given(GeoTrace.buildGate(GeoTrace.projectTrace(gps, origin), 100))
        val out = Telemetry.applyGate(ParsedTelemetry(kind = ParsedTelemetry.Kind.GOPRO, needsLine = true, gps = other), origin, gate)
        assertTrue(out.laps.isEmpty())
        assertNull(out.bestLapTrace)
        assertNull(out.lapChannels)
    }

    @Test
    fun `times a beacon-less PDR file's laps from the picked line`() {
        var parsed = VideoFixtures.parse("pdr-nobeacon.mp4")
        val gps = given(parsed.gps)
        val origin = gps[0]
        val gate = given(GeoTrace.buildGate(GeoTrace.projectTrace(gps, origin), JsMath.roundToInt(0.25 * lapS * 10)))
        parsed = Telemetry.applyGate(parsed, origin, gate)
        assertEquals(3, parsed.laps.size)
        for (lap in parsed.laps) {
            assertTrue(lap.estimated)
            assertTrue(Math.abs(lap.timeMs - lapMs) < 300)
        }
        assertTrue(given(parsed.bestLapTrace).size > 10)
    }

    @Test
    fun `re-anchors a beacon-less PDR file to a batch-mate's start-finish`() {
        val withBeacons = VideoFixtures.parse("pdr-real-beacons.mp4")
        val noBeacons = VideoFixtures.parse("pdr-real-shifted.mp4")
        assertFalse(given(noBeacons.lapRecovery).anchored)

        val anchored = given(PDRLaps.anchorPdrBatch(listOf(withBeacons, noBeacons))[1])
        assertTrue(given(anchored.lapRecovery).anchored)
        // The start/finish (4.0 rad) is 3.0 rad past B's pit-out: 900m / 22.5s in.
        assertTrue(Math.abs(given(anchored.laps[0].startT) - 22.5) < 0.5)
        for (lap in anchored.laps) {
            assertTrue(lap.estimated)
            assertTrue(Math.abs(lap.timeMs - lapMs) < 300)
        }
    }

    @Test
    fun `leaves recovered laps alone when nothing in the batch can anchor them`() {
        val noBeacons = VideoFixtures.parse("pdr-real-shifted.mp4")
        val gopro = VideoFixtures.parse("gopro.mp4")
        val out = PDRLaps.anchorPdrBatch(listOf(gopro, noBeacons))
        assertEquals(noBeacons, out[1])
        assertFalse(given(out[1]?.lapRecovery).anchored)
    }

    @Test
    fun `clears derived laps when the gate is cleared`() {
        val gps = given(VideoFixtures.parse("gopro.mp4").gps)
        val parsed = ParsedTelemetry(
            kind = ParsedTelemetry.Kind.GOPRO,
            needsLine = true,
            gps = gps,
            laps = listOf(ParsedLap(timeMs = 1, estimated = true)),
        )
        assertTrue(Telemetry.applyGate(parsed, gps[0], null).laps.isEmpty())
    }

    @Test
    fun `leaves a source that needs no line untouched`() {
        val pdr = VideoFixtures.parse("pdr-beacons.mp4")
        val gps = given(pdr.gps)
        val gate = given(GeoTrace.buildGate(GeoTrace.projectTrace(gps, gps[0]), 100))
        assertEquals(pdr, Telemetry.applyGate(pdr, gps[0], gate))
    }

    // ---- metricsSummary and the notes line -----------------------------------------

    private fun withMetrics(top: Double?, rpm: Double?, g: Double?) = ParsedTelemetry(
        kind = ParsedTelemetry.Kind.PDR,
        metrics = ParsedTelemetry.Metrics(topSpeedKph = top, maxRpm = rpm, maxLatG = g),
    )

    @Test
    fun `formats the car channels and skips missing ones`() {
        assertEquals(
            "top speed 121 mph · max 6,703 rpm · 1.43 G lateral",
            Telemetry.metricsSummary(withMetrics(194.5, 6702.6, 1.432)),
        )
        assertEquals("top speed 93 mph", Telemetry.metricsSummary(withMetrics(150.1, null, null)))
    }

    @Test
    fun `is empty for sources without metrics`() {
        assertEquals("", Telemetry.metricsSummary(ParsedTelemetry(kind = ParsedTelemetry.Kind.GOPRO)))
        assertEquals("", Telemetry.metricsSummary(withMetrics(null, null, null)))
    }

    @Test
    fun `writes the web importer's notes line`() {
        val pdr = VideoFixtures.parse("pdr-real-shifted.mp4")
        assertEquals(
            "Imported from morning.mp4 — top speed 89 mph — laps recovered from latitude + odometer (~±0.2s); " +
                "boundaries are a fixed track point, not the official start/finish",
            Telemetry.importNotes(pdr, "morning.mp4"),
        )
        val live = ParsedRecording(
            kind = "live", date = "2026-06-20", time = "14:32", durationS = 600.0,
            laps = emptyList(), gps = emptyList(), needsLine = true,
        ).asTelemetry()
        assertEquals("Recorded with the in-app lap timer", Telemetry.importNotes(live, ""))
        assertEquals(
            "lap times derived from GPS start/finish crossings (~±0.2–0.5s)",
            Telemetry.estimatedNote(live, estCount = 3),
        )
        assertEquals("", Telemetry.estimatedNote(live, estCount = 0))
    }

    @Test
    fun `proposes a label from the file's clock, else its name`() {
        assertEquals("PDR 09:15:00", Telemetry.defaultLabel(VideoFixtures.parse("pdr-delta.mp4"), "clip.MP4"))
        assertEquals("PDR clip", Telemetry.defaultLabel(VideoFixtures.parse("pdr-real-shifted.mp4"), "clip.MP4"))
        assertEquals("GoPro 09:15:00", Telemetry.defaultLabel(VideoFixtures.parse("gopro.mp4"), "GX010042.MP4"))
    }
}
