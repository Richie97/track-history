package app.trackevolution.core.telemetry

import app.trackevolution.core.GeoTrace
import app.trackevolution.core.RepoRoot
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.core.telemetry.VideoContractTest.Companion.assertChannels
import app.trackevolution.core.telemetry.VideoContractTest.Companion.assertClose
import app.trackevolution.core.telemetry.VideoContractTest.Companion.assertCloseOrBothNull
import app.trackevolution.core.telemetry.VideoContractTest.Companion.assertGate
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
 * The `.vbo` parser against the web's, over the same bytes:
 * the files in `contracts/logic/vbo/` and `contracts/logic/vbo-parsers.json`, both
 * written by `npm run contracts:logic` from `public/js/import/vbo.js` — the
 * fixture the iOS Kit asserts against too, so the ports are checked against the
 * reference rather than each other.
 *
 * Every file goes through [Telemetry.parseTelemetryFile] with its own name,
 * which is how the app reaches the parser, so the name-based dispatch and the
 * text read are covered as well as the parse.
 */
class VBOContractTest {

    @ParameterizedTest
    @MethodSource("files")
    fun `matches the JavaScript parser`(case: VBOFixtures.Case) {
        val file = case.file
        val parsed = VBOFixtures.parse(file)
        val expected = case.expected

        assertEquals(expected.kind, parsed.kind.rawValue, "$file: kind")
        assertEquals(expected.date, parsed.date, "$file: date")
        assertEquals(expected.time, parsed.time, "$file: time")
        assertClose(expected.durationS, parsed.durationS, "$file: durationS")
        assertEquals(expected.needsLine, parsed.needsLine, "$file: needsLine")
        assertEquals(expected.beaconCount, parsed.beaconCount, "$file: beaconCount")
        assertNull(parsed.metrics, "$file: a VBO carries no metrics")
        assertNull(parsed.lapRecovery, "$file: lapRecovery")
        assertNull(parsed.channels, "$file: channels")

        val meta = expected.sessionMeta
        if (meta == null) {
            assertNull(parsed.sessionMeta, "$file: sessionMeta should be absent")
        } else {
            val actual = given(parsed.sessionMeta, "$file: sessionMeta")
            assertCloseOrBothNull(meta.ambientC, actual.ambientC, "$file: ambientC")
            assertCloseOrBothNull(meta.intakeC, actual.intakeC, "$file: intakeC")
            assertCloseOrBothNull(meta.elevationM, actual.elevationM, "$file: elevationM")
            assertCloseOrBothNull(meta.odometerKm, actual.odometerKm, "$file: odometerKm")
        }

        val gps = given(parsed.gps, "$file: gps")
        assertEquals(expected.gpsCount, gps.size, "$file: gps count")
        for (point in expected.gpsSample.orEmpty()) {
            val actual = gps[point.i]
            assertClose(point.t, actual.t, "$file: gps[${point.i}].t")
            assertClose(point.lat, actual.lat, "$file: gps[${point.i}].lat")
            assertClose(point.lon, actual.lon, "$file: gps[${point.i}].lon")
            assertCloseOrBothNull(point.v, actual.v, "$file: gps[${point.i}].v")
        }

        assertLaps(parsed.laps, expected.laps, file)
        assertTrace(parsed, expected.bestLapTrace, file)

        // The name lists, not a hand-written field set: a column the JS maps and
        // the port forgets must fail here rather than go unlooked-at.
        for ((name, _) in TelemetryChannels.CHANNEL_NAMES) {
            assertSummary(parsed.carChannels[name], expected.carChannels[name], "$file: carChannels.$name")
        }
        assertTrue(
            TelemetryChannels.CHANNEL_NAMES.map { it.first }.containsAll(expected.carChannels.keys),
            "$file: every expected car channel is a CHANNEL_NAMES channel",
        )
        for ((name, _, _) in TelemetryChannels.SCALAR_NAMES) {
            assertSummary(
                parsed.lapScalarChannels[name],
                expected.lapScalarChannels[name],
                "$file: lapScalarChannels.$name",
            )
        }

        assertChannels(parsed.lapChannels, expected.lapChannels, file)
    }

    @Test
    fun `line-picked laps match the JavaScript`() {
        val picked = VBOFixtures.fixture.files.filter { it.picked != null }
        assertTrue(picked.isNotEmpty(), "the fixture should include a line-picked file")
        for (case in picked) {
            val file = case.file
            val want = case.picked!!
            var parsed = VBOFixtures.parse(file)
            val gps = given(parsed.gps)
            // The review flow: project on the file's own first fix, build a gate
            // at the picked index, re-derive.
            val origin = gps[0]
            val gate = given(GeoTrace.buildGate(GeoTrace.projectTrace(gps, origin), want.pickedIndex))
            assertGate(gate, want.gate, file)

            parsed = Telemetry.applyGate(parsed, origin, gate)
            assertLaps(parsed.laps, want.laps, file)
            assertTrace(parsed, want.bestLapTrace, file)
            assertChannels(parsed.lapChannels, want.lapChannels, file)
        }
    }

    companion object {
        @JvmStatic
        fun files(): List<VBOFixtures.Case> = VBOFixtures.fixture.files

        internal fun assertTrace(parsed: ParsedTelemetry, expected: List<List<Double>>?, file: String) {
            if (expected == null) {
                assertNull(parsed.bestLapTrace, "$file: bestLapTrace should be absent")
                return
            }
            val actual = given(parsed.bestLapTrace, "$file: bestLapTrace")
            assertEquals(expected.size, actual.size, "$file: best-lap trace length")
            for ((a, b) in actual.zip(expected)) {
                assertClose(b[0], a.x, "$file: trace x")
                assertClose(b[1], a.y, "$file: trace y")
                assertClose(b[2], a.v, "$file: trace v")
            }
        }

        internal fun assertSummary(actual: List<ChannelPoint>?, expected: VBOFixtures.Summary?, label: String) {
            if (expected == null) {
                assertNull(actual, "$label: should be absent")
                return
            }
            val pts = given(actual, "$label: expected ${expected.count} points but got none")
            assertEquals(expected.count, pts.size, "$label: count")
            assertPoint(expected.first, pts.first(), "$label first")
            assertPoint(expected.last, pts.last(), "$label last")
            val sample = pts.filterIndexed { i, _ -> i % 100 == 0 }
            assertEquals(expected.sample.size, sample.size, "$label: sample size")
            sample.zip(expected.sample).forEachIndexed { i, (a, b) -> assertPoint(b, a, "$label sample[$i]") }
        }

        internal fun assertPoint(expected: VideoFixtures.Pt, actual: ChannelPoint, label: String) {
            assertClose(expected.t, actual.t, "$label t")
            assertClose(expected.v, actual.v, "$label v")
        }
    }
}

/** `contracts/logic/vbo/` and `contracts/logic/vbo-parsers.json`, read from the repo. */
object VBOFixtures {
    private val directory = RepoRoot.path("contracts/logic/vbo")

    fun bytes(file: String): ByteArray = directory.resolve(file).readBytes()

    fun text(file: String): String = directory.resolve(file).readText()

    fun parse(file: String): ParsedTelemetry = Telemetry.parseTelemetryFile(ByteArraySource(bytes(file)), file)

    private val lenient = Json { ignoreUnknownKeys = true }

    val fixture: Fixture by lazy {
        lenient.decodeFromString(Fixture.serializer(), RepoRoot.path("contracts/logic/vbo-parsers.json").readText())
    }

    @Serializable
    data class Fixture(val description: String, val files: List<Case>)

    @Serializable
    data class Case(val file: String, val note: String, val expected: Parsed, val picked: VideoFixtures.Picked? = null) {
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
        val sessionMeta: Meta? = null,
        val gpsCount: Int,
        val gpsSample: List<VideoFixtures.GpsSample>? = null,
        val laps: List<VideoFixtures.Lap>,
        val lapChannels: SessionChannels? = null,
        /** `[x, y, v]` triples. */
        val bestLapTrace: List<List<Double>>? = null,
        val carChannels: Map<String, Summary> = emptyMap(),
        val lapScalarChannels: Map<String, Summary> = emptyMap(),
    )

    @Serializable
    data class Meta(
        val ambientC: Double? = null,
        val intakeC: Double? = null,
        val elevationM: Double? = null,
        val odometerKm: Double? = null,
    )

    /** A car channel series as the fixture summarizes it: count, ends, every 100th point. */
    @Serializable
    data class Summary(
        val count: Int,
        val first: VideoFixtures.Pt,
        val last: VideoFixtures.Pt,
        val sample: List<VideoFixtures.Pt>,
    )
}
