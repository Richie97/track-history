package app.trackevolution.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

/**
 * Ported from `test/unit/format.test.js`, case for case, with the same inputs
 * and the same expectations. The `esc` and `fmtDate` blocks of the original are
 * deliberately absent — HTML escaping and browser locale dates have no meaning
 * here.
 */
class LapTimeTest {

    @Nested
    inner class FmtMs {
        @Test
        fun `formats null as an em dash`() {
            assertEquals("—", LapTime.fmtMs(null as Int?))
            assertEquals("—", LapTime.fmtMs(null as Double?))
        }

        @Test
        fun `formats m ss fff with trailing zeros trimmed`() {
            assertEquals("2:01.24", LapTime.fmtMs(121_240))
            assertEquals("2:01.0", LapTime.fmtMs(121_000))
            assertEquals("2:01.5", LapTime.fmtMs(121_500))
            assertEquals("0:59.999", LapTime.fmtMs(59_999))
            assertEquals("1:00.0", LapTime.fmtMs(60_000))
        }

        @Test
        fun `rounds fractional milliseconds`() {
            assertEquals("2:01.24", LapTime.fmtMs(121_239.6))
        }
    }

    @Nested
    inner class ParseTime {
        @Test
        fun `parses m ss fff`() {
            assertEquals(121_240, LapTime.parseTime("2:01.24"))
            assertEquals(121_000, LapTime.parseTime("2:01"))
            assertEquals(59_999, LapTime.parseTime("0:59.999"))
        }

        @Test
        fun `parses bare seconds`() {
            assertEquals(121_240, LapTime.parseTime("121.24"))
            assertEquals(95_000, LapTime.parseTime("95"))
        }

        @Test
        fun `accepts comma as the decimal separator`() {
            assertEquals(121_500, LapTime.parseTime("2:01,5"))
            assertEquals(95_250, LapTime.parseTime("95,25"))
        }

        @Test
        fun `trims whitespace`() {
            assertEquals(65_500, LapTime.parseTime("  1:05.5 "))
        }

        @Test
        fun `returns null for unparseable input`() {
            assertNull(LapTime.parseTime(""))
            assertNull(LapTime.parseTime(null))
            assertNull(LapTime.parseTime("abc"))
            assertNull(LapTime.parseTime("1:2:3"))
            // Seconds are at most two digits.
            assertNull(LapTime.parseTime("1:234"))
        }

        @Test
        fun `round-trips fmtMs output`() {
            for (ms in listOf(59_999, 60_000, 95_250, 121_240, 754_321)) {
                assertEquals(ms, LapTime.parseTime(LapTime.fmtMs(ms)))
            }
        }
    }

    @Nested
    inner class ParseLapList {
        @Test
        fun `splits on commas, semicolons and whitespace`() {
            assertEquals(
                listOf(123_550, 121_240, 122_610, 120_000),
                LapTime.parseLapList("2:03.55\n2:01.24, 2:02.61; 2:00"),
            )
        }

        @Test
        fun `drops unparseable and non-positive entries`() {
            assertEquals(listOf(121_240), LapTime.parseLapList("junk 0 2:01.24"))
            assertEquals(emptyList<Int>(), LapTime.parseLapList(""))
            assertEquals(emptyList<Int>(), LapTime.parseLapList(null))
        }
    }

    @Nested
    inner class FmtConsistency {
        @Test
        fun `formats a coefficient of variation as a percentage`() {
            assertEquals("1.2%", LapTime.fmtConsistency(0.0123))
            assertEquals("—", LapTime.fmtConsistency(null))
        }
    }

    /**
     * `fmtDelta` has no JS test of its own; these pin the behavior of the
     * original's `toFixed(...).replace(/\.?0+$/, "")`, which is the part a port
     * gets wrong.
     */
    @Nested
    inner class FmtDelta {
        @Test
        fun `signs and trims the difference`() {
            assertEquals("+1.24s", LapTime.fmtDelta(1_240))
            assertEquals("-0.8s", LapTime.fmtDelta(-800))
            assertEquals("0s", LapTime.fmtDelta(0))
            assertEquals("—", LapTime.fmtDelta(null))
        }

        @Test
        fun `drops to one decimal past ten seconds`() {
            assertEquals("+12.3s", LapTime.fmtDelta(12_340))
            assertEquals("+100s", LapTime.fmtDelta(100_000))
        }
    }
}
