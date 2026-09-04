package app.trackevolution.core.telemetry

import app.trackevolution.core.RepoRoot
import app.trackevolution.core.model.SessionChannels
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Access to `contracts/logic/video/` and `contracts/logic/video-parsers.json` —
 * the committed synthetic MP4s and what the JS parsers made of them.
 *
 * Read from the repo rather than copied under `src/test/resources`, for the
 * reason `Goldens` gives: a copy would go stale exactly when it mattered.
 * Regenerate both with `npm run contracts:logic`.
 */
object VideoFixtures {
    private val directory = RepoRoot.path("contracts/logic/video")

    /** The bytes of one fixture clip, as a parser sees them. */
    fun source(file: String): ByteArraySource = ByteArraySource(directory.resolve(file).readBytes())

    fun parse(file: String): ParsedTelemetry = Telemetry.parseTelemetryFile(source(file))

    // ---- The pinned JS output ------------------------------------------------

    private val lenient = Json { ignoreUnknownKeys = true }

    val fixture: Fixture by lazy {
        lenient.decodeFromString(Fixture.serializer(), RepoRoot.path("contracts/logic/video-parsers.json").readText())
    }

    fun expected(file: String): Case =
        fixture.files.firstOrNull { it.file == file }
            ?: error("no video fixture named $file — run `npm run contracts:logic`")

    @Serializable
    data class Fixture(
        val description: String,
        val gpsStride: Int,
        val files: List<Case>,
        val afterBatchAnchor: List<Anchored>,
    )

    @Serializable
    data class Case(val file: String, val note: String, val expected: Parsed, val picked: Picked? = null) {
        // Shown by JUnit as the parameterized case name.
        override fun toString(): String = file
    }

    @Serializable
    data class Anchored(val file: String, val expected: Parsed)

    @Serializable
    data class Parsed(
        val kind: String,
        val date: String? = null,
        val time: String? = null,
        val durationS: Double,
        val needsLine: Boolean,
        val beaconCount: Int,
        val metrics: Metrics? = null,
        val gpsCount: Int,
        val gpsSample: List<GpsSample>? = null,
        val laps: List<Lap>,
        val lapChannels: SessionChannels? = null,
        val lapRecovery: Recovery? = null,
        val channels: RawChannels? = null,
    )

    @Serializable
    data class Metrics(
        val topSpeedKph: Double? = null,
        val maxRpm: Double? = null,
        val maxLatG: Double? = null,
        val maxBrakeG: Double? = null,
        val maxBoostKpa: Double? = null,
        val maxOilC: Double? = null,
    )

    @Serializable
    data class GpsSample(val i: Int, val t: Double, val lat: Double, val lon: Double, val v: Double? = null)

    @Serializable
    data class Lap(
        val lapNumber: Int? = null,
        val timeMs: Int,
        val estimated: Boolean,
        val startT: Double? = null,
        val endT: Double? = null,
    )

    @Serializable
    data class Recovery(val lapM: Double, val r: Double, val anchored: Boolean, val phaseR: Double? = null, val lapCount: Int)

    @Serializable
    data class Pt(val t: Double, val v: Double)

    @Serializable
    data class RawChannels(val latCount: Int, val odoCount: Int, val odoFirst: Pt? = null, val odoLast: Pt? = null)

    @Serializable
    data class GateJson(
        val x: Double,
        val y: Double,
        val hx: Double? = null,
        val hy: Double? = null,
        val x1: Double,
        val y1: Double,
        val x2: Double,
        val y2: Double,
    )

    @Serializable
    data class Picked(
        val pickedIndex: Int,
        val gate: GateJson,
        val laps: List<Lap>,
        /** `[x, y, v]` triples. */
        val bestLapTrace: List<List<Double>>? = null,
        val lapChannels: SessionChannels? = null,
    )
}

/**
 * `#require` for JUnit: fail the test unless [value] is present, and hand it back
 * non-null. `Assertions.assertNotNull` returns void, which is why this exists.
 */
fun <T : Any> given(value: T?, label: String = "expected a value"): T =
    value ?: throw AssertionError(label)
