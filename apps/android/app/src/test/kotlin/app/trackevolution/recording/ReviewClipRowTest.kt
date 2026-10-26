package app.trackevolution.recording

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import app.trackevolution.core.model.ClipStorage
import app.trackevolution.core.telemetry.LapClips
import app.trackevolution.core.telemetry.LapClips.ClipOffer
import app.trackevolution.core.telemetry.LapClips.ClipScope
import app.trackevolution.core.telemetry.ParsedLap
import app.trackevolution.core.telemetry.ParsedTelemetry
import app.trackevolution.ui.theme.TrackTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The review's *Save lap videos* row (NS-50): the Best lap / Every lap choice
 * under the switch, drawn only when Every lap would save more, disabled with
 * `everyLapFullText` when it alone would go over.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReviewClipRowTest {

    @get:Rule
    val compose = createComposeRule()

    private val storage = ClipStorage(usedBytes = 0, quotaBytes = 50L * 1024 * 1024 * 1024, coachCount = 0)

    private val state = ReviewUiState(
        items = listOf(
            ReviewItem(
                file = "pdr.mp4",
                parsed = ParsedTelemetry(
                    kind = ParsedTelemetry.Kind.PDR,
                    durationS = 1000.0,
                    laps = listOf(
                        ParsedLap(timeMs = 101_000, estimated = false, startT = 10.0, endT = 111.0),
                        ParsedLap(timeMs = 100_000, estimated = false, startT = 111.0, endT = 211.0),
                    ),
                ),
                include = true,
                label = "Session 1",
                fileBytes = 5_000_000_000,
            ),
        ),
        isImport = true,
        forNewEvent = true,
    )

    private fun show(everyLapOffer: ClipOffer, scope: ClipScope = ClipScope.BEST, onScope: (ClipScope) -> Unit = {}) {
        compose.setContent {
            TrackTheme {
                ReviewScreen(
                    state = state,
                    onPick = {},
                    onLabelChange = { _, _ -> },
                    onIncludeChange = { _, _ -> },
                    onNotesChange = {},
                    onSelectEvent = {},
                    onSave = {},
                    onDiscard = {},
                    clipOffer = ClipOffer.ON,
                    clipStorage = storage,
                    everyLapOffer = everyLapOffer,
                    clipScope = scope,
                    onClipScopeChange = onScope,
                )
            }
        }
    }

    @Test
    fun `without the choice the row is NS-45's`() {
        show(ClipOffer.NONE)
        compose.onNodeWithText("Save best-lap video").performScrollTo()
        compose.onNodeWithTag("reviewClipScopeEvery").assertDoesNotExist()
    }

    @Test
    fun `the choice starts on best lap and picks every lap`() {
        val picked = mutableListOf<ClipScope>()
        show(ClipOffer.ON) { picked += it }
        compose.onNodeWithText("Save lap videos").performScrollTo()
        compose.onNodeWithTag("reviewClipScopeBest").assertIsSelected()
        compose.onNodeWithText(LapClips.clipOfferText(state.clipEstimateBytes), substring = true).assertExists()
        compose.onNodeWithTag("reviewClipScopeEvery").performScrollTo().assertIsEnabled().performClick()
        assertEquals(listOf(ClipScope.EVERY), picked)
    }

    @Test
    fun `every lap picked says how many clips and how big`() {
        show(ClipOffer.ON, scope = ClipScope.EVERY)
        compose.onNodeWithTag("reviewClipScopeEvery").performScrollTo().assertIsSelected()
        val text = LapClips.everyLapOfferText(state.clipCount(ClipScope.EVERY), state.clipBytes(ClipScope.EVERY))
        assertEquals(2, state.clipCount(ClipScope.EVERY))
        compose.onNodeWithText(text, substring = true).assertExists()
    }

    @Test
    fun `every lap over the quota is drawn disabled, saying so`() {
        show(ClipOffer.FULL)
        compose.onNodeWithTag("reviewClipScopeEvery").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText(LapClips.everyLapFullText(storage)).assertExists()
        compose.onNodeWithTag("reviewClipScopeBest").assertIsSelected()
    }
}
