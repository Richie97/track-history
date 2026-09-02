package app.trackevolution.core.telemetry

import app.trackevolution.core.Gate
import app.trackevolution.core.GeoTrace
import app.trackevolution.core.model.SessionChannels
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource

/**
 * The whole point of the video fixtures: parse the *same bytes* the JS parsed
 * and prove the two agree — the same `contracts/logic/video-parsers.json` the
 * iOS Kit's `VideoContractTests` asserts against, so the ports are checked
 * against the web implementation rather than against each other.
 *
 * Lap times are compared exactly — they are integer milliseconds, and "close
 * enough" is precisely the failure mode a reverse-engineered decoder produces.
 * Coordinates and channel values get a tolerance far below their own rounding
 * (channels are stored rounded to 0.1 km/h, 1 rpm, 0.001 G), because two
 * languages' `hypot` and transcendental functions may differ in the last bit and
 * nothing user-visible depends on that bit.
 */
class VideoContractTest {

    @ParameterizedTest
    @ValueSource(
        strings = [
            "gopro.mp4",
            "pdr-beacons.mp4",
            "pdr-delta.mp4",
            "pdr-delta-nobeacon.mp4",
            "pdr-nobeacon.mp4",
            "pdr-real-beacons.mp4",
            "pdr-real-shifted.mp4",
        ],
    )
    fun `matches the JavaScript parsers`(file: String) {
        val parsed = VideoFixtures.parse(file)
        assertMatches(parsed, VideoFixtures.expected(file).expected, file)
    }

    @ParameterizedTest
    @ValueSource(strings = ["gopro.mp4", "pdr-delta-nobeacon.mp4", "pdr-nobeacon.mp4"])
    fun `line-picked laps match the JavaScript`(file: String) {
        var parsed = VideoFixtures.parse(file)
        val picked = given(VideoFixtures.expected(file).picked)
        val gps = given(parsed.gps)

        // The same flow the review screen runs: project on the file's own first
        // fix, build a gate at the picked index, re-derive.
        val origin = gps[0]
        val trace = GeoTrace.projectTrace(gps, origin)
        val gate = given(GeoTrace.buildGate(trace, picked.pickedIndex))
        assertGate(gate, picked.gate, file)

        parsed = Telemetry.applyGate(parsed, origin, gate)
        assertLaps(parsed.laps, picked.laps, file)
        assertChannels(parsed.lapChannels, picked.lapChannels, file)

        val expectedTrace = given(picked.bestLapTrace)
        val actualTrace = given(parsed.bestLapTrace)
        assertEquals(expectedTrace.size, actualTrace.size, "$file: best-lap trace length")
        for ((a, b) in actualTrace.zip(expectedTrace)) {
            assertClose(b[0], a.x, "$file: trace x")
            assertClose(b[1], a.y, "$file: trace y")
            assertClose(b[2], a.v, "$file: trace v")
        }
    }

    /**
     * The batch pass: a beacon-timed recording of the same track pulls a
     * beacon-less one's rolling laps onto the real start/finish. Both files are
     * parsed first, exactly as an import of a multi-file selection does.
     */
    @Test
    fun `batch anchoring matches the JavaScript`() {
        val files = VideoFixtures.fixture.files
        var batch: List<ParsedTelemetry?> = files.map { VideoFixtures.parse(it.file) }
        batch = PDRLaps.anchorPdrBatch(batch)
        batch = batch.map { p ->
            if (p != null && p.kind == ParsedTelemetry.Kind.PDR && p.lapRecovery != null) {
                TelemetryChannels.attachLapChannels(p)
            } else {
                p
            }
        }

        val anchored = VideoFixtures.fixture.afterBatchAnchor
        assertTrue(anchored.isNotEmpty(), "the fixture should include at least one anchored recording")
        for (expected in anchored) {
            val index = files.indexOfFirst { it.file == expected.file }
            assertTrue(index >= 0, "${expected.file} is in the fixture")
            val parsed = given(batch[index])
            assertMatches(parsed, expected.expected, expected.file)
            assertEquals(true, parsed.lapRecovery?.anchored, "${expected.file}: anchored")
        }
    }

    // ---- Comparisons -----------------------------------------------------------

    private fun assertMatches(parsed: ParsedTelemetry, expected: VideoFixtures.Parsed, file: String) {
        assertEquals(expected.kind, parsed.kind.rawValue, "$file: kind")
        assertEquals(expected.date, parsed.date, "$file: date")
        assertEquals(expected.time, parsed.time, "$file: time")
        assertClose(expected.durationS, parsed.durationS, "$file: durationS")
        assertEquals(expected.needsLine, parsed.needsLine, "$file: needsLine")
        assertEquals(expected.beaconCount, parsed.beaconCount, "$file: beaconCount")

        assertLaps(parsed.laps, expected.laps, file)
        assertChannels(parsed.lapChannels, expected.lapChannels, file)

        val expectedMetrics = expected.metrics
        if (expectedMetrics != null) {
            val metrics = parsed.metrics
            assertCloseOrBothNull(expectedMetrics.topSpeedKph, metrics?.topSpeedKph, "$file: topSpeedKph")
            assertCloseOrBothNull(expectedMetrics.maxRpm, metrics?.maxRpm, "$file: maxRpm")
            assertCloseOrBothNull(expectedMetrics.maxLatG, metrics?.maxLatG, "$file: maxLatG")
        } else {
            assertNull(parsed.metrics, "$file: metrics should be absent")
        }

        assertEquals(expected.gpsCount, parsed.gps?.size ?: 0, "$file: gps count")
        val sample = expected.gpsSample
        val gps = parsed.gps
        if (sample != null && gps != null) {
            for (point in sample) {
                if (point.i !in gps.indices) continue
                val actual = gps[point.i]
                assertClose(point.t, actual.t, "$file: gps[${point.i}].t")
                assertClose(point.lat, actual.lat, "$file: gps[${point.i}].lat")
                assertClose(point.lon, actual.lon, "$file: gps[${point.i}].lon")
                assertCloseOrBothNull(point.v, actual.v, "$file: gps[${point.i}].v")
            }
        }

        val expectedRecovery = expected.lapRecovery
        if (expectedRecovery != null) {
            val recovery = given(parsed.lapRecovery, "$file: lapRecovery")
            assertClose(expectedRecovery.lapM, recovery.lapM, "$file: lapM")
            assertClose(expectedRecovery.r, recovery.r, "$file: recovery r")
            assertEquals(expectedRecovery.anchored, recovery.anchored, "$file: anchored")
            assertCloseOrBothNull(expectedRecovery.phaseR, recovery.phaseR, "$file: phaseR")
            assertEquals(expectedRecovery.lapCount, recovery.laps.size, "$file: recovered lap count")
        } else {
            assertNull(parsed.lapRecovery, "$file: lapRecovery should be absent")
        }

        val expectedChannels = expected.channels
        if (expectedChannels != null) {
            val channels = given(parsed.channels, "$file: channels")
            assertEquals(expectedChannels.latCount, channels.latPts.size, "$file: latPts count")
            assertEquals(expectedChannels.odoCount, channels.odoPts.size, "$file: odoPts count")
            assertEquals(expectedChannels.odoFirst?.let { ChannelPoint(it.t, it.v) }, channels.odoPts.firstOrNull(), "$file: odoPts first")
            assertEquals(expectedChannels.odoLast?.let { ChannelPoint(it.t, it.v) }, channels.odoPts.lastOrNull(), "$file: odoPts last")
        }
    }

    private fun assertLaps(laps: List<ParsedLap>, expected: List<VideoFixtures.Lap>, file: String) {
        assertEquals(expected.size, laps.size, "$file: lap count")
        laps.zip(expected).forEachIndexed { i, (actual, want) ->
            // Exact: a lap time is an integer number of milliseconds.
            assertEquals(want.timeMs, actual.timeMs, "$file: lap $i timeMs")
            assertEquals(want.estimated, actual.estimated, "$file: lap $i estimated")
            assertEquals(want.lapNumber, actual.lapNumber, "$file: lap $i lapNumber")
            assertCloseOrBothNull(want.startT, actual.startT, "$file: lap $i startT")
            assertCloseOrBothNull(want.endT, actual.endT, "$file: lap $i endT")
        }
    }

    private fun assertChannels(channels: SessionChannels?, expected: SessionChannels?, file: String) {
        if (expected == null) {
            assertNull(channels, "$file: lapChannels should be absent")
            return
        }
        given(channels, "$file: expected lapChannels but got none")
        channels!!
        assertEquals(expected.v, channels.v, "$file: channels version")
        assertEquals(expected.dStepM, channels.dStepM, "$file: dStepM")
        assertEquals(expected.laps.size, channels.laps.size, "$file: channel lap count")
        for ((lap, want) in channels.laps.zip(expected.laps)) {
            assertEquals(want.n, lap.n, "$file: channel lap ${want.n} number")
            assertEquals(want.timeMs, lap.timeMs, "$file: channel lap ${want.n} timeMs")
            assertSeries(lap.speed, want.speed, "$file: lap ${want.n} speed")
            assertSeries(lap.rpm, want.rpm, "$file: lap ${want.n} rpm")
            assertSeries(lap.latG, want.latG, "$file: lap ${want.n} latG")
            assertSeries(lap.throttle, want.throttle, "$file: lap ${want.n} throttle")
            assertSeries(lap.brake, want.brake, "$file: lap ${want.n} brake")
            assertSeries(lap.steering, want.steering, "$file: lap ${want.n} steering")
        }
    }

    private fun assertSeries(actual: List<Double>?, expected: List<Double>?, label: String) {
        if (expected == null) {
            assertNull(actual, "$label: should be absent")
            return
        }
        given(actual, "$label: expected ${expected.size} values but got none")
        actual!!
        assertEquals(expected.size, actual.size, "$label: length")
        actual.zip(expected).forEachIndexed { i, (a, b) -> assertClose(b, a, "$label[$i]") }
    }

    private fun assertGate(gate: Gate, expected: VideoFixtures.GateJson, file: String) {
        assertClose(expected.x, gate.x, "$file: gate x")
        assertClose(expected.y, gate.y, "$file: gate y")
        assertCloseOrBothNull(expected.hx, gate.hx, "$file: gate hx")
        assertCloseOrBothNull(expected.hy, gate.hy, "$file: gate hy")
        assertClose(expected.x1, gate.x1, "$file: gate x1")
        assertClose(expected.y1, gate.y1, "$file: gate y1")
        assertClose(expected.x2, gate.x2, "$file: gate x2")
        assertClose(expected.y2, gate.y2, "$file: gate y2")
    }

    companion object {
        /**
         * Below any difference either implementation could produce that meant
         * something, and far above float noise.
         */
        private const val EPSILON = 1e-9

        fun assertClose(expected: Double, actual: Double, label: String) {
            assertTrue(Math.abs(expected - actual) < EPSILON, "$label: expected $expected, got $actual")
        }

        fun assertCloseOrBothNull(expected: Double?, actual: Double?, label: String) {
            if (expected == null || actual == null) {
                assertEquals(expected, actual, label)
            } else {
                assertClose(expected, actual, label)
            }
        }
    }
}
