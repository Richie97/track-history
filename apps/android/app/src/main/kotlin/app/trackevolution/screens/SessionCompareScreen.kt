package app.trackevolution.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.charts.LapChannelChart
import app.trackevolution.ui.theme.TrackTheme

/**
 * A session's multi-lap channel overlay as a destination of its own (#268):
 * the chips-and-charts panel the session card used to inline, reached from
 * the card's *Compare laps* button and from a lap's detail — which names the
 * lap to light first, beside the session's best.
 *
 * At expanded width the event page has the same panel as its analysis column
 * and the card's button selects the session there instead; this destination is
 * the phone's.
 */
@Composable
fun SessionCompareScreen(
    model: EventModel,
    sessionId: Int,
    /** The lap to light first, or null for the panel's own default — the fastest. */
    lapId: Int?,
    /** The panel's Pro half (#264) — see `LapChannelChart`. */
    canViewChannels: Boolean,
    modifier: Modifier = Modifier,
    onSubscribe: () -> Unit = {},
) {
    val colors = TrackTheme.colors

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        val detail = model.detail ?: return@TELoadable
        val session = detail.sessions.firstOrNull { it.id == sessionId }
        val channels = session?.channels?.takeIf { it.laps.isNotEmpty() }
        if (session == null || channels == null) {
            TEEmpty("This session has no channel data to compare.", Modifier.padding(16.dp))
            return@TELoadable
        }
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(session.label ?: "Compare laps", style = TrackTheme.typography.h2, color = colors.textStrong)
            LapChannelChart(
                channels = channels,
                laps = session.laps,
                modifier = Modifier.fillMaxWidth(),
                initialSelection = LapDetail.comparePreselect(session, lapId),
                pro = canViewChannels,
                onSubscribe = onSubscribe,
            )
        }
    }
}
