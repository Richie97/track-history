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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.trackevolution.core.EventDates
import app.trackevolution.core.LapTime
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.TrackLeaderboard
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
    onCompareLaps: () -> Unit,
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
                    // Web parity (#165): offered whenever any event here has laps —
                    // the compare screen explains itself when none of them stored
                    // telemetry channels.
                    if (model.hasComparableLaps) {
                        TextButton(
                            onClick = onCompareLaps,
                            modifier = Modifier.semantics {
                                contentDescription = "Compare two laps: pick two laps with telemetry " +
                                    "and see where the time is gained or lost"
                            },
                        ) {
                            Text("Compare laps", style = TrackTheme.typography.sm, color = colors.accentInk)
                        }
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

            model.leaderboard?.takeIf { it.catalogId != null }?.let { leaderboard ->
                item("leaderboard") { LeaderboardCard(model, leaderboard) }
            }

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

/**
 * The per-track community leaderboard — the port of the web track page's
 * section. Strictly opt-in: drivers who haven't opted in, the viewer included,
 * simply aren't on it. Only rendered for catalog tracks (the caller checks
 * `catalogId`), since only those have a cross-user identity.
 */
@Composable
private fun LeaderboardCard(model: TrackModel, leaderboard: TrackLeaderboard) {
    val colors = TrackTheme.colors
    var confirmingLeave by remember { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TESectionHeader("Leaderboard", detail = "opt-in only")
        Text(
            "Best laps by Track Evolution drivers at this track.",
            style = TrackTheme.typography.xs,
            color = colors.textFaint,
        )
        if (leaderboard.entries.isEmpty()) {
            TEEmpty("No opted-in drivers here yet" + (if (leaderboard.optedIn) "." else " — be the first."))
        } else {
            TrackCard(Modifier.fillMaxWidth()) {
                leaderboard.entries.forEachIndexed { index, entry ->
                    val label = "Rank ${index + 1}, ${entry.name ?: "Driver"}" +
                        (if (entry.you) ", you" else "") +
                        ", ${LapTime.fmtMs(entry.bestMs)}, ${EventDates.fmtDate(entry.date)}"
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 6.dp)
                            .semantics { contentDescription = label },
                    ) {
                        Text(
                            "${index + 1}",
                            style = TrackTheme.typography.lapTime,
                            color = colors.textFaint,
                        )
                        Text(
                            entry.name ?: "Driver",
                            style = if (entry.you) TrackTheme.typography.bodyStrong else TrackTheme.typography.body,
                            color = colors.textBody,
                            maxLines = 1,
                            modifier = Modifier.weight(1f),
                        )
                        if (entry.you) {
                            Text("you", style = TrackTheme.typography.xxs, color = colors.accentInk)
                        }
                        Text(
                            LapTime.fmtMs(entry.bestMs),
                            style = TrackTheme.typography.lapTime,
                            color = colors.textStrong,
                        )
                        Text(
                            EventDates.fmtDate(entry.date),
                            style = TrackTheme.typography.xxs,
                            color = colors.textFaint,
                        )
                    }
                }
            }
        }
        model.leaderboardError?.let { TEErrorBanner(it) }
        if (leaderboard.optedIn) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "You're on the leaderboards — your name and best lap per track are visible to other signed-in drivers.",
                    style = TrackTheme.typography.xs,
                    color = colors.textFaint,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { confirmingLeave = true }) {
                    Text("Leave", style = TrackTheme.typography.xs, color = colors.dangerInk)
                }
            }
        } else {
            Text(
                "You're not on the leaderboards. Joining shares exactly two things with other signed-in drivers, per track: your name and your best lap.",
                style = TrackTheme.typography.xs,
                color = colors.textFaint,
            )
            TextButton(onClick = { model.setLeaderboardOptIn(true) }) {
                Text("Join leaderboards", style = TrackTheme.typography.bodyStrong, color = colors.accentInk)
            }
        }
    }

    if (confirmingLeave) {
        AlertDialog(
            onDismissRequest = { confirmingLeave = false },
            title = { Text("Leave the leaderboards?") },
            text = { Text("Your name and times disappear from every track's leaderboard.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmingLeave = false
                    model.setLeaderboardOptIn(false)
                }) { Text("Leave leaderboards", color = colors.dangerInk) }
            },
            dismissButton = {
                TextButton(onClick = { confirmingLeave = false }) { Text("Stay on them") }
            },
        )
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
