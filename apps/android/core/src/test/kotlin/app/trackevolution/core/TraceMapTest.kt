package app.trackevolution.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The line picker's geometry, tested rather than tapped. Ported from the iOS
 * `TraceMapTests` so a tap in the same place on either app picks the same point.
 */
class TraceMapTest {

    /**
     * A 200 m square lap sampled every 8 m — 100 points.
     *
     * Deliberately dense rather than four corners: `buildGate` reads a heading
     * from a window of neighbouring points, and on a closed lap of five points
     * that window spans the whole circuit and finds no direction at all. A real
     * trace is hundreds of points, so a fixture that is not is testing something
     * the app never does.
     */
    private val square: List<TracePoint> = buildList {
        val step = 8.0
        var t = 0.0
        fun leg(fromX: Double, fromY: Double, toX: Double, toY: Double) {
            val dist = Math.hypot(toX - fromX, toY - fromY)
            val n = (dist / step).toInt()
            for (i in 0 until n) {
                val f = i.toDouble() / n
                add(TracePoint(t, fromX + (toX - fromX) * f, fromY + (toY - fromY) * f))
                t += 0.5
            }
        }
        leg(0.0, 0.0, 200.0, 0.0)
        leg(200.0, 0.0, 200.0, 200.0)
        leg(200.0, 200.0, 0.0, 200.0)
        leg(0.0, 200.0, 0.0, 0.0)
    }

    /** The index of the trace point at the far-east corner (200, 0). */
    private val cornerIndex: Int =
        square.indices.minByOrNull { Math.hypot(square[it].x - 200.0, square[it].y - 0.0) }!!

    private fun map(width: Double = 400.0, height: Double = 400.0, scale: Double = 1.0) =
        TraceMap.fit(square, width, height, scale = scale)!!

    @Test
    fun `an empty trace or an unlaid-out viewport has no map`() {
        assertNull(TraceMap.fit(emptyList(), 400.0, 400.0))
        assertNull(TraceMap.fit(square, 0.0, 400.0), "before first layout")
        assertNull(TraceMap.fit(square, 400.0, 0.0))
    }

    @Test
    fun `the trace is centred in the viewport`() {
        val m = map()
        val centre = m.viewPoint(100.0, 100.0)
        assertEquals(200.0, centre.x, 1e-9)
        assertEquals(200.0, centre.y, 1e-9)
    }

    /**
     * North is up on screen, but trace coordinates are meters north — so the
     * mapping has to flip y. Getting this wrong draws every circuit mirrored,
     * which is subtle enough to ship.
     */
    @Test
    fun `y is flipped so north is up`() {
        val m = map()
        val south = m.viewPoint(100.0, 0.0)
        val north = m.viewPoint(100.0, 200.0)
        assertTrue(north.y < south.y, "north should be higher up the screen (smaller y)")
    }

    /** A square track must not be stretched into a non-square viewport. */
    @Test
    fun `both axes share a scale`() {
        val m = map(width = 800.0, height = 400.0)
        val a = m.viewPoint(0.0, 0.0)
        val b = m.viewPoint(200.0, 0.0)
        val c = m.viewPoint(0.0, 200.0)
        assertEquals(Math.abs(b.x - a.x), Math.abs(c.y - a.y), 1e-9, "200 m must be 200 m either way")
    }

    @Test
    fun `padding keeps the trace off the edges`() {
        val m = map()
        val corner = m.viewPoint(0.0, 0.0)
        assertTrue(corner.x >= m.padding - 1e-9, "was ${corner.x}")
        assertTrue(corner.x <= m.width - m.padding + 1e-9)
    }

    @Test
    fun `view and trace coordinates round-trip`() {
        for (m in listOf(map(), map(scale = 2.5), TraceMap.fit(square, 400.0, 300.0, panX = 30.0, panY = -12.0)!!)) {
            val view = m.viewPoint(137.0, 41.0)
            val back = m.traceCoordinate(view.x, view.y)
            assertEquals(137.0, back.x, 1e-9)
            assertEquals(41.0, back.y, 1e-9)
        }
    }

    @Test
    fun `a tap resolves to the nearest trace point`() {
        val m = map()
        // Straight at the far-east corner (200, 0).
        val onCorner = m.viewPoint(square[cornerIndex].x, square[cornerIndex].y)
        assertEquals(cornerIndex, m.nearestIndex(onCorner.x, onCorner.y, square))

        // A near miss still lands on it: one pixel here is ~0.6 m.
        assertEquals(cornerIndex, m.nearestIndex(onCorner.x + 2, onCorner.y - 2, square))
    }

    @Test
    fun `nearest index needs a trace`() {
        assertNull(map().nearestIndex(10.0, 10.0, emptyList()))
    }

    /**
     * Zooming in must not move the point under the finger relative to the trace —
     * otherwise picking gets harder the more you zoom to make it easier.
     */
    @Test
    fun `zoom keeps the centre anchored`() {
        val fitted = map()
        val zoomed = map(scale = 3.0)
        val a = fitted.viewPoint(100.0, 100.0)
        val b = zoomed.viewPoint(100.0, 100.0)
        assertEquals(a.x, b.x, 1e-9)
        assertEquals(a.y, b.y, 1e-9)
    }

    @Test
    fun `pan offsets the drawing by exactly the pan`() {
        val fitted = map()
        val panned = TraceMap.fit(square, 400.0, 400.0, panX = 25.0, panY = -40.0)!!
        val a = fitted.viewPoint(0.0, 0.0)
        val b = panned.viewPoint(0.0, 0.0)
        assertEquals(a.x + 25.0, b.x, 1e-9)
        assertEquals(a.y - 40.0, b.y, 1e-9)
    }

    /** The picked gate is drawn as a segment, so both ends have to map. */
    @Test
    fun `a gate maps to a drawable segment`() {
        val gate = GeoTrace.buildGate(square, cornerIndex)!!
        val (from, to) = map().viewSegment(gate)
        assertTrue(from.x.isFinite() && from.y.isFinite())
        assertTrue(to.x.isFinite() && to.y.isFinite())
        assertTrue(Math.hypot(to.x - from.x, to.y - from.y) > 1.0, "a gate must not collapse to a dot")
    }
}
