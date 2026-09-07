package app.trackevolution.ui.charts

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.ui.theme.TrackTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The channel panel's tab and lit-lap selection across a configuration change
 * (spec: NS-34 ticket 4's fold/unfold audit).
 *
 * Both are `rememberSaveable`, which the audit read as safe — but `rememberSaveable`
 * throws at runtime on a value the `Bundle` cannot carry, and *nothing exercised a
 * restore*, so "safe" was an inspection rather than a fact. Folding a device is
 * a configuration change, so this is the path a Fold takes every time it opens.
 *
 * `StateRestorationTester` is the cheap way to ask: it saves and restores the
 * composition exactly as the system does, without an activity or an emulator.
 */
@RunWith(RobolectricTestRunner::class)
class PanelRestorationTest {

    @get:Rule
    val compose = createComposeRule()

    private fun ramp(n: Int, scale: Double = 1.0): List<Double> =
        (0 until n).map { it * scale }

    private fun lap(number: Int, ms: Int) =
        Lap(id = number, sessionId = 1, lapNum = number, timeMs = ms)

    private val channels = SessionChannels(
        v = 1,
        dStepM = 20.0,
        laps = listOf(
            LapChannels(1, 121_900, speed = ramp(40), latG = ramp(40, 0.8)),
            LapChannels(2, 120_400, speed = ramp(40), latG = ramp(40, 0.9)),
        ),
    )

    @Test
    fun `the chosen tab survives a configuration change`() {
        val restoration = StateRestorationTester(compose)
        restoration.setContent {
            TrackTheme {
                LapChannelChart(
                    channels = channels,
                    laps = listOf(lap(1, 121_900), lap(2, 120_400)),
                )
            }
        }

        // Off the tab the panel opens on, so the assertion is about what was
        // chosen rather than about the default.
        compose.onNodeWithContentDescription("Grip").performClick()
        compose.onNodeWithTag("channelChart:latG").assertIsDisplayed()

        restoration.emulateSavedInstanceStateRestore()

        compose.onNodeWithTag("channelChart:latG").assertIsDisplayed()
        compose.onNodeWithTag("channelChart:speed").assertDoesNotExist()
    }
}
