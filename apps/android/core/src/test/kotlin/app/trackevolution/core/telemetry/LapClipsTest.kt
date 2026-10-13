package app.trackevolution.core.telemetry

import app.trackevolution.core.RepoRoot
import app.trackevolution.core.model.ClipStorage
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.telemetry.LapClips.ClipOffer
import app.trackevolution.core.telemetry.LapClips.MAX_CLIP_S
import app.trackevolution.core.telemetry.LapClips.OfferItem
import app.trackevolution.core.telemetry.LapClips.POST_ROLL_S
import app.trackevolution.core.telemetry.LapClips.PRE_ROLL_S
import app.trackevolution.core.telemetry.LapClips.clipCandidate
import app.trackevolution.core.telemetry.LapClips.clipFullText
import app.trackevolution.core.telemetry.LapClips.clipOffer
import app.trackevolution.core.telemetry.LapClips.clipOfferNote
import app.trackevolution.core.telemetry.LapClips.clipOfferText
import app.trackevolution.core.telemetry.LapClips.clipStorageLine
import app.trackevolution.core.telemetry.LapClips.clipWindow
import app.trackevolution.core.telemetry.LapClips.estimateClipBytes
import app.trackevolution.core.telemetry.LapClips.fmtClipBytes
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * The best-lap clip rule (NS-45) against `contracts/logic/lap-clips.json` —
 * `public/js/import/clip.js` run over the committed video fixtures and the
 * synthetic rows chosen for the ways a port goes wrong — plus the JS unit
 * tests from `test/unit/clip.test.js`, ported case for case.
 */
class LapClipsTest {

    private val fixture = Json.parseToJsonElement(RepoRoot.path("contracts/logic/lap-clips.json").readText()).jsonObject

    private val strict = Json { ignoreUnknownKeys = false }

    private fun kind(raw: String) = ParsedTelemetry.Kind.entries.first { it.rawValue == raw }

    private fun JsonElement?.dbl(): Double? = if (this == null || this is JsonNull) null else jsonPrimitive.doubleOrNull

    private fun parsedOf(input: JsonObject) = ParsedTelemetry(
        kind = kind(input["kind"]!!.jsonPrimitive.content),
        durationS = input["durationS"]!!.jsonPrimitive.content.toDouble(),
        laps = input["laps"]!!.jsonArray.map { l ->
            val o = l.jsonObject
            ParsedLap(
                timeMs = o["timeMs"]!!.jsonPrimitive.content.toInt(),
                estimated = o["estimated"]!!.jsonPrimitive.content.toBooleanStrict(),
                startT = o["startT"].dbl(),
                endT = o["endT"].dbl(),
            )
        },
    )

    private fun assertWindow(expected: JsonElement?, actual: LapClips.ClipWindow?, what: String) {
        if (expected == null || expected is JsonNull) {
            assertNull(actual, what)
            return
        }
        val e = expected.jsonObject
        assertNotNull(actual, what)
        for ((key, value) in listOf("startS" to actual!!.startS, "endS" to actual.endS, "lapOffsetS" to actual.lapOffsetS)) {
            assertTrue(abs(e[key].dbl()!! - value) < 1e-9, "$what: $key ${e[key]} vs $value")
        }
    }

    private fun clipsOf(raw: JsonElement?): ClipStorage? =
        if (raw == null || raw is JsonNull) null else strict.decodeFromJsonElement(ClipStorage.serializer(), raw)

    // ---- Cross-language agreement ------------------------------------------

    @Test
    fun `constants match the reference`() {
        assertEquals(fixture["PRE_ROLL_S"]!!.jsonPrimitive.content.toDouble(), PRE_ROLL_S)
        assertEquals(fixture["POST_ROLL_S"]!!.jsonPrimitive.content.toDouble(), POST_ROLL_S)
        assertEquals(fixture["MAX_CLIP_S"]!!.jsonPrimitive.content.toDouble(), MAX_CLIP_S)
        assertEquals(fixture["VIDEO_KINDS"]!!.jsonArray.map { it.jsonPrimitive.content }, LapClips.VIDEO_KINDS)
    }

    @Test
    fun `candidate, window and estimate match every fixture case`() {
        val cases = fixture["cases"]!!.jsonArray
        assertTrue(cases.size >= 18, "the committed clips plus the synthetic rows")
        for (element in cases) {
            val case = element.jsonObject
            val input = case["input"]!!.jsonObject
            val name = input["name"]!!.jsonPrimitive.content
            val expected = case["expected"]!!.jsonObject
            val parsed = parsedOf(input)
            val fileBytes = input["fileBytes"]!!.jsonPrimitive.long

            val c = clipCandidate(parsed)
            val wantIndex = expected["candidateIndex"]!!.let { if (it is JsonNull) null else it.jsonPrimitive.content.toInt() }
            assertEquals(wantIndex, c?.index, "$name: candidateIndex")
            assertWindow(expected["window"], c?.let { clipWindow(it.lap, parsed.durationS) }, "$name: window")
            val wantBytes = expected["estimateBytes"]!!.let { if (it is JsonNull) null else it.jsonPrimitive.long }
            assertEquals(wantBytes, c?.let { estimateClipBytes(it.lap, fileBytes, parsed.durationS) }, "$name: estimateBytes")

            val windows = expected["windows"]!!.jsonArray
            assertEquals(parsed.laps.size, windows.size, "$name: one window per lap")
            parsed.laps.forEachIndexed { i, lap -> assertWindow(windows[i], clipWindow(lap, parsed.durationS), "$name: lap $i") }
        }
    }

    @Test
    fun `clipOffer matches every review the fixture holds`() {
        val inputs = fixture["cases"]!!.jsonArray.associate {
            val input = it.jsonObject["input"]!!.jsonObject
            input["name"]!!.jsonPrimitive.content to input
        }
        for (element in fixture["offers"]!!.jsonArray) {
            val case = element.jsonObject
            val name = case["name"]!!.jsonPrimitive.content
            val items = case["items"]!!.jsonArray.map {
                val o = it.jsonObject
                val input = inputs.getValue(o["input"]!!.jsonPrimitive.content)
                OfferItem(
                    parsed = parsedOf(input),
                    include = o["include"]!!.jsonPrimitive.content.toBooleanStrict(),
                    fileBytes = input["fileBytes"]!!.jsonPrimitive.long,
                )
            }
            val rawEnt = case["entitlement"]!!
            val entitlement = if (rawEnt is JsonNull) null else strict.decodeFromJsonElement(Entitlement.serializer(), rawEnt)
            assertEquals(
                case["expected"]!!.jsonPrimitive.content,
                clipOffer(items, entitlement, clipsOf(case["clips"])).rawValue,
                name,
            )
        }
    }

    @Test
    fun `the row's and Settings' words match`() {
        for (row in fixture["offerNote"]!!.jsonArray) {
            val (input, want) = row.jsonArray
            val clips = if (input is JsonNull) null else ClipStorage(0, 0, input.jsonObject["coach_count"]!!.jsonPrimitive.content.toInt())
            assertEquals(want.jsonPrimitive.content, clipOfferNote(clips), "offerNote $input")
        }
        for (row in fixture["offerText"]!!.jsonArray) {
            val (input, want) = row.jsonArray
            assertEquals(want.jsonPrimitive.content, clipOfferText(if (input is JsonNull) null else input.jsonPrimitive.long), "offerText $input")
        }
        for (row in fixture["fullText"]!!.jsonArray) {
            val (input, want) = row.jsonArray
            assertEquals(want.jsonPrimitive.content, clipFullText(clipsOf(input)), "fullText $input")
        }
        for (row in fixture["storageLine"]!!.jsonArray) {
            val (input, want) = row.jsonArray
            assertEquals(if (want is JsonNull) null else want.jsonPrimitive.content, clipStorageLine(clipsOf(input)), "storageLine $input")
        }
        val bytes = fixture["fmtClipBytes"]!!.jsonArray
        assertTrue(bytes.size >= 14)
        for (row in bytes) {
            val (input, want) = row.jsonArray
            assertEquals(want.jsonPrimitive.content, fmtClipBytes(input.jsonPrimitive.long), "fmtClipBytes $input")
        }
    }

    // ---- test/unit/clip.test.js, ported -------------------------------------

    private fun lap(timeMs: Int, startT: Double?, endT: Double?, estimated: Boolean = false) =
        ParsedLap(timeMs = timeMs, estimated = estimated, startT = startT, endT = endT)

    private val pro = Entitlement(tier = Entitlement.Tier.PRO, source = Entitlement.Source.APPLE, expiresAt = 1_800_000_000_000, autoRenew = true)
    private val free = Entitlement.FREE
    private val gib = 1024L * 1024 * 1024

    @Nested
    inner class ClipWindowCases {
        @Test
        fun `pads the lap by PRE_ROLL_S and POST_ROLL_S`() {
            assertEquals(
                LapClips.ClipWindow(startS = 50 - PRE_ROLL_S, endS = 150 + POST_ROLL_S, lapOffsetS = PRE_ROLL_S),
                clipWindow(lap(100_000, 50.0, 150.0), 1000.0),
            )
        }

        @Test
        fun `clamps to the file, keeping the lap's offset honest`() {
            assertEquals(LapClips.ClipWindow(0.0, 101.0, 1.0), clipWindow(lap(99_000, 1.0, 100.0), 101.0))
        }

        @Test
        fun `is inclusive at MAX_CLIP_S and null past it`() {
            assertNotNull(clipWindow(lap(600_000, 10.0, 10 + MAX_CLIP_S), 2000.0))
            assertNull(clipWindow(lap(600_001, 10.0, 10 + MAX_CLIP_S + 0.001), 2000.0))
        }

        @Test
        fun `is null without a window inside the file`() {
            assertNull(clipWindow(lap(1, null, 10.0), 100.0))
            assertNull(clipWindow(lap(1, 10.0, 10.0), 100.0))
            assertNull(clipWindow(lap(1, 20.0, 10.0), 100.0))
            assertNull(clipWindow(lap(1, -1.0, 10.0), 100.0))
            assertNull(clipWindow(lap(1, 10.0, 101.0), 100.0))
            assertNull(clipWindow(null, 100.0))
        }
    }

    @Nested
    inner class ClipCandidateCases {
        private fun parsed(kind: ParsedTelemetry.Kind, vararg laps: ParsedLap) =
            ParsedTelemetry(kind = kind, durationS = 500.0, laps = laps.toList())

        @Test
        fun `takes the best lap with a window, the lower lap number on a tie`() {
            val p = parsed(ParsedTelemetry.Kind.PDR, lap(101_000, 10.0, 111.0), lap(100_000, 111.0, 211.0), lap(100_000, 211.0, 311.0))
            assertEquals(1, clipCandidate(p)?.index)
        }

        @Test
        fun `skips a faster lap with no window`() {
            val p = parsed(ParsedTelemetry.Kind.GOPRO, lap(90_000, null, null), lap(95_000, 10.0, 105.0))
            assertEquals(1, clipCandidate(p)?.index)
        }

        @Test
        fun `keeps estimated laps`() {
            assertEquals(0, clipCandidate(parsed(ParsedTelemetry.Kind.PDR, lap(99_000, 10.0, 109.0, estimated = true)))?.index)
        }

        @Test
        fun `is null for anything that isn't a video`() {
            for (kind in listOf(ParsedTelemetry.Kind.LIVE, ParsedTelemetry.Kind.VBO, ParsedTelemetry.Kind.TRACK_PRECISION)) {
                assertNull(clipCandidate(parsed(kind, lap(99_000, 10.0, 109.0))), kind.name)
            }
            assertNull(clipCandidate(null))
            assertNull(clipCandidate(parsed(ParsedTelemetry.Kind.GOPRO)))
        }
    }

    @Test
    fun `estimateClipBytes is the file's bitrate over the window`() {
        // 1 GB over 1000 s is 1 MB/s; a 100 s lap plus 5 s padding is 105 MB.
        assertEquals(105_000_000L, estimateClipBytes(lap(100_000, 100.0, 200.0), 1_000_000_000, 1000.0))
        assertNull(estimateClipBytes(lap(100_000, 100.0, 200.0), 0, 1000.0))
        assertNull(estimateClipBytes(lap(100_000, null, 200.0), 1_000_000_000, 1000.0))
    }

    @Nested
    inner class ClipOfferCases {
        private fun video(include: Boolean = true) = OfferItem(
            parsed = ParsedTelemetry(kind = ParsedTelemetry.Kind.PDR, durationS = 1000.0, laps = listOf(lap(100_000, 100.0, 200.0))),
            include = include,
            fileBytes = 1_000_000_000,
        )

        private val vbo = OfferItem(
            parsed = ParsedTelemetry(kind = ParsedTelemetry.Kind.VBO, durationS = 1000.0, laps = listOf(lap(100_000, 100.0, 200.0))),
            include = true,
            fileBytes = 10,
        )
        private val room = ClipStorage(usedBytes = 0, quotaBytes = 20 * gib, coachCount = 0)

        @Test
        fun `offers the row on for Pro, locked for free, and not at all without a video`() {
            assertEquals(ClipOffer.ON, clipOffer(listOf(video()), pro, room))
            assertEquals(ClipOffer.LOCKED, clipOffer(listOf(video()), free, room))
            assertEquals(ClipOffer.LOCKED, clipOffer(listOf(video()), null, null))
            assertEquals(ClipOffer.NONE, clipOffer(listOf(vbo), pro, room))
            assertEquals(ClipOffer.NONE, clipOffer(listOf(video(false), vbo), pro, room))
            assertEquals(ClipOffer.NONE, clipOffer(emptyList(), pro, room))
        }

        @Test
        fun `is full once this review's estimates would pass the quota — at it is fine`() {
            assertEquals(ClipOffer.ON, clipOffer(listOf(video()), pro, room.copy(usedBytes = 20 * gib - 105_000_000)))
            assertEquals(ClipOffer.FULL, clipOffer(listOf(video()), pro, room.copy(usedBytes = 20 * gib - 104_999_999)))
            assertEquals(ClipOffer.FULL, clipOffer(listOf(video(), video()), pro, room.copy(usedBytes = 20 * gib - 150_000_000)))
            // A cached /me from before the field knows nothing is full.
            assertEquals(ClipOffer.ON, clipOffer(listOf(video()), pro, null))
        }

        @Test
        fun `agrees with canSaveLapVideo`() {
            assertTrue(Entitlement.canSaveLapVideo(pro))
            assertFalse(Entitlement.canSaveLapVideo(free))
            assertFalse(Entitlement.canSaveLapVideo(null))
        }
    }

    @Nested
    inner class Words {
        @Test
        fun `names coaches in one sentence, whatever the count`() {
            assertEquals("", clipOfferNote(ClipStorage(0, 0, 0)))
            assertEquals("Your coaches can watch it too.", clipOfferNote(ClipStorage(0, 0, 1)))
            assertEquals("Your coaches can watch it too.", clipOfferNote(ClipStorage(0, 0, 4)))
            assertEquals("", clipOfferNote(null))
        }

        @Test
        fun `says the size when it has one`() {
            assertEquals(
                "A clip of each session's fastest lap, about 150 MB each. Uploads on Wi-Fi.",
                clipOfferText(150L * 1024 * 1024),
            )
            assertEquals("A clip of each session's fastest lap. Uploads on Wi-Fi.", clipOfferText(null))
        }

        @Test
        fun `says storage is full, and Settings' line`() {
            val clips = ClipStorage(usedBytes = (3.2 * gib).roundToLong(), quotaBytes = 20 * gib, coachCount = 0)
            assertEquals("Your lap video storage is full (20 GB). Delete old clips from a lap's page.", clipFullText(clips))
            assertEquals("Lap videos: 3.2 GB of 20 GB", clipStorageLine(clips))
            assertNull(clipStorageLine(null))
        }

        @Test
        fun `formats bytes in MB below a gigabyte and GB to one decimal above`() {
            assertEquals("0 MB", fmtClipBytes(0L))
            assertEquals("1 MB", fmtClipBytes(1L))
            assertEquals("143 MB", fmtClipBytes(150_000_000L))
            assertEquals("1 GB", fmtClipBytes(gib - 1))
            assertEquals("3.3 GB", fmtClipBytes(3.25 * gib))
            assertEquals("20 GB", fmtClipBytes(20 * gib))
        }
    }
}
