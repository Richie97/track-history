package app.trackevolution.ui.charts

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.onNodeWithText
import app.trackevolution.core.TraceSample
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.ui.theme.TrackTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.math.cos
import kotlin.math.sin

/**
 * The chart composables against the datasets that actually break charts.
 *
 * NS-24 asks for single-point, identical-value and empty inputs to render
 * without crashing. None of those is hypothetical: a new track has one event, a
 * consistent driver posts identical times, and a hand-entered session has no
 * channels at all. Every one of them divides by a span of zero somewhere if the
 * scale maths is wrong.
 *
 * Robolectric rather than instrumentation, so this runs in CI without an
 * emulator.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp")
class ChartRenderingTest {

    @get:Rule
    val compose = createComposeRule()

    private fun lap(num: Int, ms: Int) = Lap(id = num, sessionId = 1, lapNum = num, timeMs = ms)

    // ---- progress chart ----------------------------------------------------

    @Test
    fun `renders a normal progress chart`() {
        compose.setContent {
            TrackTheme {
                ProgressChart(
                    points = listOf(
                        ProgressPoint(1.0, "May 1", 125_000),
                        ProgressPoint(2.0, "Jun 1", 122_000),
                        ProgressPoint(3.0, "Jul 1", 121_000),
                    ),
                )
            }
        }
        compose.onNodeWithTag("progressChart").assertIsDisplayed()
    }

    @Test
    fun `renders a single point without dividing by a zero span`() {
        compose.setContent {
            TrackTheme { ProgressChart(points = listOf(ProgressPoint(1.0, "May 1", 121_000))) }
        }
        compose.onNodeWithTag("progressChart").assertIsDisplayed()
    }

    @Test
    fun `renders identical lap times`() {
        compose.setContent {
            TrackTheme {
                ProgressChart(
                    points = (1..4).map { ProgressPoint(it.toDouble(), "E$it", 120_000) },
                )
            }
        }
        compose.onNodeWithTag("progressChart").assertIsDisplayed()
    }

    @Test
    fun `draws nothing at all for an empty dataset`() {
        compose.setContent { TrackTheme { ProgressChart(points = emptyList()) } }
        // Not an empty chart frame — the caller decides what to say instead,
        // the same contract the web's "" return has.
        compose.onNodeWithTag("progressChart").assertDoesNotExist()
    }

    @Test
    fun `renders a sparkline`() {
        compose.setContent {
            TrackTheme {
                ProgressChart(
                    points = (1..5).map { ProgressPoint(it.toDouble(), "", 125_000 - it * 400) },
                    style = ProgressChartStyle.Sparkline,
                )
            }
        }
        compose.onNodeWithTag("progressSparkline").assertIsDisplayed()
    }

    @Test
    fun `renders a goal that is still unbeaten`() {
        compose.setContent {
            TrackTheme {
                ProgressChart(
                    points = listOf(ProgressPoint(1.0, "May", 125_000), ProgressPoint(2.0, "Jun", 122_000)),
                    goalMs = 118_000,
                )
            }
        }
        compose.onNodeWithTag("progressChart").assertIsDisplayed()
    }

    // ---- the accessibility summaries ---------------------------------------

    @Test
    fun `tells a screen reader which way the trend goes`() {
        val improving = trendSummary(
            listOf(ProgressPoint(1.0, "a", 125_000), ProgressPoint(2.0, "b", 121_000)),
            goalMs = null,
        )
        assertTrue(improving, improving.contains("improving"))

        val slower = trendSummary(
            listOf(ProgressPoint(1.0, "a", 121_000), ProgressPoint(2.0, "b", 125_000)),
            goalMs = null,
        )
        assertTrue(slower, slower.contains("slower"))
    }

    @Test
    fun `says whether the goal is met`() {
        val met = trendSummary(listOf(ProgressPoint(1.0, "a", 118_000)), goalMs = 120_000)
        assertTrue(met, met.contains("goal") && met.contains("met") && !met.contains("not yet"))

        val unmet = trendSummary(listOf(ProgressPoint(1.0, "a", 125_000)), goalMs = 120_000)
        assertTrue(unmet, unmet.contains("not yet met"))
    }

    // ---- trackmap ----------------------------------------------------------

    @Test
    fun `renders a trackmap and describes its speed range`() {
        compose.setContent { TrackTheme { TrackMap(trace = circuit()) } }
        compose.onNodeWithTag("trackMap").assertIsDisplayed()

        val summary = trackMapSummary(circuit())
        assertTrue(summary, summary.contains("mph"))
    }

    @Test
    fun `draws no trackmap for a trace too short to be a lap`() {
        compose.setContent {
            TrackTheme { TrackMap(trace = List(4) { TraceSample(it.toDouble(), 0.0, 20.0) }) }
        }
        compose.onNodeWithTag("trackMap").assertDoesNotExist()
    }

    @Test
    fun `renders a constant-speed trace, which has no ramp to sit on`() {
        compose.setContent {
            TrackTheme { TrackMap(trace = circuit(constantSpeed = true)) }
        }
        compose.onNodeWithTag("trackMap").assertIsDisplayed()
    }

    // ---- lap overlay -------------------------------------------------------

    @Test
    fun `renders one plot per present channel`() {
        compose.setContent {
            TrackTheme {
                LapChannelChart(
                    channels = SessionChannels(
                        v = 1,
                        dStepM = 20.0,
                        laps = listOf(
                            LapChannels(1, 121_900, speed = ramp(40), latG = ramp(40, 0.8)),
                            LapChannels(2, 120_400, speed = ramp(40), latG = ramp(40, 0.9)),
                        ),
                    ),
                    laps = listOf(lap(1, 121_900), lap(2, 120_400)),
                )
            }
        }
        compose.onNodeWithTag("channelChart:speed").assertIsDisplayed()
        compose.onNodeWithTag("channelChart:latG").assertIsDisplayed()
        // RPM is absent from the data, so it must not draw an empty axis.
        compose.onNodeWithTag("channelChart:rpm").assertDoesNotExist()
    }

    @Test
    fun `renders the PDR driver-input channels in the web's order, and only when carried`() {
        compose.setContent {
            TrackTheme {
                LapChannelChart(
                    channels = SessionChannels(
                        v = 1,
                        dStepM = 20.0,
                        laps = listOf(
                            LapChannels(
                                1,
                                121_900,
                                speed = ramp(40),
                                throttle = ramp(40),
                                brake = ramp(40),
                            ),
                        ),
                    ),
                    laps = listOf(lap(1, 121_900)),
                )
            }
        }
        compose.onNodeWithTag("channelChart:throttle").assertIsDisplayed()
        compose.onNodeWithTag("channelChart:brake").assertIsDisplayed()
        // Steering is absent from every lap, so it must not draw an empty axis.
        compose.onNodeWithTag("channelChart:steering").assertDoesNotExist()
    }

    @Test
    fun `shows a clean empty state when the session has no channels`() {
        compose.setContent {
            TrackTheme {
                LapChannelChart(
                    channels = SessionChannels(v = 1, dStepM = 20.0, laps = emptyList()),
                    laps = listOf(lap(1, 121_900)),
                )
            }
        }
        compose.onNodeWithText("No channel data for this session.").assertIsDisplayed()
    }

    @Test
    fun `labels every chip with its lap number and time, not colour alone`() {
        compose.setContent {
            TrackTheme {
                LapChannelChart(
                    channels = SessionChannels(
                        v = 1,
                        dStepM = 20.0,
                        laps = listOf(LapChannels(1, 121_900, speed = ramp(30))),
                    ),
                    laps = listOf(lap(1, 121_900), lap(2, 119_800)),
                )
            }
        }
        // Lap 2 is the session best (★) but carries no channel data, so its
        // chip is present and inert rather than missing.
        compose.onNodeWithText("Lap 1 · 2:01.9").assertIsDisplayed()
        compose.onNodeWithText("Lap 2 · 1:59.8 ★").assertExists()
    }

    // ---- fixtures ----------------------------------------------------------

    private fun circuit(constantSpeed: Boolean = false): List<TraceSample> =
        (0 until 120).map { i ->
            val a = i / 120.0 * 2 * Math.PI
            TraceSample(
                x = cos(a) * 400,
                y = sin(a) * 250,
                v = if (constantSpeed) 30.0 else 25.0 + 15.0 * sin(a * 2),
            )
        }

    private fun ramp(n: Int, scale: Double = 100.0): List<Double> =
        (0 until n).map { scale * (0.5 + 0.5 * sin(it / 5.0)) }
}
