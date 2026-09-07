package app.trackevolution.ui.charts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A tap parks a mark; a pointer borrows one (spec: NS-34 ticket 5).
 *
 * The rule is one line in each of two languages, and the line is easy to write
 * the other way round — `parked ?: hovered` reads just as well and is wrong in
 * the case that matters, which is a mouse crossing a plot somebody had already
 * tapped. So it gets a test rather than a comment.
 */
class PanelPointerTest {
    private fun hit(k: Int, chIdx: Int? = null) =
        ChannelHit(chIdx = chIdx, k = k, frac = k / 100.0)

    @Test
    fun `nothing pointed at to begin with`() {
        assertNull(PanelPointer().current)
    }

    @Test
    fun `a tap parks a mark that stays`() {
        val pointer = PanelPointer()
        pointer.park(hit(10, chIdx = 1))
        assertEquals(hit(10, chIdx = 1), pointer.current)
    }

    @Test
    fun `a pointer borrows over a parked mark and hands it back on the way out`() {
        val pointer = PanelPointer()
        pointer.park(hit(10))
        pointer.hover(hit(40))
        assertEquals("the pointer's mark wins while it is there", hit(40), pointer.current)
        pointer.hover(null)
        assertEquals("and the tapped one comes back", hit(10), pointer.current)
    }

    @Test
    fun `a tap made under a hovering pointer is remembered, not lost`() {
        val pointer = PanelPointer()
        pointer.hover(hit(40))
        pointer.park(hit(40))
        pointer.hover(null)
        assertEquals(
            "tapping what the pointer was on should commit it, so leaving keeps it",
            hit(40),
            pointer.current,
        )
    }

    @Test
    fun `clearing the parked mark leaves nothing behind once the pointer goes`() {
        val pointer = PanelPointer()
        pointer.park(hit(10))
        pointer.park(null)
        pointer.hover(hit(40))
        assertEquals(hit(40), pointer.current)
        pointer.hover(null)
        assertNull(pointer.current)
    }
}
