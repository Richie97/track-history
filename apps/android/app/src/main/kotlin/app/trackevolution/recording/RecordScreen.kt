package app.trackevolution.recording

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.coroutines.delay

/**
 * How long without a fix before the stream counts as stalled.
 *
 * Generous next to the ~200 ms request interval, because a momentary gap under
 * a bridge is not a failure. But silence during a session is the worst possible
 * outcome, so past this the screen says so rather than showing a frozen count
 * that looks like it is still working.
 */
private const val STALL_AFTER_MS = 8_000L

/**
 * The live recording screen: start, stop, and what the recorder is actually
 * getting.
 *
 * **Nothing here is required for the recording to continue.** The service owns
 * it (NS-16); this observes. Navigating away, rotating, or the process dying
 * leaves the recording untouched, which is why there is no state in this file
 * that isn't derived from [RecorderState].
 */
@Composable
fun RecordScreen(
    state: RecorderState,
    eventLabel: String?,
    onStart: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography

    // A clock only so "no fixes for N seconds" can be noticed while nothing is
    // arriving — by definition there is no fix to trigger a recomposition.
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(state.isRecording) {
        while (state.isRecording) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    val stalled = state.isRecording &&
        state.lastFixAtMs > 0 &&
        now - state.lastFixAtMs > STALL_AFTER_MS

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(colors.bgPage)
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(
            if (state.isRecording) "Recording" else "Record laps",
            style = type.h1,
            color = colors.textStrong,
        )
        Text(
            eventLabel ?: "Not attached to an event yet — you can create one after.",
            style = type.sm,
            color = colors.textMuted,
        )

        TrackCard {
            Text(
                RecordingNotification.formatElapsed(state.elapsedS),
                style = type.lapTimeHero,
                color = if (state.isRecording) colors.accentInk else colors.textMuted,
            )
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Stat("Fixes", state.fixCount.toString())
                Stat("Speed", state.lastSpeedMps?.let { "%.0f mph".format(it * 2.23694) } ?: "—")
                Stat("Accuracy", state.lastAccuracyM?.let { "±%.0f m".format(it) } ?: "—")
            }
        }

        if (stalled) {
            // Said out loud rather than left to a frozen number: a silent stall
            // mid-session is the failure this screen exists to make impossible.
            TrackCard(color = colors.dangerTint, border = colors.danger) {
                Text("No GPS fixes are arriving", style = type.h3, color = colors.dangerInk)
                Text(
                    "The recording is still running and everything captured so far is safe. " +
                        "Check the phone has a view of the sky.",
                    style = type.sm,
                    color = colors.textBody,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }

        // Accuracy worth mentioning before someone drives 20 minutes on it.
        val accuracy = state.lastAccuracyM
        if (state.isRecording && accuracy != null && accuracy > 25) {
            TrackCard(color = colors.dangerTint, border = colors.danger) {
                Text(
                    "GPS accuracy is poor (±%.0f m). Lap times will be rough.".format(accuracy),
                    style = type.sm,
                    color = colors.dangerInk,
                )
            }
        }

        state.blocker?.let {
            TrackCard(color = colors.dangerTint, border = colors.danger) {
                Text(it.message, style = type.sm, color = colors.dangerInk)
            }
        }

        if (state.autoStopped) {
            TrackCard(color = colors.accentTint, border = colors.accent) {
                Text("Recording stopped itself", style = type.h3, color = colors.textStrong)
                Text(
                    "Either it hit the four-hour cap, or the car had been parked for a while " +
                        "after being driven.",
                    style = type.sm,
                    color = colors.textBody,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }

        Button(
            onClick = if (state.isRecording) onStop else onStart,
            modifier = Modifier.fillMaxWidth().height(56.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = if (state.isRecording) colors.danger else colors.accent,
                contentColor = colors.accentContrast,
            ),
        ) {
            Text(if (state.isRecording) "Stop" else "Start recording", style = type.h3)
        }

        Text(
            "You can lock the phone and put it away — recording carries on.",
            style = type.xs,
            color = colors.textFaint,
        )
    }
}

@Composable
private fun Stat(label: String, value: String) {
    Column(horizontalAlignment = Alignment.Start) {
        Text(label.uppercase(), style = TrackTheme.typography.eyebrow, color = TrackTheme.colors.textFaint)
        Text(value, style = TrackTheme.typography.bodyStrong, color = TrackTheme.colors.textBody)
    }
}
