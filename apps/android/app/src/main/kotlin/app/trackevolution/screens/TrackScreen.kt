package app.trackevolution.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.trackevolution.core.EventDates
import app.trackevolution.core.LapTime
import app.trackevolution.core.model.Event
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.TEField
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.TEMeta
import app.trackevolution.ui.TENavCard
import app.trackevolution.ui.TESectionHeader
import app.trackevolution.ui.fmtCount
import app.trackevolution.ui.charts.ProgressChart
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * One circuit: how the times have moved, the goal, the notes, the events (NS-26).
 *
 * See [TrackModel] for what is deliberately not here — the setup-vs-lap-times
 * table and the two-event lap overlay are web-only, so there is no dead link to
 * either.
 */
@Composable
fun TrackScreen(
    model: TrackModel,
    onOpenEvent: (Int) -> Unit,
    onAddEvent: (String) -> Unit,
    onShare: (String) -> Unit,
    serverUrl: String,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    val listState = rememberLazyListState()

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        val track = model.track ?: return@TELoadable

        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("head") {
                Column {
                    Text(track.name, style = TrackTheme.typography.h1, color = colors.textStrong)
                    Row(verticalAlignment = Alignment.Bottom) {
                        Text(
                            "Personal best ",
                            style = TrackTheme.typography.sm,
                            color = colors.textMuted,
                        )
                        Text(
                            LapTime.fmtMs(model.personalBest),
                            style = TrackTheme.typography.lapTime,
                            color = colors.textStrong,
                        )
                        Text(
                            (if (model.dryOnly) " (dry)" else "") +
                                " · " + fmtCount(model.events.size, "event"),
                            style = TrackTheme.typography.sm,
                            color = colors.textMuted,
                        )
                    }
                }
            }

            if (model.chartPoints.isNotEmpty()) {
                item("chart") { ChartCard(model, goalMs = track.goalMs) }
            }

            item("goal") { GoalCard(model, hasGoal = track.goalMs != null) }

            item("actions") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { onAddEvent(track.name) },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.accent,
                            contentColor = colors.accentContrast,
                        ),
                    ) {
                        // The heading above already says which track — a circuit
                        // name with a layout suffix wraps to three lines here.
                        Text("+ Add event here", style = TrackTheme.typography.bodyStrong)
                    }
                    model.shareUrl(serverUrl)?.let { url ->
                        TextButton(onClick = { onShare(url) }) {
                            Text("Share", style = TrackTheme.typography.sm, color = colors.accentInk)
                        }
                    }
                }
            }

            model.writeError?.let { message ->
                item("write-error") {
                    Column {
                        TEErrorBanner(message)
                        TextButton(onClick = model::dismissWriteError) {
                            Text("Dismiss", style = TrackTheme.typography.xs, color = colors.textMuted)
                        }
                    }
                }
            }

            item("notes") { NotesCard(model) }

            item("events-header") {
                TESectionHeader("Events", detail = if (model.dryOnly) "dry only" else null)
            }
            if (model.events.isEmpty()) {
                item("events-empty") {
                    TEEmpty(
                        if (model.dryOnly) {
                            "No dry events logged here."
                        } else {
                            "No events at this track yet."
                        },
                    )
                }
            } else {
                items(model.events, key = { "ev-${it.id}" }) { event ->
                    EventRow(event) { onOpenEvent(event.id) }
                }
            }
        }
    }
}

@Composable
private fun ChartCard(model: TrackModel, goalMs: Int?) {
    val colors = TrackTheme.colors
    TrackCard(Modifier.fillMaxWidth()) {
        Text(
            "Best lap per event — down is faster",
            style = TrackTheme.typography.xs,
            color = colors.textFaint,
            modifier = Modifier.padding(bottom = 10.dp),
        )
        ProgressChart(points = model.chartPoints, goalMs = goalMs)
        if (model.hasWetData) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Switch(
                    checked = model.dryOnly,
                    onCheckedChange = { model.dryOnly = it },
                    colors = SwitchDefaults.colors(
                        checkedThumbColor = colors.accentInk,
                        checkedTrackColor = colors.accentTint,
                    ),
                )
                Text("Dry only", style = TrackTheme.typography.sm, color = colors.textBody)
            }
        }
    }
}

@Composable
private fun GoalCard(model: TrackModel, hasGoal: Boolean) {
    val colors = TrackTheme.colors
    TrackCard(Modifier.fillMaxWidth()) {
        TEField("Goal lap", hint = "The time you're chasing here — drawn on the chart above") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = model.goalText,
                    onValueChange = { model.goalText = it },
                    placeholder = { Text("e.g. 1:59.0", style = TrackTheme.typography.sm) },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = model::saveGoal) {
                    Text("Save", style = TrackTheme.typography.bodyStrong, color = colors.accentInk)
                }
                if (hasGoal) {
                    TextButton(onClick = model::clearGoal) {
                        Text("Clear", style = TrackTheme.typography.sm, color = colors.textMuted)
                    }
                }
            }
        }
        model.goalStatus?.let { status ->
            Text(
                status.text,
                style = TrackTheme.typography.sm,
                color = if (status.met) colors.positive else colors.textMuted,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

@Composable
private fun NotesCard(model: TrackModel) {
    val colors = TrackTheme.colors
    TrackCard(Modifier.fillMaxWidth()) {
        TESectionHeader("Course notes")
        TEField("Notes to reread the night before", modifier = Modifier.padding(top = 8.dp)) {
            OutlinedTextField(
                value = model.notes,
                onValueChange = { model.notes = it },
                placeholder = {
                    Text(
                        "T1: brake at the 300 board, 4th gear\n" +
                            "T5a: patience — late apex, track out over the curb…",
                        style = TrackTheme.typography.sm,
                    )
                },
                minLines = 4,
                maxLines = 12,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Row(
            modifier = Modifier.padding(top = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(
                onClick = model::saveNotes,
                enabled = !model.savingNotes && model.notesChanged,
            ) {
                Text(
                    if (model.savingNotes) "Saving…" else "Save notes",
                    style = TrackTheme.typography.bodyStrong,
                    color = colors.accentInk,
                )
            }
            if (model.notesSaved && !model.notesChanged) {
                Text("Saved.", style = TrackTheme.typography.xs, color = colors.textMuted)
            }
        }
    }
}

@Composable
private fun EventRow(event: Event, onClick: () -> Unit) {
    val colors = TrackTheme.colors
    TENavCard(onClick = onClick) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column(Modifier.weight(1f)) {
                Text(
                    EventDates.fmtDate(event.startDate),
                    style = TrackTheme.typography.bodyStrong,
                    color = colors.textStrong,
                )
                TEMeta(
                    listOf(
                        EventDates.fmtDays(event.days),
                        event.club,
                        event.runGroup,
                        event.conditions?.rawValue,
                    ),
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    LapTime.fmtMs(event.bestMs),
                    style = TrackTheme.typography.lapTime,
                    color = colors.textStrong,
                )
                Text(
                    LapTime.fmtConsistency(event.consistency),
                    style = TrackTheme.typography.xxs,
                    color = colors.textFaint,
                    // A bare percentage beside a lap time is ambiguous read
                    // aloud, and the visual cue — small, faint, under the time —
                    // is exactly what a screen-reader user does not get.
                    modifier = Modifier.semantics {
                        contentDescription = "Consistency ${LapTime.fmtConsistency(event.consistency)}"
                    },
                )
            }
        }
    }
}
