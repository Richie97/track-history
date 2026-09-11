package app.trackevolution.core.telemetry

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** `describe("series")` in `test/unit/pdr.test.js`. */
class SeriesTest {
    private val s = series(
        listOf(
            ChannelPoint(t = 0.0, v = 0.0),
            ChannelPoint(t = 10.0, v = 100.0),
            ChannelPoint(t = 20.0, v = 300.0),
        ),
    )

    @Test
    fun `interpolates values at a time`() {
        assertEquals(50.0, s.at(5.0))
        assertEquals(200.0, s.at(15.0))
        assertEquals(100.0, s.at(10.0))
    }

    @Test
    fun `inverts monotonic series with timeAt`() {
        assertEquals(5.0, s.timeAt(50.0))
        assertEquals(15.0, s.timeAt(200.0))
    }

    @Test
    fun `computes a central-difference rate`() {
        // between t=10 and t=20 the slope is 20 v/t
        assertEquals(20.0, s.rate(15.0, 2.0))
    }

    @Test
    fun `exposes first, last and length`() {
        assertEquals(3, s.n)
        assertEquals(ChannelPoint(0.0, 0.0), s.first)
        assertEquals(ChannelPoint(20.0, 300.0), s.last)
    }
}
