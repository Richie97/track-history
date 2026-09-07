package app.trackevolution.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Turning a fold into a posture (spec: NS-34 ticket 4).
 *
 * Plain JUnit, and that is the point: a posture cannot be produced on a desk, an
 * emulator profile is awkward to drive from a test, and `FoldingFeature` has no
 * public constructor. So the decision is a function over three plain values and
 * only the four lines that *read* the window stay untested — the same split
 * `AutoRecording` uses for the surface nobody can open on a desk.
 */
class FoldsTest {

    @Test
    fun `a flat device has no posture, whatever its hinge says`() {
        assertEquals(
            Folds.FLAT,
            Folds.geometry(halfOpened = false, horizontal = true, hingeFraction = 0.5f),
        )
        assertEquals(
            Folds.FLAT,
            Folds.geometry(halfOpened = false, horizontal = false, hingeFraction = 0.5f),
        )
    }

    @Test
    fun `half open across the middle is tabletop, along it is book`() {
        assertEquals(
            FoldGeometry(FoldPosture.Tabletop, 0.5f),
            Folds.geometry(halfOpened = true, horizontal = true, hingeFraction = 0.5f),
        )
        assertEquals(
            FoldGeometry(FoldPosture.Book, 0.5f),
            Folds.geometry(halfOpened = true, horizontal = false, hingeFraction = 0.5f),
        )
    }

    @Test
    fun `an unknown hinge position is assumed to be the middle`() {
        val geometry = Folds.geometry(halfOpened = true, horizontal = true, hingeFraction = null)
        assertEquals(FoldPosture.Tabletop, geometry.posture)
        assertEquals(0.5f, geometry.hingeFraction!!, 1e-6f)
    }

    /**
     * A hinge nowhere near the middle is not a posture worth laying out for: one
     * of the two halves would be too small to read anything in, and the ordinary
     * layout is a better answer than a deliberate sliver.
     */
    @Test
    fun `a hinge far from the middle falls back to flat`() {
        assertEquals(
            Folds.FLAT,
            Folds.geometry(halfOpened = true, horizontal = true, hingeFraction = 0.05f),
        )
        assertEquals(
            Folds.FLAT,
            Folds.geometry(halfOpened = true, horizontal = true, hingeFraction = 0.95f),
        )
        assertNull(
            Folds.geometry(halfOpened = true, horizontal = false, hingeFraction = 0.9f).hingeFraction,
        )
    }

    /** The edges of what counts as usable, which is where an off-by-one would sit. */
    @Test
    fun `the limits themselves are still postures`() {
        assertEquals(
            FoldPosture.Tabletop,
            Folds.geometry(halfOpened = true, horizontal = true, hingeFraction = 0.15f).posture,
        )
        assertEquals(
            FoldPosture.Tabletop,
            Folds.geometry(halfOpened = true, horizontal = true, hingeFraction = 0.85f).posture,
        )
    }
}
