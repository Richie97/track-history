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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.trackevolution.core.LapTime
import app.trackevolution.core.LineReview
import app.trackevolution.core.model.Event
import app.trackevolution.core.TracePoint
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * What the review screen is showing. Hoisted out of the composable so the whole
 * flow survives rotation and can be reconstructed after process death — the
 * screen is a projection of this, never the owner of it.
 */
data class ReviewUiState(
    val trace: List<TracePoint> = emptyList(),
    /** Events this session can be saved onto, newest first from the server. */
    val events: List<Event> = emptyList(),
    val selectedEventId: Int? = null,
    val pickedIndex: Int? = null,
    val review: LineReview.Result = LineReview.EMPTY,
    val label: String = "",
    val notes: String = "",
    val saving: Boolean = false,
    /** The server's own message when a save failed. */
    val error: String? = null,
)

/**
 * Turn a stopped recording into a session: pick the start/finish line, check the
 * laps, save.
 *
 * The recording is **not** discarded by arriving here, and is not discarded by
 * leaving: it stays journalled until explicitly saved or discarded, so a crash
 * mid-review costs nothing. That is the same contract the web app has, for the
 * same reason — this is the only copy of a session that has not been uploaded.
 */
@Composable
fun ReviewScreen(
    state: ReviewUiState,
    onPick: (Int) -> Unit,
    onLabelChange: (String) -> Unit,
    onNotesChange: (String) -> Unit,
    onSelectEvent: (Int) -> Unit,
    onSave: () -> Unit,
    onDiscard: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    var confirmingDiscard by remember { mutableStateOf(false) }
    val bestIndex = LineReview.bestLapIndex(state.review.laps)

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(colors.bgPage)
            .systemBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Review recording", style = type.h1, color = colors.textStrong)
        Text(
            "Tap the trace where the start/finish line is.",
            style = type.sm,
            color = colors.textMuted,
        )

        LinePicker(
            trace = state.trace,
            gate = state.review.gate,
            pickedIndex = state.pickedIndex,
            onPick = onPick,
            modifier = Modifier.fillMaxWidth().height(280.dp),
        )

        // The guidance the spec asks for: never a dead end, and the two dead
        // ends are different problems with different answers.
        when (state.review.problem) {
            LineReview.Problem.STATIONARY_PICK -> Advice(
                "The car wasn't moving there, so there's no direction to place a line across. " +
                    "Try a point out on track.",
            )
            LineReview.Problem.NO_CROSSINGS -> Advice(
                "No laps cross the picked line — try a different spot.",
            )
            null -> if (state.pickedIndex == null) {
                Advice("Nothing picked yet.", warning = false)
            }
        }

        if (state.review.hasLaps) {
            TrackCard {
                Text(
                    "${state.review.laps.size} laps".uppercase(),
                    style = type.eyebrow,
                    color = colors.textFaint,
                )
                state.review.laps.forEachIndexed { i, lap ->
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Lap ${i + 1}", style = type.sm, color = colors.textMuted)
                        Text(
                            // `~` marks a lap whose ends were interpolated
                            // between fixes rather than measured — the same
                            // signal the web app shows, and it must survive.
                            (if (lap.estimated) "~" else "") + LapTime.fmtMs(lap.timeMs),
                            style = type.lapTime,
                            color = if (i == bestIndex) colors.accentInk else colors.textStrong,
                        )
                    }
                }
            }

            // Which event this belongs to. A recording can outlive not having
            // one — Android Auto starts them before the event exists — so the
            // choice lives here, at save time, rather than at start.
            TrackCard {
                Text("SAVE ONTO", style = type.eyebrow, color = colors.textFaint)
                if (state.events.isEmpty()) {
                    Text(
                        "No events yet. Create one in the web app, then come back — " +
                            "the recording keeps until you do.",
                        style = type.sm,
                        color = colors.textMuted,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
                state.events.take(8).forEach { event ->
                    TextButton(
                        onClick = { onSelectEvent(event.id) },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            "${if (event.id == state.selectedEventId) "● " else "○ "}" +
                                "${event.startDate} · ${event.trackName}",
                            style = type.sm,
                            color = if (event.id == state.selectedEventId) {
                                colors.accentInk
                            } else {
                                colors.textMuted
                            },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }

            OutlinedTextField(
                value = state.label,
                onValueChange = onLabelChange,
                label = { Text("Session label", style = type.sm) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = state.notes,
                onValueChange = onNotesChange,
                label = { Text("Notes", style = type.sm) },
                modifier = Modifier.fillMaxWidth(),
            )
        }

        state.error?.let {
            TrackCard(color = colors.dangerTint, border = colors.danger) {
                Text(it, style = type.sm, color = colors.dangerInk)
                Text(
                    "The recording is still here — nothing was lost.",
                    style = type.xs,
                    color = colors.textMuted,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }

        Button(
            onClick = onSave,
            enabled = state.review.hasLaps && state.selectedEventId != null && !state.saving,
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(
                containerColor = colors.accent,
                contentColor = colors.accentContrast,
            ),
        ) {
            if (state.saving) {
                CircularProgressIndicator(
                    modifier = Modifier.height(18.dp),
                    color = colors.accentContrast,
                )
            } else {
                Text("Save session", style = type.bodyStrong)
            }
        }

        TextButton(onClick = { confirmingDiscard = true }, modifier = Modifier.fillMaxWidth()) {
            Text("Discard recording", style = type.sm, color = colors.dangerInk)
        }
    }

    if (confirmingDiscard) {
        AlertDialog(
            onDismissRequest = { confirmingDiscard = false },
            containerColor = colors.surfaceRaised,
            title = { Text("Discard this recording?", style = type.h3, color = colors.textStrong) },
            text = {
                Text(
                    "It hasn't been saved anywhere else, so this can't be undone.",
                    style = type.sm,
                    color = colors.textBody,
                )
            },
            confirmButton = {
                TextButton(onClick = { confirmingDiscard = false; onDiscard() }) {
                    Text("Discard", color = colors.dangerInk)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmingDiscard = false }) {
                    Text("Keep", color = colors.textMuted)
                }
            },
        )
    }
}

@Composable
private fun Advice(text: String, warning: Boolean = true) {
    Text(
        text,
        style = TrackTheme.typography.sm,
        color = if (warning) TrackTheme.colors.dangerInk else TrackTheme.colors.textMuted,
    )
}
