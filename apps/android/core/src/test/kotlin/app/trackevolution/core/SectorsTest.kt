package app.trackevolution.core

import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.abs

/**
 * The port of `test/unit/sectors.test.js`, case for case, plus the
 * cross-language pin against `contracts/logic/sectors.json`.
 */
class SectorsTest {

    private fun lap(n: Int, timeMs: Int, speed: List<Double>?, rpm: List<Double>? = null) =
        LapChannels(n = n, timeMs = timeMs, speed = speed, rpm = rpm)

    /** One speed for the first half of the distance, double that for the second. */
    private val slowThenFast = List(31) { 60.0 } + List(30) { 120.0 }
    private val fastThenSlow = List(31) { 120.0 } + List(30) { 60.0 }
    private val constant = List(61) { 90.0 }

    // ---- sectorTimes -------------------------------------------------------

    @Test
    fun `splits a constant-speed lap into equal sectors that sum to the lap time`() {
        val s = Sectors.sectorTimes(lap(1, 90_000, constant), 20.0)!!
        assertEquals(Sectors.SECTOR_COUNT, s.size)
        assertEquals(90_000, s.sum())
        assertEquals(listOf(30_000, 30_000, 30_000), s)
    }

    @Test
    fun `puts more time in the sectors where the car was slower`() {
        val s = Sectors.sectorTimes(lap(1, 90_000, slowThenFast), 20.0)!!
        assertTrue(s[0] > s[2])
        assertEquals(90_000, s.sum())
        // S1 is all slow, S3 all fast at double the speed: S1 is twice S3.
        assertTrue(abs(s[0].toDouble() / s[2] - 2) < 0.05)
    }

    @Test
    fun `last sector absorbs the rounding residual`() {
        assertEquals(90_001, Sectors.sectorTimes(lap(1, 90_001, constant), 20.0)!!.sum())
    }

    @Test
    fun `uses the integrated duration without a timed lap`() {
        // 60 cells of 20 m at 72 km/h = 20 m/s: 1 s per cell, 60 s total.
        assertEquals(60_000, Sectors.sectorTimes(List(61) { 72.0 }, null, 20.0)!!.sum())
    }

    @Test
    fun `honours a different sector count`() {
        assertEquals(listOf(90_000), Sectors.sectorTimes(lap(1, 90_000, constant), 20.0, 1))
        assertEquals(6, Sectors.sectorTimes(lap(1, 90_000, constant), 20.0, 6)!!.size)
    }

    @Test
    fun `returns null for laps without a usable speed series`() {
        assertNull(Sectors.sectorTimes(lap(1, 90_000, null, rpm = List(61) { 5000.0 }), 20.0))
        assertNull(Sectors.sectorTimes(lap(1, 90_000, listOf(90.0)), 20.0))
        assertNull(Sectors.sectorTimes(lap(1, 90_000, constant), 20.0, 0))
    }

    // ---- sessionSectors ----------------------------------------------------

    private val channels = SessionChannels(
        v = 1,
        dStepM = 20.0,
        laps = listOf(
            lap(1, 90_000, slowThenFast), // slow start
            lap(2, 90_000, fastThenSlow), // slow finish
            lap(3, 95_000, null, rpm = List(61) { 5000.0 }), // no speed: left out
            lap(4, 89_500, constant), // actual best, even sectors
        ),
    )

    @Test
    fun `takes the best of each sector across laps`() {
        val sec = Sectors.sessionSectors(channels)!!
        assertEquals(3, sec.n)
        assertEquals(listOf(0, 1, 3), sec.laps.map { it.chIdx })
        assertEquals(1, sec.bestSectorLap[0]) // fast start owns S1
        assertEquals(0, sec.bestSectorLap[2]) // fast finish owns S3
        assertEquals(sec.bestSectors.sum(), sec.theoreticalBestMs)
        assertEquals(3, sec.bestLapIdx)
        assertEquals(89_500, sec.bestLapMs)
        assertEquals(89_500 - sec.theoreticalBestMs, sec.gapMs)
        assertTrue(sec.theoreticalBestMs < sec.bestLapMs)
    }

    @Test
    fun `zero gap when the best lap owns every best sector`() {
        val sec = Sectors.sessionSectors(SessionChannels(1, 20.0, listOf(channels.laps[3], channels.laps[2])))!!
        assertEquals(1, sec.laps.size)
        assertEquals(0, sec.gapMs)
        assertEquals(89_500, sec.theoreticalBestMs)
    }

    @Test
    fun `keeps the earlier lap on a tied sector`() {
        val tied = SessionChannels(1, 20.0, listOf(lap(1, 90_000, constant), lap(2, 90_000, constant)))
        assertEquals(listOf(0, 0, 0), Sectors.sessionSectors(tied)!!.bestSectorLap)
    }

    @Test
    fun `null when no lap can be split`() {
        assertNull(Sectors.sessionSectors(SessionChannels(1, 20.0, listOf(channels.laps[2]))))
        assertNull(Sectors.sessionSectors(SessionChannels(1, 20.0, emptyList())))
    }

    // ---- cross-language pin ------------------------------------------------

    @Test
    fun `matches the web implementation's reference output`() {
        val json = Json { ignoreUnknownKeys = false }
        val fixture = Json.parseToJsonElement(
            RepoRoot.path("contracts/logic/sectors.json").readText(),
        ).jsonObject
        val input = fixture["input"]!!.jsonObject
        val expected = fixture["expected"]!!.jsonObject
        val channels = json.decodeFromJsonElement<SessionChannels>(input["channels"]!!)
        val n = input["n"]!!.jsonPrimitive.content.toInt()
        val microN = input["microsectorN"]!!.jsonPrimitive.content.toInt()

        val want = json.decodeFromJsonElement<Sectors.SessionSplits>(expected["session"]!!)
        val got = Sectors.sessionSectors(channels, n)
        assertNotNull(got)
        assertEquals(want, got)

        val ref = channels.laps[0]
        fun ints(key: String): List<Int>? =
            expected[key]?.takeIf { it !is kotlinx.serialization.json.JsonNull }
                ?.let { json.decodeFromJsonElement<List<Int>>(it) }
        assertEquals(ints("refMicrosectors"), Sectors.sectorTimes(ref, channels.dStepM, microN))
        assertEquals(ints("refSingleSector"), Sectors.sectorTimes(ref, channels.dStepM, 1))
        assertEquals(ints("untimedSectors"), Sectors.sectorTimes(ref.speed, null, channels.dStepM, n))
        assertEquals(ints("noSpeed"), Sectors.sectorTimes(channels.laps[3], channels.dStepM, n))
    }
}
