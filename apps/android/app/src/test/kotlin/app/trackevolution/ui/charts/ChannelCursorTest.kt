package app.trackevolution.ui.charts

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.click
import androidx.compose.ui.test.performTouchInput
import app.trackevolution.core.ChannelGraphs
import app.trackevolution.core.TraceSample
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import kotlin.math.cos
import kotlin.math.sin

/**
 * The Traces tab, the Distance / Time switch and the cursor (the web's
 * `lap-axis.js` change): the tab enum against `contracts/logic/lap-axis.json`,
 * a tap parking the cursor and Clear dropping it, the map's dot per lit lap, the
 * axis switch saying which axis the charts are on, and the cursor's TalkBack
 * actions.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp")
class ChannelCursorTest {

    @get:Rule
    val compose = createComposeRule()

    private fun lap(num: Int, ms: Int) = Lap(id = num, sessionId = 1, lapNum = num, timeMs = ms)
    private fun ramp(n: Int, scale: Double = 100.0): List<Double> =
        (0 until n).map { scale * (0.6 + 0.4 * sin(it / 5.0)) }

    private val channels = SessionChannels(
        v = 1,
        dStepM = 20.0,
        laps = listOf(
            LapChannels(1, 121_900, speed = ramp(40), throttle = ramp(40)),
            LapChannels(2, 120_400, speed = ramp(40, 110.0), throttle = ramp(40)),
        ),
    )
    private val laps = listOf(lap(1, 121_900), lap(2, 120_400))

    private val circuit: List<TraceSample> = (0 until 120).map { i ->
        val a = i / 120.0 * 2 * Math.PI
        TraceSample(x = cos(a) * 400, y = sin(a) * 250, v = 25.0 + 15.0 * sin(a * 2))
    }

    private fun description(tag: String): String =
        compose.onNodeWithTag(tag).fetchSemanticsNode().config[SemanticsProperties.ContentDescription].first()

    // ---- the tabs, pinned to the web ---------------------------------------

    @Test
    fun `the tabs and where each chart goes match the web`() {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null && !File(dir, "package.json").isFile) dir = dir.parentFile
        val fixture = Json.parseToJsonElement(File(dir, "contracts/logic/lap-axis.json").readText()).jsonObject
        val constants = fixture["constants"]!!.jsonObject

        val tabs = constants["tabs"]!!.jsonArray.map { it.jsonObject }
        assertEquals(tabs.map { it["key"]!!.jsonPrimitive.content }, PanelTab.entries.map { it.key })
        assertEquals(tabs.map { it["label"]!!.jsonPrimitive.content }, PanelTab.entries.map { it.label })

        val tabOf = constants["tabOf"]!!.jsonObject
        for ((key, tab) in tabOf) {
            val want = tab.jsonPrimitive.content
            val got = if (key == "delta") PanelTab.DELTA else PanelTab.of(ChannelGraphs.Channel.entries.first { it.key == key })
            assertEquals("tabOf.$key", want, got.key)
        }
        // Every charted channel is placed by the fixture, none left to a default.
        assertEquals(ChannelGraphs.Channel.entries.map { it.key }.toSet(), tabOf.keys - "delta")
    }

    // ---- the cursor --------------------------------------------------------

    @Test
    fun `a tap on a trace parks the cursor, and Clear drops it`() {
        var reported: List<MapDot>? = null
        compose.setContent {
            TrackTheme {
                LapChannelChart(
                    channels = channels,
                    laps = laps,
                    initialSelection = listOf(0, 1),
                    onCursor = { reported = it },
                )
            }
        }
        compose.onNodeWithTag("channelCursorBar").assertDoesNotExist()
        compose.onNodeWithTag("channelChart:throttle").performTouchInput { click(center) }
        compose.onNodeWithTag("channelCursorBar").assertExists()
        compose.onNodeWithText("Marked at", substring = true).assertExists()
        // One dot per lit lap for a map beside the panel, in the lap's colour.
        assertEquals(2, reported?.size)
        // The values under the line, said as well as drawn.
        val said = description("channelChart:throttle")
        assertTrue(said, said.contains("Marked at") && said.contains("lap 1") && said.contains("lap 2"))

        compose.onNodeWithText("Clear").performClick()
        compose.onNodeWithTag("channelCursorBar").assertDoesNotExist()
        compose.waitForIdle()
        assertEquals(null, reported)
    }

    @Test
    fun `with a trace the panel draws its own map, a dot per lit lap`() {
        compose.setContent {
            TrackTheme {
                LapChannelChart(channels = channels, laps = laps, initialSelection = listOf(0, 1), trace = circuit)
            }
        }
        compose.onNodeWithTag("trackMap").assertExists()
        assertTrue(!description("trackMap").contains("marked"))
        compose.onNodeWithTag("channelChart:speed").performTouchInput { click(center) }
        assertTrue(description("trackMap"), description("trackMap").contains("2 marked places"))
    }

    @Test
    fun `the cursor is reachable without a tap`() {
        compose.setContent {
            TrackTheme { LapChannelChart(channels = channels, laps = laps) }
        }
        val node = compose.onNodeWithTag("channelChart:speed")
        val actions = node.fetchSemanticsNode().config[SemanticsActions.CustomActions].map { it.label }
        assertTrue(actions.toString(), "Mark further round the lap" in actions)
        val forward = node.fetchSemanticsNode().config[SemanticsActions.CustomActions]
            .first { it.label == "Mark further round the lap" }
        compose.runOnIdle { forward.action() }
        compose.onNodeWithTag("channelCursorBar").assertExists()
        val after = compose.onNodeWithTag("channelChart:speed").fetchSemanticsNode()
            .config[SemanticsActions.CustomActions].map { it.label }
        assertTrue(after.toString(), "Clear the mark" in after)
    }

    // ---- the axis switch ---------------------------------------------------

    @Test
    fun `the time axis says so, and switching drops a parked cursor`() {
        compose.setContent {
            TrackTheme { LapChannelChart(channels = channels, laps = laps, initialSelection = listOf(0, 1)) }
        }
        assertTrue(description("channelChart:speed").startsWith("Speed by distance"))
        compose.onNodeWithTag("channelChart:speed").performTouchInput { click(center) }
        compose.onNodeWithTag("channelCursorBar").assertExists()

        compose.onNodeWithTag("axis:time").performClick()
        val said = description("channelChart:speed")
        assertTrue(said, said.startsWith("Speed by time over"))
        compose.onNodeWithTag("channelCursorBar").assertDoesNotExist()
        assertTrue(description("channelChart:delta").contains("by time"))

        // A tap on the time axis says the place as a time.
        compose.onNodeWithTag("channelChart:speed").performTouchInput { click(center) }
        val bar = compose.onNodeWithText("Marked at", substring = true).fetchSemanticsNode()
            .config[SemanticsProperties.Text].joinToString { it.text }
        assertTrue(bar, Regex("Marked at \\d+:\\d\\d\\.\\d").matches(bar))
    }

    @Test
    fun `a session with no speed offers no time axis`() {
        compose.setContent {
            TrackTheme {
                LapChannelChart(
                    channels = SessionChannels(1, 20.0, listOf(LapChannels(1, 121_900, throttle = ramp(40)))),
                    laps = listOf(lap(1, 121_900)),
                )
            }
        }
        compose.onNodeWithTag("channelChart:throttle").assertExists()
        compose.onNodeWithTag("channelAxis").assertDoesNotExist()
    }
}
