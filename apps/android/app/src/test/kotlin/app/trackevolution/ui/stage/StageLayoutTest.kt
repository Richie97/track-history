package app.trackevolution.ui.stage

import app.trackevolution.ui.FoldPosture
import org.junit.Assert.assertEquals
import org.junit.Test

/** NS-51's *Layouts* table, row by row, through the pure [StageLayout.choose]. */
class StageLayoutTest {

    private fun choose(
        width: Float,
        side: Boolean = width >= 840f,
        posture: FoldPosture = FoldPosture.Flat,
        landscape: Boolean = false,
        height: Int = 900,
        video: Boolean = true,
    ) = StageLayout.choose(width, side, posture, landscape, height, video)

    @Test
    fun `reads the pane's width - wide, medium, compact`() {
        assertEquals(StageLayout.Wide, choose(1200f))
        assertEquals(StageLayout.Wide, choose(1000f))
        assertEquals(StageLayout.Medium, choose(999f))
        assertEquals("a wide pane with no side column to give is medium", StageLayout.Medium, choose(1100f, side = false))
        assertEquals(StageLayout.Medium, choose(600f))
        assertEquals(StageLayout.Compact, choose(599f))
        assertEquals("the closed Duo", StageLayout.Compact, choose(466f))
    }

    @Test
    fun `a phone on its side goes full-bleed by height, only with a video`() {
        // A 891 dp landscape Pixel is an *expanded* window on Android; height says phone.
        assertEquals(StageLayout.FullBleed, choose(843f, landscape = true, height = 411))
        assertEquals("replay only: nothing to fill a window with", StageLayout.Medium, choose(843f, landscape = true, height = 411, video = false))
        assertEquals("a tablet in landscape stands taller", StageLayout.Wide, choose(1250f, landscape = true, height = 800))
        assertEquals(StageLayout.Compact, choose(379f, landscape = false, height = 891))
        assertEquals(StageLayout.FullBleed, choose(843f, landscape = true, height = 479))
        assertEquals(StageLayout.Medium, choose(843f, side = false, landscape = true, height = 480))
    }

    @Test
    fun `postures outrank width, and tabletop is never full-bleed`() {
        assertEquals(StageLayout.Tabletop, choose(1200f, posture = FoldPosture.Tabletop))
        assertEquals(StageLayout.Tabletop, choose(843f, posture = FoldPosture.Tabletop, landscape = true, height = 400))
        assertEquals(StageLayout.Book, choose(1200f, posture = FoldPosture.Book))
        assertEquals(StageLayout.Book, choose(500f, posture = FoldPosture.Book, video = false))
    }
}
