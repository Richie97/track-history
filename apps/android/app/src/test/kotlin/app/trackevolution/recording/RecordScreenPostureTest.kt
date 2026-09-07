package app.trackevolution.recording

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import app.trackevolution.core.LiveTimingDisplay
import app.trackevolution.ui.FoldGeometry
import app.trackevolution.ui.FoldPosture
import app.trackevolution.ui.Folds
import app.trackevolution.ui.theme.TrackTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The tabletop-posture record screen (spec: NS-34 ticket 4).
 *
 * The posture is a parameter, so this needs no foldable, no emulator profile and
 * no `WindowLayoutInfoPublisherRule` — see `FoldsTest` for the other half of that
 * split. What is asserted is **geometry**, not pixels: which half of the screen
 * each thing is in, and that nothing sits across the crease.
 */
@RunWith(RobolectricTestRunner::class)
class RecordScreenPostureTest {

    @get:Rule
    val compose = createComposeRule()

    private val recording = RecorderState(
        isRecording = true,
        fixCount = 420,
        elapsedS = 132.0,
        lastSpeedMps = 40.0,
        lastAccuracyM = 4.0,
        lastFixAtMs = System.currentTimeMillis(),
        timing = LiveTimingDisplay(
            lapCount = 2,
            currentLapS = 41.2,
            lastLapMs = 118_400,
            bestLapMs = 116_900,
            deltaS = -0.42,
        ),
    )

    private fun show(fold: FoldGeometry, state: RecorderState = recording) {
        compose.setContent {
            TrackTheme {
                RecordScreen(
                    state = state,
                    isAttached = true,
                    eventLabel = "Summit Point",
                    onStart = {},
                    onStop = {},
                    fold = fold,
                )
            }
        }
        compose.waitForIdle()
    }

    /**
     * The read-out above the crease, the controls below it — and, the part that
     * matters on a device with a physical gap in the middle, **nothing spanning
     * it**.
     */
    @Config(qualifiers = "w900dp-h1000dp")
    @Test
    fun `tabletop puts the timing above the hinge and the controls below`() {
        show(FoldGeometry(FoldPosture.Tabletop, 0.5f))

        val delta = compose.onNodeWithText("−0.42").getBoundsInRoot()
        val button = compose.onNodeWithText("Stop").getBoundsInRoot()
        val attachment = compose.onNodeWithText("Laps will be saved to Summit Point.")
            .getBoundsInRoot()

        assertTrue(
            "the predictive delta belongs in the half you glance at, above the crease",
            delta.bottom < button.top,
        )
        assertTrue(
            "the event line belongs with the controls, below the crease",
            attachment.top > delta.bottom,
        )
    }

    /** A hinge off the midpoint moves the split, rather than halving the window. */
    @Config(qualifiers = "w900dp-h1000dp")
    @Test
    fun `the split follows the hinge`() {
        show(FoldGeometry(FoldPosture.Tabletop, 0.65f))
        val delta = compose.onNodeWithText("−0.42").getBoundsInRoot()
        val button = compose.onNodeWithText("Stop").getBoundsInRoot()
        assertTrue(delta.bottom < button.top)
        assertTrue(
            "with more room above the crease, the read-out sits lower than it would at the midpoint",
            delta.top.value > 100f,
        )
    }

    /**
     * Every other posture is the layout that shipped — including a flat foldable,
     * which is just a wide phone. The order is the phone's: the heading first,
     * the timing under the fix-quality card, the button last.
     */
    @Config(qualifiers = "w411dp-h891dp")
    @Test
    fun `flat is the phone layout, unchanged`() {
        show(Folds.FLAT)

        compose.onNodeWithText("Recording").assertIsDisplayed()
        val heading = compose.onNodeWithText("Recording").getBoundsInRoot()
        val delta = compose.onNodeWithText("−0.42").getBoundsInRoot()
        val button = compose.onNodeWithText("Stop").getBoundsInRoot()

        assertTrue("the heading is first", heading.bottom < delta.top)
        assertTrue("and the button last", delta.bottom < button.top)
    }

    /** Book posture is not the recorder's shape — it gets the ordinary layout. */
    @Config(qualifiers = "w900dp-h1000dp")
    @Test
    fun `book posture is left alone`() {
        show(FoldGeometry(FoldPosture.Book, 0.5f))
        compose.onNodeWithText("Recording").assertIsDisplayed()
        val heading = compose.onNodeWithText("Recording").getBoundsInRoot()
        val delta = compose.onNodeWithText("−0.42").getBoundsInRoot()
        assertTrue("the heading is still first, as on a phone", heading.bottom < delta.top)
    }

    /** Not at track pace yet: the hint takes the timing's place, in both postures. */
    @Config(qualifiers = "w900dp-h1000dp")
    @Test
    fun `tabletop before the timing arms still offers the controls`() {
        show(
            FoldGeometry(FoldPosture.Tabletop, 0.5f),
            recording.copy(timing = LiveTimingDisplay(0, null, null, null, null)),
        )
        compose.onNodeWithText("Stop").assertIsDisplayed()
        compose.onNodeWithText(
            "Lap timing arms once you're at track pace; laps count from your first flying pass."
        ).assertIsDisplayed()
    }
}
