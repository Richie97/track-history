package app.trackevolution.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.trackevolution.core.EventDates
import app.trackevolution.core.LapTime
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.Track
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.fmtCount
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.TEMeta
import app.trackevolution.ui.TENavCard
import app.trackevolution.ui.TESectionHeader
import app.trackevolution.ui.TEStatRow
import app.trackevolution.ui.charts.ProgressChart
import app.trackevolution.ui.charts.ProgressChartStyle
import app.trackevolution.ui.charts.ProgressPoint
import app.trackevolution.ui.theme.TrackTheme

/**
 * The logbook's front page (NS-26): what's next, what you've done, and where.
 *
 * A `LazyColumn` rather than a scrolling `Column` so its scroll position
 * survives navigating into an event and back, which the spec asks for by name.
 */
@Composable
fun DashboardScreen(
    model: DashboardModel,
    onOpenEvent: (Int) -> Unit,
    onOpenTrack: (Int) -> Unit,
    onNewEvent: () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    val listState = rememberLazyListState()

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 12.dp),
        ) {
            item("actions") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = onNewEvent,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.accent,
                            contentColor = colors.accentContrast,
                        ),
                    ) {
                        Text("+ Add event", style = TrackTheme.typography.bodyStrong)
                    }
                    TextButton(onClick = onOpenSettings) {
                        Text("Settings", style = TrackTheme.typography.sm, color = colors.textMuted)
                    }
                }
            }

            model.heroEvent?.let { hero ->
                item("hero") { HeroCard(hero) { onOpenEvent(hero.id) } }
            }

            item("totals") {
                TEStatRow(
                    listOf(
                        "Events" to model.totals.events.toString(),
                        "Track days" to model.totals.trackDays.toString(),
                        "Tracks" to model.tracksWithData.size.toString(),
                    ),
                )
            }

            if (model.alsoUpcoming.isNotEmpty()) {
                item("also-header") { TESectionHeader("Also upcoming") }
                items(model.alsoUpcoming, key = { "up-${it.id}" }) { event ->
                    TENavCard(onClick = { onOpenEvent(event.id) }) {
                        Text(event.trackName, style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
                        TEMeta(
                            listOf(
                                EventDates.fmtCountdown(event.startDate),
                                EventDates.fmtDate(event.startDate),
                                event.club,
                            ),
                        )
                    }
                }
            }

            item("tracks-header") { TESectionHeader("Tracks") }
            if (model.tracksWithData.isEmpty()) {
                item("tracks-empty") { TEEmpty("No events yet — add your first track day.") }
            } else {
                items(model.tracksWithData, key = { "tr-${it.id}" }) { track ->
                    TrackRow(track) { onOpenTrack(track.id) }
                }
            }

            if (model.recent.isNotEmpty()) {
                item("recent-header") { TESectionHeader("Recent events") }
                items(model.recent, key = { "ev-${it.id}" }) { event ->
                    TENavCard(onClick = { onOpenEvent(event.id) }) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    event.trackName,
                                    style = TrackTheme.typography.bodyStrong,
                                    color = colors.textStrong,
                                )
                                TEMeta(listOf(EventDates.fmtDate(event.startDate), event.club, event.runGroup))
                            }
                            Text(
                                LapTime.fmtMs(event.bestMs),
                                style = TrackTheme.typography.lapTime,
                                color = colors.textStrong,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** The nearest upcoming event, with its countdown and checklist progress. */
@Composable
private fun HeroCard(event: Event, onClick: () -> Unit) {
    val colors = TrackTheme.colors
    val done = event.checklist?.count { it.done } ?: 0
    val total = event.checklist?.size ?: 0

    TENavCard(onClick = onClick) {
        Text("Next event", style = TrackTheme.typography.eyebrow, color = colors.accentInk)
        Text(event.trackName, style = TrackTheme.typography.h2, color = colors.textStrong)
        TEMeta(listOf(EventDates.fmtDate(event.startDate), event.club, event.runGroup))
        Text(
            EventDates.fmtCountdown(event.startDate),
            style = TrackTheme.typography.bodyStrong,
            color = colors.accentInk,
            modifier = Modifier.padding(top = 6.dp),
        )
        if (total > 0) {
            Text(
                if (done == total) "Prep checklist — all done ✓" else "Prep checklist — $done/$total",
                style = TrackTheme.typography.xs,
                color = if (done == total) colors.positive else colors.textMuted,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}

/** A track with its best time and, once there are two events, its trend. */
@Composable
private fun TrackRow(track: Track, onClick: () -> Unit) {
    val colors = TrackTheme.colors
    TENavCard(onClick = onClick) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(Modifier.weight(1f)) {
                Text(track.name, style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
                TEMeta(
                    listOf(
                        fmtCount(track.eventCount, "event"),
                        fmtCount(track.trackDays, "day"),
                        EventDates.fmtDate(track.lastDate),
                    ),
                )
            }
            Text(
                LapTime.fmtMs(track.bestMs),
                style = TrackTheme.typography.lapTime,
                color = colors.textStrong,
            )
        }
        // Two points is the minimum that can show a direction; one is a dot.
        if (track.series.size >= 2) {
            ProgressChart(
                points = track.series.mapIndexed { i, p ->
                    ProgressPoint(x = i.toDouble(), label = "", ms = p.bestMs)
                },
                style = ProgressChartStyle.Sparkline,
            )
        }
    }
}
