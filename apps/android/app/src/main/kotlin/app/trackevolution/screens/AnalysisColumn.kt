package app.trackevolution.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.trackevolution.core.LapTime
import app.trackevolution.core.TraceSample
import app.trackevolution.core.model.Session
import app.trackevolution.ui.TESectionHeader
import app.trackevolution.ui.charts.LapChannelChart
import app.trackevolution.ui.charts.LimitLegend
import app.trackevolution.ui.charts.TrackMap
import app.trackevolution.ui.theme.TrackTheme

/**
 * The event page's right-hand column at expanded width (spec: NS-34 ticket 3).
 *
 * The selected session's **track map above its channel panel**, so map and charts
 * are in one eyeline. On a phone the panel lives inside the session card, a long
 * scroll away from the trace at the top of the page; a window wide enough to show
 * both at once is what makes the pairing worth having, and this is the container
 * that provides it.
 *
 * Its own scroll, deliberately: the page beside it is long and this is not, and
 * tying them together would mean scrolling past the charts to reach the sessions.
 */
@Composable
fun AnalysisColumn(
    sessions: List<Session>,
    selectedSessionId: Int?,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    val selected = sessions.firstOrNull { it.id == selectedSessionId }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(colors.bgPage)
            .verticalScroll(rememberScrollState())
            .padding(16.dp)
            .semantics { testTag = "analysisColumn" },
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (selected == null) {
            Empty(anyChannels = sessions.any { it.channels != null })
            return@Column
        }

        val trace = selected.trace
        if (!trace.isNullOrEmpty()) {
            TESectionHeader("Best lap trace", detail = "brighter is faster")
            Text(
                LapTime.fmtMs(selected.bestLapMs),
                style = TrackTheme.typography.lapTime,
                color = colors.textStrong,
            )
            // The stored trace is `TracePoint`s off the wire; the chart draws
            // `TraceSample`s, as the page's own trace section does.
            val samples = trace.map { TraceSample(x = it.x, y = it.y, v = it.v) }
            val markers = limitMarkers(selected, samples)
            TrackMap(trace = samples, markers = markers)
            LimitLegend(markers)
        }

        val channels = selected.channels
        if (channels != null) {
            TESectionHeader(selected.label ?: "Channel graphs")
            // Keyed by session id: `lit` holds *channel-lap indexes*, which mean
            // different laps in a different session, so carrying them across
            // would light the wrong ones. Remembering tab and lit state per
            // session — which NS-34 asks for — needs the panel to hand that state
            // back out, and is deferred rather than faked; see the note on #217.
            key(selected.id) {
                LapChannelChart(
                    channels = channels,
                    laps = selected.laps,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

@Composable
private fun Empty(anyChannels: Boolean) {
    val colors = TrackTheme.colors
    Column(
        modifier = Modifier.fillMaxWidth().padding(top = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            if (anyChannels) "Pick a session" else "No channel data yet",
            style = TrackTheme.typography.h3,
            color = colors.textStrong,
        )
        Text(
            if (anyChannels) {
                "Choose a session's channel graphs to see them here."
            } else {
                "Import a video or record laps on the phone, and the channels land here."
            },
            style = TrackTheme.typography.sm,
            color = colors.textMuted,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 300.dp),
        )
    }
}
