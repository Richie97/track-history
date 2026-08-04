package app.trackevolution.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** The port of `test/unit/lap-stats.test.js`, case for case. */
class LapStatsTest {

    // ---- cleanLaps ---------------------------------------------------------

    @Test
    fun `drops laps slower than the 107 percent cutoff`() {
        // best 100s -> cutoff 107s; the 130s out-lap goes
        assertEquals(
            listOf(100_000, 105_000, 106_900),
            LapStats.cleanLaps(listOf(130_000, 100_000, 105_000, 106_900)),
        )
    }

    @Test
    fun `handles empty input`() {
        assertEquals(emptyList<Int>(), LapStats.cleanLaps(emptyList()))
    }

    // ---- bestNAvg ----------------------------------------------------------

    @Test
    fun `averages the best n laps`() {
        assertEquals(
            (121_000 + 123_000 + 125_000) / 3.0,
            LapStats.bestNAvg(listOf(125_000, 121_000, 123_000, 129_000), 3),
        )
    }

    @Test
    fun `is null with fewer than n laps`() {
        assertNull(LapStats.bestNAvg(listOf(121_000, 122_000), 3))
    }

    @Test
    fun `does not mutate the input`() {
        val laps = listOf(125_000, 121_000, 123_000)
        LapStats.bestNAvg(laps, 3)
        assertEquals(listOf(125_000, 121_000, 123_000), laps)
    }

    // ---- paceSlope ---------------------------------------------------------

    @Test
    fun `is positive when laps get slower through the session`() {
        assertEquals(
            500.0,
            LapStats.paceSlope(listOf(120_000, 120_500, 121_000, 121_500, 122_000))!!,
            1e-6,
        )
    }

    @Test
    fun `is negative when still improving`() {
        assertEquals(
            -500.0,
            LapStats.paceSlope(listOf(122_000, 121_500, 121_000, 120_500, 120_000))!!,
            1e-6,
        )
    }

    @Test
    fun `ignores out-laps beyond the 107 percent cutoff`() {
        // The 140s out-lap would swamp the trend; the clean laps are flat.
        assertEquals(
            0.0,
            LapStats.paceSlope(listOf(140_000, 120_000, 120_000, 120_000, 120_000))!!,
            1e-6,
        )
    }

    @Test
    fun `is null with fewer than 4 clean laps`() {
        assertNull(LapStats.paceSlope(listOf(120_000, 121_000, 122_000)))
        assertNull(LapStats.paceSlope(emptyList()))
    }

    // ---- warmupLapCount ----------------------------------------------------

    @Test
    fun `finds the first lap within 1 percent of the session best`() {
        // best 120s -> threshold 121.2s; lap 3 is the first under it
        assertEquals(3, LapStats.warmupLapCount(listOf(130_000, 124_000, 121_000, 120_000)))
    }

    @Test
    fun `is 1 when on pace immediately`() {
        assertEquals(1, LapStats.warmupLapCount(listOf(120_000, 120_500, 121_000)))
    }

    @Test
    fun `is null with fewer than 2 laps`() {
        assertNull(LapStats.warmupLapCount(listOf(120_000)))
        assertNull(LapStats.warmupLapCount(emptyList()))
    }

    // ---- the sentence the event page shows ---------------------------------

    @Test
    fun `summarises a session the way the web app words it`() {
        val summary = LapStats.summary(listOf(130_000, 124_000, 121_000, 120_000, 120_200))!!
        assertTrue(summary.contains("best 3 avg"), summary)
        assertTrue(summary.contains("up to speed by lap 3"), summary)
    }

    @Test
    fun `calls out a session that faded`() {
        val summary = LapStats.summary(listOf(120_000, 120_500, 121_000, 121_500, 122_000))!!
        assertTrue(summary.contains("fading"), summary)
    }

    @Test
    fun `calls out a session still improving`() {
        val summary = LapStats.summary(listOf(122_000, 121_500, 121_000, 120_500, 120_000))!!
        assertTrue(summary.contains("still improving"), summary)
    }

    @Test
    fun `says nothing at all about an empty session`() {
        assertNull(LapStats.summary(emptyList()))
    }
}
