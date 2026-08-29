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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.trackevolution.core.LapTime
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
    /**
     * Whether these laps have an event to land in. Separate from [eventLabel]
     * because "attached, name not loaded" and "not attached at all" are
     * different facts, and collapsing them is what made this screen tell a
     * driver their laps were homeless when they weren't.
     */
    isAttached: Boolean,
    /** The target event's track name, when it is known. */
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
            attachmentText(isAttached, eventLabel),
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

        // Live lap timing: unofficial (the saved laps come from the review line
        // pick), but on track it's what matters. Arms once the car reaches
        // track pace; laps count from the first pass of the timing point.
        if (state.isRecording) {
            val timing = state.timing
            if (timing?.currentLapS != null) {
                TrackCard {
                    val delta = timing.deltaS
                    if (delta != null) {
                        Text(
                            formatDelta(delta),
                            style = type.lapTimeHero,
                            color = if (delta <= 0) colors.accentInk else colors.dangerInk,
                            modifier = Modifier.semantics {
                                contentDescription = "%.2f seconds %s your best lap"
                                    .format(kotlin.math.abs(delta), if (delta <= 0) "ahead of" else "behind")
                            },
                        )
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Stat("Lap", (timing.lapCount + 1).toString())
                        Stat("Current", RecordingNotification.formatElapsed(timing.currentLapS!!))
                        Stat("Last", LapTime.fmtMs(timing.lastLapMs))
                        Stat("Best", LapTime.fmtMs(timing.bestLapMs))
                    }
                }
            } else {
                Text(
                    "Lap timing arms once you're at track pace; laps count from your first flying pass.",
                    style = type.xs,
                    color = colors.textFaint,
                )
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

/**
 * Where these laps are going to land, in one line.
 *
 * Three states, not two. The screen used to have only the last of them and said
 * it unconditionally, so a recording opened from the dashboard's "Record laps at
 * Summit Point" button was met with "Not attached to an event yet" — the laps
 * were filed correctly, but the screen said the opposite of what the button that
 * opened it had just promised.
 *
 * The middle case is the honest answer while the name is still loading, or when
 * it can't be loaded at all: we know there is an event, we just can't name it,
 * and that is not the same as there being none.
 */
/** "+0.42" / "−0.42": the sign is the message, so it is always shown. */
internal fun formatDelta(seconds: Double): String =
    "%s%.2f".format(if (seconds < 0) "−" else "+", kotlin.math.abs(seconds))

internal fun attachmentText(isAttached: Boolean, eventLabel: String?): String = when {
    isAttached && eventLabel != null -> "Laps will be saved to $eventLabel."
    isAttached -> "Laps will be saved to this event."
    else -> "Not attached to an event yet — you can create one after."
}

@Composable
private fun Stat(label: String, value: String) {
    Column(horizontalAlignment = Alignment.Start) {
        Text(label.uppercase(), style = TrackTheme.typography.eyebrow, color = TrackTheme.colors.textFaint)
        Text(value, style = TrackTheme.typography.bodyStrong, color = TrackTheme.colors.textBody)
    }
}
