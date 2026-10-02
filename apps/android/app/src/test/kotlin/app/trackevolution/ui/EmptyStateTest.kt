package app.trackevolution.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.trackevolution.ui.theme.TrackTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The empty-state component and the one retry (#342): the one-argument form
 * every screen used before is still the sentence alone, a title and an action
 * draw when given, and a failed load says "Try again" — never "Retry", and never
 * on an answer that is final.
 */
@RunWith(RobolectricTestRunner::class)
class EmptyStateTest {

    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `the sentence alone draws no title and no button`() {
        compose.setContent { TrackTheme { TEEmpty("No sessions recorded yet.") } }
        compose.onNodeWithText("No sessions recorded yet.").assertIsDisplayed()
        assertTrue(compose.onAllNodesWithTag("emptyAction").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun `a title and an action draw, and the action runs`() {
        var ran = 0
        compose.setContent {
            TrackTheme {
                TEEmpty(
                    "Add an event and its laps, bests and progress start here.",
                    title = "No events yet",
                    action = TEEmptyAction("Add your first event") { ran++ },
                )
            }
        }
        compose.onNodeWithText("No events yet").assertIsDisplayed()
        compose.onNodeWithText("Add your first event").performClick()
        assertEquals(1, ran)
    }

    @Test
    fun `a failed load offers Try again and runs the retry`() {
        var retried = 0
        compose.setContent {
            TrackTheme {
                TELoadable(state = LoadState.Failed("No connection."), onRetry = { retried++ }) {}
            }
        }
        compose.onNodeWithText("No connection.").assertIsDisplayed()
        compose.onNodeWithText("Try again").assertIsDisplayed()
        assertTrue(compose.onAllNodesWithText("Retry").fetchSemanticsNodes().isEmpty())
        compose.onNodeWithTag("retry").performClick()
        assertEquals(1, retried)
    }

    @Test
    fun `a final answer offers no retry`() {
        compose.setContent {
            TrackTheme {
                TELoadable(state = LoadState.Failed("That event isn't in your logbook.", retryable = false), onRetry = {}) {}
            }
        }
        assertTrue(compose.onAllNodesWithTag("retry").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun `both detail placeholders share one layout`() {
        compose.setContent {
            TrackTheme {
                TEPanePlaceholder(title = "Pick a car", tag = "garagePlaceholder", mark = {}, text = "Its logbook opens here.")
            }
        }
        compose.onNodeWithTag("garagePlaceholder").assertIsDisplayed()
        compose.onNodeWithText("Pick a car").assertIsDisplayed()
        compose.onNodeWithText("Its logbook opens here.").assertIsDisplayed()
    }
}
