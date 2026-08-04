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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.trackevolution.core.EventDates
import app.trackevolution.core.LapTime
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.ShareData
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.fmtCount
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.TEMeta
import app.trackevolution.ui.TESectionHeader
import app.trackevolution.ui.TEStatRow
import app.trackevolution.ui.charts.ProgressChart
import app.trackevolution.ui.charts.ProgressChartStyle
import app.trackevolution.ui.charts.ProgressPoint
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Somebody else's logbook, read-only (`GET /api/share/:slug`).
 *
 * This is where an App Link lands — `/share/<slug>` is the only pattern
 * `src/routes/wellKnown.ts` advertises — so it has to exist even though it is
 * not one of NS-26's five screens: without it a shared link opens a blank app,
 * which is precisely the dead end the spec rules out.
 *
 * **Nothing here is tappable through to a private screen.** The payload is a
 * different shape from the authed one on purpose (`SharedEvent`/`SharedTrack`
 * carry no notes, no laps, no garage linkage), and a row that navigated into the
 * signed-in logbook would be showing the wrong person's data.
 */
class SharedLogbookModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    val slug: String,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set

    var data by mutableStateOf<ShareData?>(null)
        private set

    fun load() {
        scope.launch {
            try {
                data = api.sharedLogbook(slug)
                state = LoadState.Ready
            } catch (e: ApiException) {
                state = LoadState.Failed(e.message ?: "That shared logbook isn't available.")
            }
        }
    }
}

@Composable
fun SharedLogbookScreen(model: SharedLogbookModel, modifier: Modifier = Modifier) {
    val colors = TrackTheme.colors
    val listState = rememberLazyListState()

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        val data = model.data ?: return@TELoadable

        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("head") {
                Column {
                    Text(data.name ?: "Shared logbook", style = TrackTheme.typography.h1, color = colors.textStrong)
                    Text("A read-only track history. Notes and per-lap data stay private.", style = TrackTheme.typography.sm, color = colors.textMuted)
                }
            }

            item("totals") {
                TEStatRow(
                    listOf(
                        "Events" to data.totals.events.toString(),
                        "Track days" to data.totals.trackDays.toString(),
                        "Tracks" to data.tracks.size.toString(),
                    ),
                )
            }

            item("tracks-header") { TESectionHeader("Tracks") }
            if (data.tracks.isEmpty()) {
                item("tracks-empty") { TEEmpty("Nothing logged here yet.") }
            } else {
                items(data.tracks, key = { "tr-${it.id}" }) { track ->
                    TrackCard(Modifier.fillMaxWidth()) {
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
                            Text(LapTime.fmtMs(track.bestMs), style = TrackTheme.typography.lapTime, color = colors.textStrong)
                        }
                        if (track.series.size >= 2) {
                            ProgressChart(
                                points = track.series.mapIndexed { i, point ->
                                    ProgressPoint(x = i.toDouble(), label = "", ms = point.bestMs)
                                },
                                style = ProgressChartStyle.Sparkline,
                            )
                        }
                    }
                }
            }

            item("events-header") { TESectionHeader("Events") }
            items(data.events, key = { "ev-${it.id}" }) { event ->
                TrackCard(Modifier.fillMaxWidth()) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(event.trackName, style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
                            TEMeta(
                                listOf(
                                    EventDates.fmtDate(event.startDate),
                                    event.club,
                                    event.runGroup,
                                    event.conditions?.rawValue,
                                ),
                            )
                        }
                        Text(LapTime.fmtMs(event.bestMs), style = TrackTheme.typography.lapTime, color = colors.textStrong)
                    }
                }
            }
        }
    }
}
