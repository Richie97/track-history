package app.trackevolution.ui.charts

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.ui.ProvideLayoutMetrics
import app.trackevolution.ui.theme.TrackTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The health strip's per-lap table (spec: NS-34 ticket 3).
 *
 * The table is the reduction the cards perform, undone — and it exists only where
 * there is room for it. Both halves are worth asserting, and the *absence* more
 * than the presence: the phone card is what almost every user sees, and fifteen
 * columns leaking into it is precisely the regression this guards.
 */
@RunWith(RobolectricTestRunner::class)
class HealthTableTest {

    @get:Rule
    val compose = createComposeRule()

    @Test
    @Config(qualifiers = "w1100dp-h900dp")
    fun `an expanded window shows the figures per lap`() {
        show()
        assertTrue(
            "the per-lap table should be drawn",
            compose.onAllNodesWithText("Per lap").fetchSemanticsNodes().isNotEmpty(),
        )
        // Both laps get a row, not just the highlighted one — the cards above
        // already reduce to one number, so a one-row table would say nothing new.
        assertTrue(compose.onAllNodesWithText("Lap 1").fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodesWithText("Lap 2").fetchSemanticsNodes().isNotEmpty())
    }

    @Test
    @Config(qualifiers = "w400dp-h900dp")
    fun `a phone keeps the cards and no table`() {
        show()
        assertEquals(
            "fifteen columns is a desk layout and must not reach a phone",
            0,
            compose.onAllNodesWithText("Per lap").fetchSemanticsNodes().size,
        )
    }

    @Test
    @Config(qualifiers = "w600dp-h900dp")
    fun `a medium window keeps the cards and no table`() {
        show()
        assertEquals(0, compose.onAllNodesWithText("Per lap").fetchSemanticsNodes().size)
    }

    private fun show() {
        compose.setContent {
            ProvideLayoutMetrics {
                TrackTheme {
                    HealthStrip(
                        channels = channels,
                        lit = listOf(0),
                        slots = listOf(TrackTheme.colors.chartLine),
                        lapNumber = { it + 1 },
                    )
                }
            }
        }
        compose.waitForIdle()
    }

    private companion object {
        /** Two laps carrying oil temperature, which is enough for a column. */
        val channels = SessionChannels(
            v = 1,
            dStepM = 20.0,
            laps = listOf(
                LapChannels(n = 1, timeMs = 90_000, oilC = 120.0),
                LapChannels(n = 2, timeMs = 91_000, oilC = 128.0),
            ),
        )
    }
}
