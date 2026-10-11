package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.trackevolution.core.model.EventDetail
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

/**
 * The setup notebook starts collapsed, as the web's `<details>` does: one header
 * saying what is inside, the day sheets behind a tap — for Pro and free alike.
 * Drawn over the golden contract's event detail, which carries sheets.
 */
@RunWith(RobolectricTestRunner::class)
class SetupNotebookCardTest {

    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `the collapsed card says what is inside as the web does`() {
        assertEquals("Pro", setupNotebookSummary(pro = false, sheetCount = 2))
        assertEquals("pressures, alignment, dampers…", setupNotebookSummary(pro = true, sheetCount = 0))
        assertEquals("1 day sheet", setupNotebookSummary(pro = true, sheetCount = 1))
        assertEquals("3 day sheets", setupNotebookSummary(pro = true, sheetCount = 3))
    }

    @Test
    fun `the notebook opens collapsed and a tap shows and hides the days`() {
        show(pro = true)
        compose.onNodeWithText(setupNotebookSummary(true, detail.setups.size)).assertIsDisplayed()
        assertTrue(compose.onAllNodesWithTag("setupDay-1").fetchSemanticsNodes().isEmpty())

        compose.onNodeWithTag("setupNotebookToggle").performClick()
        compose.onNodeWithTag("setupDay-1").assertIsDisplayed()

        compose.onNodeWithTag("setupNotebookToggle").performClick()
        assertTrue(compose.onAllNodesWithTag("setupDay-1").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun `a free account's card is collapsed too and opens onto the offer`() {
        var subscribed = 0
        show(pro = false, onSubscribe = { subscribed++ })
        compose.onNodeWithText("Pro").assertIsDisplayed()
        assertTrue(compose.onAllNodesWithText("See Track Evolution Pro").fetchSemanticsNodes().isEmpty())

        compose.onNodeWithTag("setupNotebookToggle").performClick()
        compose.onNodeWithText("See Track Evolution Pro").performClick()
        assertEquals(1, subscribed)
        assertTrue(compose.onAllNodesWithTag("setupDay-1").fetchSemanticsNodes().isEmpty())
    }

    private fun show(pro: Boolean, onSubscribe: () -> Unit = {}) {
        compose.setContent {
            TrackTheme {
                var open by remember { mutableStateOf(false) }
                SetupNotebookCard(
                    event = detail.event,
                    setups = detail.setups,
                    sessions = detail.sessions,
                    parts = emptyList(),
                    targetHotPsi = null,
                    units = UnitSystem.IMPERIAL,
                    pro = pro,
                    expanded = open,
                    onToggle = { open = !open },
                    onSubscribe = onSubscribe,
                    onOpenDay = {},
                    onRecordHots = { _, _ -> },
                    onSetNextCold = { _, _ -> },
                )
            }
        }
    }

    private companion object {
        private val repoRoot: File = run {
            var candidate: File? = File(System.getProperty("user.dir")).absoluteFile
            while (candidate != null) {
                if (File(candidate, "package.json").isFile) return@run candidate
                candidate = candidate.parentFile
            }
            error("repository root not found above ${System.getProperty("user.dir")}")
        }

        val detail: EventDetail = Json.decodeFromString(
            Json.parseToJsonElement(File(repoRoot, "contracts/golden/event-detail.json").readText())
                .jsonObject["body"]!!.toString(),
        )
    }
}
