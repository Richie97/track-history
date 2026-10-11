package app.trackevolution.ui

import android.net.Uri
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.trackevolution.screens.GuidePage
import app.trackevolution.screens.TRACK_DAYS_GUIDE_LINK
import app.trackevolution.screens.TRACK_DAYS_GUIDE_URL
import app.trackevolution.screens.WELCOME_TEXT
import app.trackevolution.screens.WelcomeCard
import app.trackevolution.ui.theme.TrackTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        compose.onNodeWithText("Couldn't load this").assertIsDisplayed()
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
        compose.onNodeWithText("Not found").assertIsDisplayed()
        compose.onNodeWithText("That event isn't in your logbook.").assertIsDisplayed()
        assertTrue(compose.onAllNodesWithTag("retry").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun `a screen's own heading replaces the default one`() {
        compose.setContent {
            TrackTheme {
                TELoadable(
                    state = LoadState.Failed(
                        "This share link doesn't exist or has been disabled.",
                        retryable = false,
                        title = "Link not found",
                    ),
                    onRetry = {},
                ) {}
            }
        }
        compose.onNodeWithText("Link not found").assertIsDisplayed()
        assertTrue(compose.onAllNodesWithText("Not found").fetchSemanticsNodes().isEmpty())
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

    @Test
    fun `the welcome card offers an event and the recorder`() {
        var added = 0
        var recorded = 0
        compose.setContent {
            TrackTheme { WelcomeCard(onNewEvent = { added++ }, onRecord = { recorded++ }) }
        }
        compose.onNodeWithText("Welcome to Track Evolution").assertIsDisplayed()
        compose.onNodeWithText(WELCOME_TEXT).assertIsDisplayed()
        compose.onNodeWithTag("welcomeAddEvent").performClick()
        compose.onNodeWithTag("welcomeRecord").performClick()
        assertEquals(1, added)
        assertEquals(1, recorded)
    }

    @Test
    fun `the welcome card links a newcomer to the track-day guide`() {
        var opened = 0
        compose.setContent {
            TrackTheme { WelcomeCard(onNewEvent = {}, onRecord = null, onOpenGuide = { opened++ }) }
        }
        compose.onNodeWithText("$TRACK_DAYS_GUIDE_LINK ›").assertIsDisplayed()
        compose.onNodeWithTag("welcomeTrackDaysGuide").performClick()
        assertEquals(1, opened)
        assertEquals("https://docs.trackevolution.app/docs/track-days.html", TRACK_DAYS_GUIDE_URL)
    }

    @Test
    fun `a busy recorder leaves the welcome card one button`() {
        compose.setContent { TrackTheme { WelcomeCard(onNewEvent = {}, onRecord = null) } }
        compose.onNodeWithTag("welcomeAddEvent").assertIsDisplayed()
        assertTrue(compose.onAllNodesWithTag("welcomeRecord").fetchSemanticsNodes().isEmpty())
    }

    /**
     * The guide reads in the app's own web view: the docs site stays in it,
     * and everything else — an organizer, a mail link — goes to a Custom Tab.
     */
    @Test
    fun `the guide keeps the docs site and sends the rest out`() {
        assertTrue(GuidePage.opensInApp(Uri.parse("https://docs.trackevolution.app/docs/telemetry-import.html")))
        assertTrue(GuidePage.opensInApp(Uri.parse(TRACK_DAYS_GUIDE_URL)))
        assertFalse(GuidePage.opensInApp(Uri.parse("https://www.motorsportreg.com/")))
        assertFalse(GuidePage.opensInApp(Uri.parse("http://docs.trackevolution.app/docs/")))
        assertFalse(GuidePage.opensInApp(Uri.parse("mailto:eric@speedshift.io")))
        // The same mark `site/analytics.js` looks for, and iOS's `GuidePage`.
        assertEquals("TrackEvolution-App", GuidePage.USER_AGENT_MARK)
    }
}
