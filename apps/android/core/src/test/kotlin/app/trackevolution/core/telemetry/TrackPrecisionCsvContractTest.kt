package app.trackevolution.core.telemetry

import app.trackevolution.core.GeoTrace
import app.trackevolution.core.RepoRoot
import app.trackevolution.core.telemetry.VBOContractTest.Companion.assertSummary
import app.trackevolution.core.telemetry.VBOContractTest.Companion.assertTrace
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
 * The Track Precision CSV parser against the web's, over the same bytes: the
 * files in `contracts/logic/csv/` and `contracts/logic/csv-parsers.json`, both
 * written by `npm run contracts:logic` from `public/js/import/csv.js` — the
 * fixture the iOS Kit asserts against too, so the ports are checked against the
 * reference rather than each other.
 *
 * Every file goes through [Telemetry.parseTelemetryFile] with its own name, so
 * the `.csv` dispatch and the text read are covered as well as the parse; and
 * [TrackPrecisionCsv.lapsFromLaptime] is checked on its own over the fixture's
 * timer tables, whose pit stop, short last lap and pit-lane finish the
 * committed files are too regular to reach.
 */
class TrackPrecisionCsvContractTest {

    @ParameterizedTest
    @MethodSource("files")
    fun `matches the JavaScript parser`(case: CsvFixtures.Case) {
        val file = case.file
        val parsed = CsvFixtures.parse(file)
        val expected = case.expected

        assertEquals(expected.kind, parsed.kind.rawValue, "$file: kind")
        assertEquals(expected.date, parsed.date, "$file: date")
        assertEquals(expected.time, parsed.time, "$file: time")
        assertClose(expected.durationS, parsed.durationS, "$file: durationS")
        assertEquals(expected.needsLine, parsed.needsLine, "$file: needsLine")
        assertNull(parsed.metrics, "$file: a CSV carries no metrics")
        assertNull(parsed.sessionMeta, "$file: a CSV carries no session meta")

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
        val picked = CsvFixtures.fixture.files.filter { it.picked != null }
        assertTrue(picked.isNotEmpty(), "the fixture should include a line-picked file")
        for (case in picked) {
            val file = case.file
            val want = case.picked!!
            var parsed = CsvFixtures.parse(file)
            val gps = given(parsed.gps)
            val origin = gps[0]
            val gate = given(GeoTrace.buildGate(GeoTrace.projectTrace(gps, origin), want.pickedIndex))
            assertGate(gate, want.gate, file)

            parsed = Telemetry.applyGate(parsed, origin, gate)
            assertLaps(parsed.laps, want.laps, file)
            assertTrace(parsed, want.bestLapTrace, file)
            assertChannels(parsed.lapChannels, want.lapChannels, file)
        }
    }

    @ParameterizedTest
    @MethodSource("timers")
    fun `lapsFromLaptime matches the JavaScript`(case: CsvFixtures.TimerCase) {
        val rows = case.rows.map { TrackPrecisionCsv.TimerRow(t = it.t, lapMs = it.lapMs, lapM = it.lapM, v = it.v) }
        assertLaps(TrackPrecisionCsv.lapsFromLaptime(rows), case.laps, case.name)
    }

    companion object {
        @JvmStatic
        fun files(): List<CsvFixtures.Case> = CsvFixtures.fixture.files

        @JvmStatic
        fun timers(): List<CsvFixtures.TimerCase> = CsvFixtures.fixture.lapsFromLaptime
    }
}

/** `contracts/logic/csv/` and `contracts/logic/csv-parsers.json`, read from the repo. */
object CsvFixtures {
    private val directory = RepoRoot.path("contracts/logic/csv")

    fun bytes(file: String): ByteArray = directory.resolve(file).readBytes()

    fun text(file: String): String = directory.resolve(file).readText()

    fun parse(file: String): ParsedTelemetry = Telemetry.parseTelemetryFile(ByteArraySource(bytes(file)), file)

    private val lenient = Json { ignoreUnknownKeys = true }

    val fixture: Fixture by lazy {
        lenient.decodeFromString(Fixture.serializer(), RepoRoot.path("contracts/logic/csv-parsers.json").readText())
    }

    @Serializable
    data class Fixture(val description: String, val files: List<Case>, val lapsFromLaptime: List<TimerCase>)

    @Serializable
    data class Case(
        val file: String,
        val note: String,
        val expected: VBOFixtures.Parsed,
        val picked: VideoFixtures.Picked? = null,
    ) {
        override fun toString(): String = file
    }

    @Serializable
    data class TimerRow(val t: Double, val lapMs: Double? = null, val lapM: Double? = null, val v: Double? = null)

    @Serializable
    data class TimerCase(val name: String, val rows: List<TimerRow>, val laps: List<VideoFixtures.Lap>) {
        override fun toString(): String = name
    }
}
