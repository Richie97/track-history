package app.trackevolution

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.compose.material3.Text
import app.trackevolution.core.LapTime
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.ui.theme.ThemePreference
import app.trackevolution.ui.theme.TrackTheme

/**
 * The single activity the app runs in (spec: NS-02).
 *
 * Still deliberately thin. The real screens arrive with NS-26 and the recorder
 * UI with NS-18; what this now does is own the theme — reading the persisted
 * system/light/dark override and wrapping everything in [TrackTheme].
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Must precede super.onCreate: it swaps the splash theme out for the
        // real one, so the app never flashes the splash background as a window.
        installSplashScreen()
        super.onCreate(savedInstanceState)
        setContent {
            val preference = remember { ThemePreference(applicationContext) }
            // Until the first read lands, System is the right answer anyway —
            // so there is nothing to block the first frame on.
            val choice by preference.choice.collectAsState(initial = ThemeChoice.System)
            TrackTheme(choice) { PlaceholderScreen() }
        }
    }
}

/**
 * The scaffold's "hello" screen, now drawn from tokens.
 *
 * It reads from `:core` on purpose. The module split is only proven if the shell
 * actually references the pure-logic module — an unused Gradle dependency would
 * compile whether or not the two can really talk.
 */
@Composable
private fun PlaceholderScreen() {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    Column(
        modifier = Modifier.fillMaxSize().background(colors.bgPage).padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Track Evolution", style = type.h1, color = colors.textStrong, textAlign = TextAlign.Center)
        Text(
            text = "Native shell. The logbook lands with NS-26.",
            style = type.sm,
            color = colors.textMuted,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 8.dp),
        )
        Text(
            text = LapTime.fmtMs(118_421),
            style = type.lapTimeHero,
            color = colors.accentInk,
            modifier = Modifier.padding(top = 24.dp),
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun PlaceholderScreenPreview() {
    TrackTheme(ThemeChoice.Dark) { PlaceholderScreen() }
}

@Preview(showBackground = true)
@Composable
private fun PlaceholderScreenLightPreview() {
    TrackTheme(ThemeChoice.Light) { PlaceholderScreen() }
}
