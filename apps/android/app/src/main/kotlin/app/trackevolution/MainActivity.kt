package app.trackevolution

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import app.trackevolution.core.RecorderCore

/**
 * The single activity the app runs in (spec: NS-02).
 *
 * Deliberately almost empty. The real screens arrive with NS-26, the recorder
 * UI with NS-18, and the design system with NS-07 — this exists so the project
 * assembles, installs and launches with the right identity and icon before any
 * of that lands.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Must precede super.onCreate: it swaps the splash theme out for the
        // real one, so the app never flashes the splash background as a window.
        installSplashScreen()
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = androidx.compose.material3.darkColorScheme()) {
                Surface(modifier = Modifier.fillMaxSize()) {
                    PlaceholderScreen()
                }
            }
        }
    }
}

/**
 * The scaffold's "hello" screen.
 *
 * It reads a constant from `:core` on purpose. The module split is only proven
 * if the shell actually references the pure-logic module — an unused Gradle
 * dependency would compile whether or not the two can really talk.
 */
@Composable
private fun PlaceholderScreen() {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "Track Evolution",
            style = MaterialTheme.typography.headlineMedium,
            textAlign = TextAlign.Center,
        )
        Text(
            text = "Native shell. The logbook lands with NS-26.",
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 8.dp),
        )
        Text(
            text = "core linked · checkpoint format v${RecorderCore.RECORDING_V}",
            style = MaterialTheme.typography.labelSmall,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 24.dp),
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun PlaceholderScreenPreview() {
    MaterialTheme(colorScheme = androidx.compose.material3.darkColorScheme()) {
        Surface { PlaceholderScreen() }
    }
}
