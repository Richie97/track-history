package app.trackevolution.recording

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import app.trackevolution.core.LapTime
import app.trackevolution.core.LineReview
import app.trackevolution.core.telemetry.ParsedTelemetry
import app.trackevolution.core.telemetry.Telemetry
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * Turn a stopped recording — or a selection of imported videos — into sessions:
 * pick the start/finish line where one is needed, check the laps, save.
 *
 * A recording is **not** discarded by arriving here, and is not discarded by
 * leaving: it stays journalled until explicitly saved or discarded, so a crash
 * mid-review costs nothing. That is the same contract the web app has, for the
 * same reason — this is the only copy of a session that has not been uploaded.
 * An import has nothing to protect (the clips are still on the phone), so its
 * "discard" is a plain cancel.
 */
@Composable
fun ReviewScreen(
    state: ReviewUiState,
    onPick: (Int) -> Unit,
    onLabelChange: (Int, String) -> Unit,
    onIncludeChange: (Int, Boolean) -> Unit,
    onNotesChange: (String) -> Unit,
    onSelectEvent: (Int) -> Unit,
    onSave: () -> Unit,
    onDiscard: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    var confirmingDiscard by remember { mutableStateOf(false) }
    val anyLaps = state.items.any { it.hasLaps }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(colors.bgPage)
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(
            if (state.isImport) "Import preview" else "Review recording",
            style = type.h1,
            color = colors.textStrong,
        )

        if (state.needsLinePick) {
            Text(
                pickerHint(state),
                style = type.sm,
                color = colors.textMuted,
            )

            LinePicker(
                trace = state.pickTrace,
                gate = state.gate,
                pickedIndex = state.pickedIndex,
                onPick = onPick,
                modifier = Modifier.fillMaxWidth().height(280.dp),
            )

            // The guidance the spec asks for: never a dead end, and the two dead
            // ends are different problems with different answers.
            when (state.problem) {
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
        }

        state.items.forEachIndexed { index, item ->
            ItemCard(
                item = item,
                index = index,
                state = state,
                onLabelChange = { onLabelChange(index, it) },
                onIncludeChange = { onIncludeChange(index, it) },
            )
        }

        if (anyLaps) {
            // Which event this belongs to. A recording can outlive not having
            // one — Android Auto starts them before the event exists — so the
            // choice lives here, at save time, rather than at start.
            TrackCard {
                Text("SAVE ONTO", style = type.eyebrow, color = colors.textFaint)
                if (state.events.isEmpty()) {
                    Text(
                        "No events yet. Create one first, then come back — " +
                            if (state.isImport) "the videos aren't going anywhere." else "the recording keeps until you do.",
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

            if (!state.isImport) {
                OutlinedTextField(
                    value = state.notes,
                    onValueChange = onNotesChange,
                    label = { Text("Notes", style = type.sm) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        state.error?.let {
            TrackCard(color = colors.dangerTint, border = colors.danger) {
                Text(it, style = type.sm, color = colors.dangerInk)
                Text(
                    if (state.isImport) {
                        "Nothing was lost — the videos are still on this phone."
                    } else {
                        "The recording is still here — nothing was lost."
                    },
                    style = type.xs,
                    color = colors.textMuted,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }

        Button(
            onClick = onSave,
            enabled = state.canSave,
            modifier = Modifier.fillMaxWidth().testTag("reviewSave"),
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
                Text(
                    if (state.selectedCount > 1) "Save ${state.selectedCount} sessions" else "Save session",
                    style = type.bodyStrong,
                )
            }
        }

        if (state.isImport) {
            // Nothing to protect: the clips are still where they were.
            TextButton(onClick = onDiscard, modifier = Modifier.fillMaxWidth()) {
                Text("Cancel import", style = type.sm, color = colors.textMuted)
            }
        } else {
            TextButton(onClick = { confirmingDiscard = true }, modifier = Modifier.fillMaxWidth()) {
                Text("Discard recording", style = type.sm, color = colors.dangerInk)
            }
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

/** What the picker asks for, phrased for what's being reviewed. */
private fun pickerHint(state: ReviewUiState): String {
    val live = state.items.all { it.parsed?.kind == ParsedTelemetry.Kind.LIVE }
    val prefix = if (live) "Your recording has a GPS trace" else "This footage has GPS data but no lap markers"
    return "$prefix. Tap the trace where the start/finish line is — laps are timed each pass across it."
}

/**
 * One reviewed thing: a clip's laps, or the recording's. A clip that yielded no
 * telemetry says so by name rather than vanishing from the list.
 */
@Composable
private fun ItemCard(
    item: ReviewItem,
    index: Int,
    state: ReviewUiState,
    onLabelChange: (String) -> Unit,
    onIncludeChange: (Boolean) -> Unit,
) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    val parsed = item.parsed

    TrackCard(Modifier.fillMaxWidth().testTag("reviewItem$index")) {
        if (state.isImport) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(
                    checked = item.include && item.hasLaps,
                    enabled = item.hasLaps,
                    onCheckedChange = onIncludeChange,
                    colors = CheckboxDefaults.colors(
                        checkedColor = colors.accent,
                        checkmarkColor = colors.accentInk,
                    ),
                )
                Column(Modifier.weight(1f)) {
                    Text(item.file, style = type.bodyStrong, color = colors.textStrong)
                    parsed?.let {
                        Text(meta(it), style = type.xs, color = colors.textMuted)
                    }
                }
            }
        }

        item.error?.let {
            TEErrorBanner(it, modifier = Modifier.padding(top = 6.dp))
        }
        if (parsed == null) return@TrackCard

        if (item.hasLaps) {
            val bestIndex = item.laps.indices.minByOrNull { item.laps[it].timeMs }
            Text(
                "${item.laps.size} laps".uppercase(),
                style = type.eyebrow,
                color = colors.textFaint,
                modifier = Modifier.padding(top = if (state.isImport) 8.dp else 0.dp),
            )
            item.laps.forEachIndexed { i, lap ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Lap ${lap.lapNumber ?: (i + 1)}", style = type.sm, color = colors.textMuted)
                    Text(
                        // `~` marks a lap whose ends were interpolated between
                        // fixes or placed by distance rather than timed by a
                        // beacon — the same signal the web app shows, and it
                        // must survive.
                        (if (lap.estimated) "~" else "") + LapTime.fmtMs(lap.timeMs),
                        style = type.lapTime,
                        color = if (i == bestIndex) colors.accentInk else colors.textStrong,
                    )
                }
            }
        } else if (item.error == null) {
            Text(
                noLapsHint(parsed, state),
                style = type.sm,
                color = colors.textMuted,
                modifier = Modifier.padding(top = 6.dp),
            )
        }

        val metrics = Telemetry.metricsSummary(parsed)
        if (metrics.isNotEmpty()) {
            Text(metrics, style = type.xs, color = colors.textMuted, modifier = Modifier.padding(top = 6.dp))
        }
        val note = Telemetry.estimatedNote(parsed, parsed.laps.count { it.estimated })
        if (note.isNotEmpty()) {
            Text("~ = $note", style = type.xs, color = colors.textMuted, modifier = Modifier.padding(top = 4.dp))
        }

        if (item.hasLaps) {
            OutlinedTextField(
                value = item.label,
                onValueChange = onLabelChange,
                label = { Text("Session label", style = type.sm) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
        }
    }
}

/** "2026-06-20 · 09:15:00 · 3 min" — a clip's own header line. */
private fun meta(parsed: ParsedTelemetry): String = listOfNotNull(
    parsed.date,
    parsed.time,
    "${Math.round(parsed.durationS / 60)} min",
).joinToString(" · ")

/** Why a source shows no laps yet, in the web app's words. */
private fun noLapsHint(parsed: ParsedTelemetry, state: ReviewUiState): String = when {
    parsed.needsLine -> if (state.pickedIndex == null) {
        "${parsed.gps?.size ?: 0} GPS points — set the start/finish line above to time laps."
    } else {
        "No laps cross the picked line — try a different spot."
    }
    parsed.kind == ParsedTelemetry.Kind.PDR && parsed.beaconCount == 0 ->
        "No laps found — no beacons, and the telemetry shows no repeating lap pattern (pit/paddock footage?)."
    else -> "No complete laps found (no start/finish crossings in telemetry)."
}

@Composable
private fun Advice(text: String, warning: Boolean = true) {
    Text(
        text,
        style = TrackTheme.typography.sm,
        color = if (warning) TrackTheme.colors.dangerInk else TrackTheme.colors.textMuted,
    )
}
