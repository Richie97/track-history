package app.trackevolution.ui.charts

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performMouseInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.performClick
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.ui.theme.TrackTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The distance-axis charts answer a tap (NS-51): before this, `ChannelPlot`
 * and `DeltaPlot` had no pointer input at all, so the lap page's "Tap a chart"
 * hint was untrue. With a stage a tap seeks it and the panel's own cursor is
 * off; without one it parks the cursor (`ChannelCursorTest`).
 * A mouse drags to scrub; a finger never does.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w400dp-h900dp")
class ChartSeekTest {

    @get:Rule
    val compose = createComposeRule()

    private val n = 40
    private val channels = SessionChannels(
        v = 1,
        dStepM = 20.0,
        laps = listOf(
            LapChannels(1, 121_900, speed = List(n) { 100.0 + it }),
            LapChannels(2, 120_400, speed = List(n) { 104.0 + it }),
        ),
    )
    private val laps = listOf(
        Lap(id = 1, sessionId = 1, lapNum = 1, timeMs = 121_900),
        Lap(id = 2, sessionId = 1, lapNum = 2, timeMs = 120_400),
    )

    @Test
    fun `a tap on the speed chart seeks to the grid index under it`() {
        val seeks = mutableListOf<Double>()
        compose.setContent {
            TrackTheme {
                LapChannelChart(channels = channels, laps = laps, onSeek = { seeks += it })
            }
        }
        val chart = compose.onNodeWithTag("channelChart:speed")
        chart.performTouchInput { click(Offset(width - 1f, centerY)) }
        compose.runOnIdle { assertEquals((n - 1).toDouble(), seeks.last(), 1e-9) }
        chart.performTouchInput { click(Offset(1f, centerY)) }
        compose.runOnIdle { assertEquals("left of the plot clamps to the line", 0.0, seeks.last(), 1e-9) }
        chart.performTouchInput { click(center) }
        compose.runOnIdle { assertTrue(seeks.last() > 0.0 && seeks.last() < n - 1) }
    }

    @Test
    fun `the delta chart answers a tap too`() {
        val seeks = mutableListOf<Double>()
        compose.setContent {
            TrackTheme {
                LapChannelChart(channels = channels, laps = laps, initialSelection = listOf(0, 1), onSeek = { seeks += it })
            }
        }
        compose.onNodeWithTag("channelChart:delta").performTouchInput { click(Offset(width - 1f, centerY)) }
        compose.runOnIdle { assertEquals((n - 1).toDouble(), seeks.single(), 1e-9) }
    }

    @Test
    fun `on a stage the cursor is off - a tap seeks and nothing is parked or put on a map`() {
        val seeks = mutableListOf<Double>()
        val dots = mutableListOf<List<MapDot>?>()
        compose.setContent {
            TrackTheme {
                LapChannelChart(
                    channels = channels,
                    laps = laps,
                    onSeek = { seeks += it },
                    onCursor = { dots += it },
                )
            }
        }
        compose.onNodeWithTag("channelChart:speed").performTouchInput { click(center) }
        compose.runOnIdle {
            assertEquals(1, seeks.size)
            assertTrue("no cursor dots on a stage", dots.all { it == null })
        }
        compose.onNodeWithTag("channelCursorBar").assertDoesNotExist()
    }

    @Test
    fun `on a time axis a tap seeks to the grid index where side A's time reaches it`() {
        val seeks = mutableListOf<Double>()
        val playhead = mutableStateOf<LapPlayhead?>(LapPlayhead(0.0, aLap = 1))
        compose.setContent {
            TrackTheme {
                LapChannelChart(channels = channels, laps = laps, playhead = playhead, onSeek = { seeks += it })
            }
        }
        compose.onNodeWithTag("axis:time").performClick()
        // The right edge is the longest lap's end — past A's own (lap 2 is the
        // faster), so it clamps to A's last grid point.
        compose.onNodeWithTag("channelChart:speed").performTouchInput { click(Offset(width - 1f, centerY)) }
        compose.runOnIdle { assertEquals((n - 1).toDouble(), seeks.last(), 1e-9) }
        compose.onNodeWithTag("channelChart:speed").performTouchInput { click(center) }
        compose.runOnIdle { assertTrue(seeks.last() > 0.0 && seeks.last() < n - 1) }
    }

    @Test
    fun `a mouse drag scrubs and its release seeks exactly`() {
        val scrubs = mutableListOf<Double>()
        val seeks = mutableListOf<Double>()
        compose.setContent {
            TrackTheme {
                LapChannelChart(
                    channels = channels,
                    laps = laps,
                    onSeek = { seeks += it },
                    onScrub = { scrubs += it },
                )
            }
        }
        compose.onNodeWithTag("channelChart:speed").performMouseInput {
            moveTo(Offset(width * 0.3f, centerY))
            press()
            moveTo(Offset(width * 0.5f, centerY))
            moveTo(Offset(width * 0.7f, centerY))
            release()
        }
        compose.runOnIdle {
            assertTrue("pressed moves scrub", scrubs.size >= 2)
            assertTrue(scrubs.zipWithNext().all { (a, b) -> b > a })
            assertEquals("one exact seek on release, no tap on top", 1, seeks.size)
        }
    }

    @Test
    fun `the playhead draws in the draw phase and survives being moved and cleared`() {
        val playhead = mutableStateOf<LapPlayhead?>(LapPlayhead(5.0))
        compose.setContent {
            TrackTheme {
                LapChannelChart(
                    channels = channels,
                    laps = laps,
                    initialSelection = listOf(0, 1),
                    playhead = playhead,
                    onSeek = {},
                )
            }
        }
        compose.onNodeWithTag("channelChart:speed").assertIsDisplayed()
        compose.runOnIdle { playhead.value = LapPlayhead(20.0, mapOf(1 to 18.0)) }
        compose.onNodeWithTag("channelChart:delta").assertIsDisplayed()
        compose.runOnIdle { playhead.value = null }
        compose.onNodeWithTag("channelChart:speed").assertIsDisplayed()
    }
}
