package app.trackevolution.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.trackevolution.core.EventDates
import app.trackevolution.core.LapTime
import app.trackevolution.core.Leaderboard
import app.trackevolution.core.model.TrackLeaderboard
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme

/**
 * One track's leaderboard — the port of the web's `viewLeaderboard`. See
 * [LeaderboardModel] for why it is its own destination rather than a section
 * of the track page.
 *
 * Strictly opt-in: drivers who haven't opted in, the viewer included, simply
 * aren't on it. A row opens its lap (NS-35) when its owner published it — the
 * server decides that and withholds `lapId` otherwise, so a row with no id is
 * plain text rather than a tap that would 404.
 */
@Composable
fun LeaderboardScreen(
    model: LeaderboardModel,
    onOpenLap: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    // Saveable so a rotation mid-decision keeps the dialog up.
    var confirmingLeave by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        val leaderboard = model.leaderboard ?: return@TELoadable

        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("head") {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Leaderboard", style = TrackTheme.typography.h1, color = colors.textStrong)
                    Text(
                        "${model.trackName} · opt-in only",
                        style = TrackTheme.typography.sm,
                        color = colors.textMuted,
                    )
                }
            }

            if (leaderboard.catalogId == null) {
                item("no-catalog") { TEEmpty("This track isn't in the catalog, so it has no leaderboard.") }
            } else {
                item("board") {
                    Board(
                        model = model,
                        leaderboard = leaderboard,
                        onOpenLap = onOpenLap,
                        onLeave = { confirmingLeave = true },
                    )
                }
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
private fun Board(
    model: LeaderboardModel,
    leaderboard: TrackLeaderboard,
    onOpenLap: (Int) -> Unit,
    onLeave: () -> Unit,
) {
    val colors = TrackTheme.colors

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            "Best device-timed laps by Track Evolution drivers at this track. Laps recorded with the app " +
                "or imported from telemetry count; hand-entered times don't.",
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
                    val lapId = entry.lapId
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .then(if (lapId != null) Modifier.clickable { onOpenLap(lapId) } else Modifier)
                            .padding(vertical = 6.dp)
                            .semantics {
                                contentDescription = if (lapId != null) "$label. Open this lap." else label
                            },
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
                        // A chevron is the only thing distinguishing an openable
                        // row, so it is drawn rather than left to colour: most
                        // rows are not.
                        if (lapId != null) {
                            Text("›", style = TrackTheme.typography.body, color = colors.textFaint)
                        }
                    }
                }
            }
        }
        if (leaderboard.entries.any { it.lapId != null }) {
            Text(
                "Rows with a chevron open the lap — its racing line and telemetry, next to your own best here.",
                style = TrackTheme.typography.xs,
                color = colors.textFaint,
            )
        }
        Leaderboard.note(model.logbookBest, leaderboard)?.let {
            Text(it, style = TrackTheme.typography.xs, color = colors.textFaint)
        }
        model.leaderboardError?.let { TEErrorBanner(it) }
        if (leaderboard.optedIn) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "You're on the leaderboards — your name and best device-timed lap per track are visible to other signed-in drivers.",
                    style = TrackTheme.typography.xs,
                    color = colors.textFaint,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onLeave) {
                    Text("Leave", style = TrackTheme.typography.xs, color = colors.dangerInk)
                }
            }
            // The second consent sits with the first, because this is the one
            // place a driver is looking at exactly what it would publish.
            if (leaderboard.shareLaps) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "Your ranked lap is open to other drivers here — its racing line and telemetry, " +
                            "and nothing else from your logbook.",
                        style = TrackTheme.typography.xs,
                        color = colors.textFaint,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = { model.setLeaderboardOptIn(true, shareLaps = false) }) {
                        Text("Stop", style = TrackTheme.typography.xs, color = colors.dangerInk)
                    }
                }
            } else {
                Text(
                    "Your ranked lap is a time only. Sharing it lets other drivers ranked here open its " +
                        "racing line and telemetry — never your notes, your car, your setup or any other lap.",
                    style = TrackTheme.typography.xs,
                    color = colors.textFaint,
                )
                TextButton(onClick = { model.setLeaderboardOptIn(true, shareLaps = true) }) {
                    Text(
                        "Share my ranked laps",
                        style = TrackTheme.typography.bodyStrong,
                        color = colors.accentInk,
                    )
                }
            }
        } else {
            Text(
                "You're not on the leaderboards. Joining shares exactly two things with other signed-in drivers, per track: your name and your best device-timed lap.",
                style = TrackTheme.typography.xs,
                color = colors.textFaint,
            )
            TextButton(onClick = { model.setLeaderboardOptIn(true) }) {
                Text("Join leaderboards", style = TrackTheme.typography.bodyStrong, color = colors.accentInk)
            }
        }
    }
}
