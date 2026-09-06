package app.trackevolution

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import app.trackevolution.ui.LayoutClass
import app.trackevolution.ui.LocalLayoutMetrics
import app.trackevolution.ui.ProvideLayoutMetrics
import app.trackevolution.ui.TwoPaneShell
import app.trackevolution.ui.theme.TrackTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * List beside detail, or detail alone (spec: NS-34 ticket 2).
 *
 * The spec's acceptance asks for exactly this pair — `w840dp` shows two panes,
 * `w600dp` shows one — and it is worth having as a test rather than a look,
 * because the failure mode is a *layout*: at the wrong width the list either
 * covers the detail or squeezes it, and nothing throws either way.
 *
 * The panes are identified by content and compared by position, which is the
 * claim that actually matters: two panes means the list is to the **left** of the
 * detail and both are on screen at once.
 */
@RunWith(RobolectricTestRunner::class)
class TwoPaneShellTest {

    @get:Rule
    val compose = createComposeRule()

    @Test
    @Config(qualifiers = "w1000dp-h800dp")
    fun `an expanded window shows the list beside the detail`() {
        showShell()

        compose.onNodeWithText(LIST).assertIsDisplayed()
        compose.onNodeWithText(DETAIL).assertIsDisplayed()

        val list = compose.onNodeWithText(LIST).getBoundsInRoot()
        val detail = compose.onNodeWithText(DETAIL).getBoundsInRoot()
        assertTrue(
            "the list pane should sit left of the detail, got list=${list.left} detail=${detail.left}",
            list.left < detail.left,
        )
        // Side by side, not stacked: the list must end before the detail begins.
        assertTrue("the panes should not overlap", list.right <= detail.left)
    }

    /**
     * 600dp is *medium*, the top of the phone tier — the width at which the
     * column is capped and centred but there is still only one of it. A second
     * pane here would be the regression this test exists to catch.
     */
    @Test
    @Config(qualifiers = "w600dp-h900dp")
    fun `a medium window shows the detail alone`() {
        showShell()

        compose.onNodeWithText(DETAIL).assertIsDisplayed()
        compose.onNodeWithText(LIST).assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "w400dp-h900dp")
    fun `a phone shows the detail alone`() {
        showShell()

        compose.onNodeWithText(DETAIL).assertIsDisplayed()
        compose.onNodeWithText(LIST).assertDoesNotExist()
    }

    /**
     * The shell takes the two-pane decision as a *parameter* rather than reading
     * the width itself, which is what lets the scaffold drop to one pane for the
     * record screen at any width — the rule that keeps a phone-in-a-mount layout
     * off half a tablet.
     */
    @Test
    @Config(qualifiers = "w1000dp-h800dp")
    fun `a window-owning destination collapses to one pane even when wide`() {
        compose.setContent {
            ProvideLayoutMetrics {
                TrackTheme {
                    TwoPaneShell(twoPane = false, listPane = { Text(LIST) }) { Text(DETAIL) }
                }
            }
        }
        compose.onNodeWithText(DETAIL).assertIsDisplayed()
        compose.onNodeWithText(LIST).assertDoesNotExist()
    }

    private fun showShell() {
        compose.setContent {
            ProvideLayoutMetrics {
                val expanded = LocalLayoutMetrics.current.layoutClass ==
                    LayoutClass.Expanded
                TrackTheme {
                    TwoPaneShell(
                        twoPane = expanded,
                        listPane = { Text(LIST, modifier = Modifier.fillMaxSize()) },
                        detailPane = { Text(DETAIL, modifier = Modifier.fillMaxSize()) },
                    )
                }
            }
        }
        compose.waitForIdle()
    }

    private companion object {
        const val LIST = "the list pane"
        const val DETAIL = "the detail pane"
    }
}
