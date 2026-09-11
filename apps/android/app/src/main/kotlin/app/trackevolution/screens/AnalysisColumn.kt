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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.trackevolution.core.ChannelGraphs
import app.trackevolution.core.LapTime
import app.trackevolution.core.TraceSample
// Aliased: `TrackMap` is also the *composable* that draws the map, imported
// below. One is the geometry and one is the picture, and they deliberately share
// the name of the JS module they both come from — so the import says which.
import app.trackevolution.core.TrackMap as TrackMapGeometry
import app.trackevolution.core.model.Session
import app.trackevolution.ui.TESectionHeader
import app.trackevolution.ui.charts.ChannelHit
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

    // Where the panel is pointing, if anywhere — the friction circle's tapped
    // sample. Held here rather than in the panel because the *map* is what
    // answers it, and the map is this column's, not the panel's.
    var hit by remember(selectedSessionId) { mutableStateOf<ChannelHit?>(null) }

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
            TrackMap(
                trace = samples,
                markers = markers,
                highlight = ringedIndex(selected, hit),
            )
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
                    onHit = { hit = it },
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

/**
 * Where to ring the map for the current hit, or null for "don't".
 *
 * The stored trace is **one lap** — the session's best — so a sample from any
 * other lap has no place on it, and ringing one anyway would put the mark where
 * that lap never was. Same constraint the limit marks work under
 * ([Limits.limitMarkers]), and the same rule the web states in `bindBalance`: a
 * hit with no lap of its own (`chIdx` null) is a place every lap shares, so it
 * rings whichever lap the trace is.
 */
private fun ringedIndex(session: Session, hit: ChannelHit?): Int? {
    if (hit == null) return null
    val trace = session.trace ?: return null
    if (hit.chIdx != null && hit.chIdx != tracedChannelIndex(session)) return null
    return TrackMapGeometry.traceIndexAtFraction(trace, hit.frac)
}

/**
 * The channel-lap the stored trace was drawn from: the session's fastest lap that
 * has channel data, matched the way the panel matches them.
 */
private fun tracedChannelIndex(session: Session): Int? {
    val channels = session.channels?.takeIf { it.laps.isNotEmpty() } ?: return null
    return ChannelGraphs.matchLapsToChannels(session.laps, channels.laps)
        .filter { it.hasChannels }
        .minByOrNull { it.lap.timeMs }
        ?.chIdx
}
