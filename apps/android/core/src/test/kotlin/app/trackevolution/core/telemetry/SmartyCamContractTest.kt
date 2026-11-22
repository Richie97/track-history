package app.trackevolution.core.telemetry

import app.trackevolution.core.RepoRoot
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.core.model.TraceGeo
import app.trackevolution.core.telemetry.VBOContractTest.Companion.assertSummary
import app.trackevolution.core.telemetry.VBOContractTest.Companion.assertTrace
import app.trackevolution.core.telemetry.VideoContractTest.Companion.assertChannels
import app.trackevolution.core.telemetry.VideoContractTest.Companion.assertClose
import app.trackevolution.core.telemetry.VideoContractTest.Companion.assertCloseOrBothNull
import app.trackevolution.core.telemetry.VideoContractTest.Companion.assertLaps
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.MethodSource

/**
 * The AiM SmartyCam parser against the web's, over the same bytes: the files in
 * `contracts/logic/smartycam/` and `contracts/logic/smartycam-parsers.json`,
 * both written by `npm run contracts:logic` from
 * `public/js/import/smartycam.js` (NS-55).
 *
 * A fixture of its own rather than rows in `video-parsers.json`, whose every
 * file [VideoContractTest] walks. Each file goes through
 * [Telemetry.parseTelemetryFile] under its own name, which is how the app
 * reaches the parser, so the dispatch is covered as well as the parse.
 *
 * Lap times are exact; lap windows, coordinates and every channel value are
 * held to 1e-9. Every time here except a lap's `timeMs` is *video* time.
 */
class SmartyCamContractTest {

    @ParameterizedTest
    @MethodSource("files")
    fun `matches the JavaScript parser`(case: SmartyCamFixtures.Case) {
        val file = case.file
        val parsed = SmartyCamFixtures.parse(file)
        val expected = case.expected

        assertEquals(expected.kind, parsed.kind.rawValue, "$file: kind")
        assertEquals(expected.date, parsed.date, "$file: date")
        assertEquals(expected.time, parsed.time, "$file: time")
        assertClose(expected.durationS, parsed.durationS, "$file: durationS")
        assertEquals(expected.needsLine, parsed.needsLine, "$file: needsLine")
        assertEquals(false, parsed.needsLine, "$file: a SmartyCam file never needs a line")
        assertEquals(expected.beaconCount, parsed.beaconCount, "$file: beaconCount")
        assertNull(parsed.lapRecovery, "$file: lapRecovery")
        assertNull(parsed.channels, "$file: channels")
        assertNull(parsed.sessionMeta, "$file: sessionMeta")
        assertTrue(parsed.lapScalarChannels.isEmpty(), "$file: no per-lap scalars")

        val metrics = given(parsed.metrics, "$file: metrics")
        val want = expected.metrics
        assertCloseOrBothNull(want.topSpeedKph, metrics.topSpeedKph, "$file: topSpeedKph")
        assertCloseOrBothNull(want.maxRpm, metrics.maxRpm, "$file: maxRpm")
        assertCloseOrBothNull(want.maxLatG, metrics.maxLatG, "$file: maxLatG")
        assertCloseOrBothNull(want.maxBrakeG, metrics.maxBrakeG, "$file: maxBrakeG")
        assertCloseOrBothNull(want.maxBoostKpa, metrics.maxBoostKpa, "$file: maxBoostKpa")
        assertCloseOrBothNull(want.maxOilC, metrics.maxOilC, "$file: maxOilC")

        val gps = given(parsed.gps, "$file: gps")
        assertEquals(expected.gpsCount, gps.size, "$file: gps count")
        assertTrue(expected.gpsSample.isNotEmpty(), "$file: the fixture samples the trace")
        for (point in expected.gpsSample) {
            val actual = gps[point.i]
            assertClose(point.t, actual.t, "$file: gps[${point.i}].t")
            assertClose(point.lat, actual.lat, "$file: gps[${point.i}].lat")
            assertClose(point.lon, actual.lon, "$file: gps[${point.i}].lon")
            assertCloseOrBothNull(point.v, actual.v, "$file: gps[${point.i}].v")
        }

        assertTrue(expected.laps.isNotEmpty(), "$file: the fixture holds laps")
        assertLaps(parsed.laps, expected.laps, file)
        assertTrace(parsed, expected.bestLapTrace, file, expected.traceGeo)

        // The name lists, not a hand-written field set: a channel the JS keeps
        // and the port forgets must fail here rather than go unlooked-at.
        for ((name, _) in TelemetryChannels.CHANNEL_NAMES) {
            assertSummary(parsed.carChannels[name], expected.carChannels[name], "$file: carChannels.$name")
        }
        assertTrue(
            TelemetryChannels.CHANNEL_NAMES.map { it.first }.containsAll(expected.carChannels.keys),
            "$file: every expected car channel is a CHANNEL_NAMES channel",
        )

        // Per-lap arrays element for element — CHANNEL_NAMES, SCALAR_NAMES and
        // META_NAMES are walked inside.
        assertChannels(parsed.lapChannels, expected.lapChannels, file)
    }

    @Test
    fun `the fixture is the two files the spec names`() {
        assertEquals(
            listOf("smartycam-laps.mov", "smartycam-midsession.mov"),
            SmartyCamFixtures.fixture.files.map { it.file },
        )
    }

    companion object {
        @JvmStatic
        fun files(): List<SmartyCamFixtures.Case> = SmartyCamFixtures.fixture.files
    }
}

/** `contracts/logic/smartycam/` and `contracts/logic/smartycam-parsers.json`, read from the repo. */
object SmartyCamFixtures {
    private val directory = RepoRoot.path("contracts/logic/smartycam")

    fun parse(file: String): ParsedTelemetry =
        Telemetry.parseTelemetryFile(ByteArraySource(directory.resolve(file).readBytes()), file)

    private val lenient = Json { ignoreUnknownKeys = true }

    val fixture: Fixture by lazy {
        lenient.decodeFromString(Fixture.serializer(), RepoRoot.path("contracts/logic/smartycam-parsers.json").readText())
    }

    @Serializable
    data class Fixture(val description: String, val gpsStride: Int, val files: List<Case>)

    @Serializable
    data class Case(val file: String, val note: String, val expected: Parsed) {
        override fun toString(): String = file
    }

    @Serializable
    data class Parsed(
        val kind: String,
        val date: String? = null,
        val time: String? = null,
        val durationS: Double,
        val needsLine: Boolean,
        val beaconCount: Int,
        val metrics: VideoFixtures.Metrics,
        val gpsCount: Int,
        val gpsSample: List<VideoFixtures.GpsSample>,
        val laps: List<VideoFixtures.Lap>,
        val lapChannels: SessionChannels? = null,
        /** `[x, y, v]` triples. */
        val bestLapTrace: List<List<Double>>? = null,
        /** Where [bestLapTrace] lies (NS-53). */
        val traceGeo: TraceGeo? = null,
        /** Each series summarized: count, ends, every 100th point. */
        val carChannels: Map<String, VBOFixtures.Summary> = emptyMap(),
    )
}
