package app.trackevolution.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The port of `test/unit/chart.test.js`, plus the cases the JS covers through
 * the rendered SVG (which we have no equivalent of) asserted against the scale
 * maths directly.
 */
class ChartScaleTest {

    // ---- niceTimeTicks: straight from the JS suite -------------------------

    @Test
    fun `picks a step at least span over count from the nice-step table`() {
        assertEquals(
            listOf(0.0, 1000.0, 2000.0, 3000.0, 4000.0),
            ChartScale.niceTimeTicks(0.0, 4000.0),
        )
    }

    @Test
    fun `aligns ticks to step boundaries inside the range`() {
        assertEquals(
            listOf(200.0, 400.0, 600.0, 800.0),
            ChartScale.niceTimeTicks(150.0, 950.0),
        )
    }

    @Test
    fun `falls back to a huge step for very large spans`() {
        val ticks = ChartScale.niceTimeTicks(0.0, 10_000_000.0)
        assertEquals(300_000.0, ticks[1] - ticks[0])
    }

    // ---- niceNumTicks ------------------------------------------------------

    @Test
    fun `produces one-two-two-and-a-half-five ticks for a plain axis`() {
        assertEquals(listOf(0.0, 25.0, 50.0, 75.0, 100.0), ChartScale.niceNumTicks(0.0, 100.0, 4))
    }

    @Test
    fun `includes a tick landing exactly on the maximum`() {
        // The JS carries a 1e-9 epsilon on this bound precisely so the final
        // tick is not lost to floating-point noise.
        assertTrue(ChartScale.niceNumTicks(0.0, 2.0, 4).contains(2.0))
    }

    @Test
    fun `survives a zero span without looping forever`() {
        assertTrue(ChartScale.niceNumTicks(5.0, 5.0, 4).isNotEmpty())
    }

    // ---- the inversion, which is the whole convention ----------------------

    @Test
    fun `plots faster laps lower`() {
        // The JS asserts this through rendered `cy` attributes; the same claim
        // one layer down. A larger fraction is further from the top.
        val domain = ChartScale.lapTimeDomain(listOf(125_000, 122_000, 121_000))!!
        val slowest = ChartScale.plottedFraction(125_000.0, domain)
        val fastest = ChartScale.plottedFraction(121_000.0, domain)
        assertTrue(fastest > slowest, "the fastest lap must sit lower on the chart")
    }

    @Test
    fun `maps the domain edges to the top and bottom`() {
        val domain = ChartScale.Domain(low = 100.0, high = 200.0)
        assertEquals(0.0, ChartScale.plottedFraction(200.0, domain))
        assertEquals(1.0, ChartScale.plottedFraction(100.0, domain))
    }

    // ---- domains -----------------------------------------------------------

    @Test
    fun `pads the lap-time domain by twelve percent`() {
        val domain = ChartScale.lapTimeDomain(listOf(100_000, 200_000))!!
        // span 100_000 -> pad 12_000, which clears the 500 ms floor.
        assertEquals(88_000.0, domain.low)
        assertEquals(212_000.0, domain.high)
    }

    @Test
    fun `falls back to the floor when the spread is tiny`() {
        val domain = ChartScale.lapTimeDomain(listOf(120_000, 120_100))!!
        // 12% of 100 ms is 12 ms, so the 500 ms floor wins.
        assertEquals(119_500.0, domain.low)
        assertEquals(120_600.0, domain.high)
    }

    @Test
    fun `gives identical lap times a plottable window`() {
        val domain = ChartScale.lapTimeDomain(listOf(120_000, 120_000, 120_000))!!
        assertEquals(1000.0, domain.span)
        // …and the flat line lands mid-plot rather than on an edge.
        assertEquals(0.5, ChartScale.plottedFraction(120_000.0, domain))
    }

    @Test
    fun `keeps an unbeaten goal inside the domain`() {
        val domain = ChartScale.lapTimeDomain(listOf(125_000, 122_000), goal = 110_000)!!
        assertTrue(domain.low < 110_000.0, "the goal rule must be drawable")
    }

    @Test
    fun `returns no domain for no points`() {
        assertNull(ChartScale.lapTimeDomain(emptyList()))
        assertNull(ChartScale.xDomain(emptyList()))
    }

    @Test
    fun `widens the x domain for a single point`() {
        val domain = ChartScale.xDomain(listOf(7.0))!!
        assertEquals(6.0, domain.low)
        assertEquals(8.0, domain.high)
        assertEquals(0.5, ChartScale.horizontalFraction(7.0, domain))
    }

    // ---- the speed ramp ----------------------------------------------------

    @Test
    fun `maps speed onto the ramp`() {
        assertEquals(0.0, ChartScale.speedFraction(10.0, slowest = 10.0, fastest = 50.0))
        assertEquals(1.0, ChartScale.speedFraction(50.0, slowest = 10.0, fastest = 50.0))
        assertEquals(0.5, ChartScale.speedFraction(30.0, slowest = 10.0, fastest = 50.0))
    }

    @Test
    fun `puts a constant-speed trace mid-ramp`() {
        // trackmap.js's choice. iOS returns 1 here; see the note on ChartScale.
        assertEquals(0.5, ChartScale.speedFraction(30.0, slowest = 30.0, fastest = 30.0))
    }

    // ---- display downsampling ---------------------------------------------

    @Test
    fun `strides a raw recording down to something drawable`() {
        val raw = (0 until 20_000).map { TracePoint(t = it * 0.1, x = it.toDouble(), y = 0.0) }
        val drawn = ChartScale.downsampleForDisplay(raw)
        assertTrue(drawn.size <= ChartScale.MAX_DISPLAY_POINTS + 1, "got ${drawn.size}")
        assertEquals(raw.first(), drawn.first())
        // The last point always survives: a polyline that stops short of where
        // the lap ended reads as a GPS dropout.
        assertEquals(raw.last(), drawn.last())
    }

    @Test
    fun `leaves a trace that already fits completely alone`() {
        val short = (0 until 250).map { TracePoint(t = it.toDouble(), x = it.toDouble(), y = 0.0) }
        assertTrue(ChartScale.downsampleForDisplay(short) === short)
    }

    @Test
    fun `keeps the final point even when the stride would skip it`() {
        val raw = (0 until 17).map { TracePoint(t = it.toDouble(), x = it.toDouble(), y = 0.0) }
        val drawn = ChartScale.downsampleForDisplay(raw, max = 4)
        assertEquals(raw.last(), drawn.last())
    }

    @Test
    fun `reads the speed extremes off a trace`() {
        val samples = listOf(
            TraceSample(x = 0.0, y = 0.0, v = 12.0),
            TraceSample(x = 1.0, y = 0.0, v = 40.0),
            TraceSample(x = 2.0, y = 0.0, v = 25.0),
        )
        assertEquals(12.0 to 40.0, ChartScale.speedRange(samples))
        assertNull(ChartScale.speedRange(emptyList()))
    }
}
