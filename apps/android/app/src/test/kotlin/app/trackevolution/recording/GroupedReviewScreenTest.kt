package app.trackevolution.recording

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import app.trackevolution.core.GpsPoint
import app.trackevolution.core.TracePoint
import app.trackevolution.core.TrackLocate
import app.trackevolution.core.TrackLocate.Confidence
import app.trackevolution.core.TrackLocate.Source
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
 * The grouped review (NS-57) as a screen: one card per event, the three ways a
 * card can stand — a track found, an existing event joined, a place to name —
 * and a known start/finish line said rather than asked for.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GroupedReviewScreenTest {

    @get:Rule
    val compose = createComposeRule()

    private fun item(file: String, date: String) = ReviewItem(
        file = file,
        parsed = ParsedTelemetry(
            kind = ParsedTelemetry.Kind.PDR,
            date = date,
            time = "10:00",
            durationS = 600.0,
            laps = listOf(ParsedLap(timeMs = 121_300, estimated = false), ParsedLap(timeMs = 120_000, estimated = false)),
        ),
        include = true,
        label = "PDR 10:00",
    )

    private fun group(key: String, track: TrackLocate.GroupTrack?, ids: List<Int>, eventId: Int? = null, days: Int = 1) = TrackLocate.Group(
        key = key,
        eventId = eventId,
        track = track,
        confidence = if (track == null) Confidence.NONE else Confidence.EXACT,
        candidates = emptyList(),
        venueOnly = false,
        start = "2026-03-14",
        days = days,
        itemIds = ids,
    )

    private val trace = (0 until 40).map { TracePoint(it.toDouble(), it * 10.0, it * 3.0, 30.0) }

    private val state = ReviewUiState(
        items = listOf(item("sat.mp4", "2026-03-14"), item("sun.mp4", "2026-03-15"), item("joined.mp4", "2026-03-14"), item("farm.mp4", "2026-03-14")),
        isImport = true,
        auto = true,
        placesLoaded = true,
        groups = listOf(
            group("catalog:1@2026-03-14", TrackLocate.GroupTrack(Source.CATALOG, 1, "Virginia International Raceway (Full)"), listOf(0, 1), days = 2),
            group("event:7", TrackLocate.GroupTrack(Source.OWN, 13, "Summit Point"), listOf(2), eventId = 7),
            group("place:0@2026-03-14", null, listOf(3)),
        ),
        venuePickers = listOf(
            VenuePicker(place = null, itemIndexes = emptyList(), origin = GpsPoint(0.0, 36.5, -79.2, null), pickTrace = trace, lineFrom = "The Oval"),
        ),
    )

    private fun show(state: ReviewUiState = this.state, onChoose: (String, String) -> Unit = { _, _ -> }, onEdit: (String) -> Unit = {}) {
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
                    onChooseTrack = onChoose,
                    onEditGroup = onEdit,
                )
            }
        }
    }

    @Test
    fun `each event is a card saying where its sessions go`() {
        show()
        compose.onNodeWithText("4 files · 3 events found").assertExists()
        compose.onNodeWithText("Virginia International Raceway (Full)").performScrollTo().assertExists()
        compose.onNodeWithText("New event at a new track · 2 sessions · 4 laps · best 2:00.0").assertExists()
        compose.onNodeWithText("Summit Point").performScrollTo().assertExists()
        compose.onNodeWithText("Adds to your event on", substring = true).assertExists()
        compose.onNodeWithText("Which track is this?").performScrollTo().assertExists()
        compose.onNodeWithText("No track we know is here. Name it once and it is recognised next time.", substring = true).assertExists()
        // Two of the three have a track: those are what a save posts.
        compose.onNodeWithTag("reviewSave").performScrollTo().assertIsEnabled()
        compose.onNodeWithText("Save 2 events").assertExists()
        // No event picker: the cards are the answer.
        compose.onNodeWithText("SAVE TO").assertDoesNotExist()
    }

    @Test
    fun `an unknown place is named on its card`() {
        val chosen = mutableListOf<Pair<String, String>>()
        show(onChoose = { key, name -> chosen += key to name })
        val key = "place:0@2026-03-14"
        compose.onNodeWithTag("groupNameUse:$key").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("groupName:$key").performTextInput("The Farm")
        compose.onNodeWithTag("groupNameUse:$key").assertIsEnabled().performClick()
        assertEquals(listOf(key to "The Farm"), chosen)
    }

    @Test
    fun `a found track can be changed`() {
        val edited = mutableListOf<String>()
        show(onEdit = { edited += it })
        compose.onNodeWithTag("group:event:7").performScrollTo()
        compose.onNodeWithTag("groupName:event:7").assertDoesNotExist()
        compose.onNodeWithTag("group:catalog:1@2026-03-14").performScrollTo()
        // Two cards carry Change; the first is the catalog match's.
        compose.onNodeWithTag("groupChange:catalog:1@2026-03-14").performScrollTo().performClick()
        assertEquals(listOf("catalog:1@2026-03-14"), edited)
    }

    @Test
    fun `a line the app already had is said, not asked for`() {
        show()
        compose.onNodeWithTag("venuePickerHint0").performScrollTo()
        compose.onNodeWithText("Start/finish from your last session at The Oval. Tap the trace to use a different line.").assertExists()
    }

    @Test
    fun `with nothing answered there is nothing to save`() {
        show(state.copy(groups = state.groups.takeLast(1)))
        compose.onNodeWithTag("reviewSave").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("Save 0 events").assertExists()
    }
}
