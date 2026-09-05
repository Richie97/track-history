package app.trackevolution.ui.charts

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.onNodeWithText
import app.trackevolution.core.Limits
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
        // One question per tab (#193): speed answers "where did the time go",
        // lateral G "how much grip", so they are not on screen together.
        compose.onNodeWithTag("channelChart:speed").assertIsDisplayed()
        compose.onNodeWithTag("channelChart:latG").assertDoesNotExist()
        compose.onNodeWithContentDescription("Grip").performClick()
        compose.onNodeWithTag("channelChart:latG").assertIsDisplayed()
        // RPM is absent from the data, so neither tab draws an empty axis — and
        // with nothing on Inputs, that tab is not offered at all.
        compose.onNodeWithTag("channelChart:rpm").assertDoesNotExist()
        compose.onNodeWithContentDescription("Inputs").assertDoesNotExist()
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
        // The driver inputs share a tab; speed keeps the Time tab it opens on.
        compose.onNodeWithTag("channelChart:speed").assertIsDisplayed()
        compose.onNodeWithContentDescription("Inputs").performClick()
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

    // ---- gear ribbon and shift points (#187) -------------------------------

    /**
     * A lap that upshifts three times with a clutch-in blip in the middle, so
     * the ribbon has a gap to draw and the shift table has rows.
     */
    private fun gearLap(n: Int, timeMs: Int, late: Boolean = false) = LapChannels(
        n = n,
        timeMs = timeMs,
        speed = ramp(40),
        rpm = (0 until 40).map { 4000.0 + (it % 10) * 350 },
        gear = (0 until 40).map { k ->
            when {
                k == 19 -> 0.0 // clutch in: no gear, drawn as a gap
                k < 10 -> 2.0
                k < 20 -> 3.0
                k < 30 -> if (late) 3.0 else 4.0 // where the two laps disagree
                else -> 5.0
            }
        },
    )

    @Test
    fun `draws the gear ribbon under the rpm trace and tabulates the shift points`() {
        compose.setContent {
            TrackTheme {
                LapChannelChart(
                    channels = SessionChannels(
                        v = 1,
                        dStepM = 20.0,
                        laps = listOf(gearLap(1, 121_900), gearLap(2, 120_400, late = true)),
                    ),
                    laps = listOf(lap(1, 121_900), lap(2, 120_400)),
                )
            }
        }
        // Both live on Inputs, beside the traces they explain.
        compose.onNodeWithTag("gearRibbon").assertDoesNotExist()
        compose.onNodeWithContentDescription("Inputs").performClick()
        compose.onNodeWithTag("shiftTable").assertIsDisplayed()
        compose.onNodeWithTag("gearRibbon").assertIsDisplayed()
        // The ribbon is a picture; the gears it drew have to survive into words.
        val ribbon = compose.onNodeWithTag("gearRibbon").fetchSemanticsNode()
        val said = ribbon.config[SemanticsProperties.ContentDescription].first()
        assertTrue(said, said.contains("2nd to 5th"))
    }

    @Test
    fun `draws no ribbon for a session that stored no gear`() {
        compose.setContent {
            TrackTheme {
                LapChannelChart(
                    channels = SessionChannels(
                        v = 1,
                        dStepM = 20.0,
                        laps = listOf(LapChannels(1, 121_900, speed = ramp(30), rpm = ramp(30, 7000.0))),
                    ),
                    laps = listOf(lap(1, 121_900)),
                )
            }
        }
        compose.onNodeWithContentDescription("Inputs").performClick()
        compose.onNodeWithTag("channelChart:rpm").assertIsDisplayed()
        compose.onNodeWithTag("gearRibbon").assertDoesNotExist()
        compose.onNodeWithTag("shiftTable").assertDoesNotExist()
    }

    // ---- limit marks (#188) ------------------------------------------------

    @Test
    fun `marks the track map where the lap hit its limit, and names the kinds`() {
        val lapChannels = LapChannels(
            1,
            121_900,
            speed = ramp(40),
            brake = ramp(40),
            // ABS across one braking zone, traction control on one exit.
            flags = (0 until 40).map { k ->
                when {
                    k in 8..11 -> Limits.FLAG_ABS.toDouble()
                    k in 25..26 -> Limits.FLAG_TC.toDouble()
                    else -> 0.0
                }
            },
        )
        val trace = circuit()
        val markers = Limits.limitMarkers(lapChannels, 20.0, trace)
        compose.setContent {
            TrackTheme {
                androidx.compose.foundation.layout.Column {
                    TrackMap(trace = trace, markers = markers)
                    LimitLegend(markers)
                }
            }
        }
        assertTrue(markers.map { it.kind } == listOf("abs", "tc"))
        // Colour and shape are invisible to TalkBack, so both the map and the
        // legend have to say which systems fired.
        val map = compose.onNodeWithTag("trackMap").fetchSemanticsNode()
        val said = map.config[SemanticsProperties.ContentDescription].first()
        assertTrue(said, said.contains("ABS in 1 place"))
        assertTrue(said, said.contains("traction control in 1 place"))
        compose.onNodeWithContentDescription("At the limit on this lap: ABS, Traction control")
            .assertExists()
    }

    @Test
    fun `draws no legend for a lap that never reached its limit`() {
        compose.setContent {
            TrackTheme {
                androidx.compose.foundation.layout.Column {
                    TrackMap(trace = circuit())
                    LimitLegend(emptyList())
                }
            }
        }
        compose.onNodeWithTag("trackMap").assertIsDisplayed()
        val map = compose.onNodeWithTag("trackMap").fetchSemanticsNode()
        val said = map.config[SemanticsProperties.ContentDescription].first()
        assertTrue(said, !said.contains("place"))
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
