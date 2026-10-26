package app.trackevolution.screens

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.trackevolution.core.ChannelGraphs
import app.trackevolution.core.Corners
import app.trackevolution.core.TraceSample
import app.trackevolution.core.VideoSync
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.LogbookOwner
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.model.Session
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.charts.LapChannelChart
import app.trackevolution.ui.stage.LapStageHolder
import app.trackevolution.ui.stage.LapStagePage
import app.trackevolution.ui.stage.rememberLapStageHolder
import app.trackevolution.ui.stage.stageSide
import app.trackevolution.ui.theme.TrackTheme

/**
 * A session's multi-lap channel overlay as a destination of its own (#268):
 * the chips-and-charts panel the session card used to inline, reached from
 * the card's *Compare laps* button and from a lap's detail — which names the
 * lap to light first, beside its reference.
 *
 * Since NS-51 the **two-sided lap stage** sits above the chips: its sides are
 * `VideoSync.stageSides` over the lit laps — A the lap this was opened for
 * while it is lit, else the newest lit; B the fastest other — so lighting a lap
 * changes the stage, and both laps' videos play from one transport. With fewer
 * than two lit laps, or for a free account (B and the delta are Pro), the stage
 * is one-sided.
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
    /** Signs a clip's URL — the owner's client. Null plays nothing (replay only). */
    videoApi: ApiClient? = null,
    owner: LogbookOwner = LogbookOwner.Me,
    viewer: Entitlement? = null,
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
        val initial = remember(session.id, lapId) { LapDetail.comparePreselect(session, lapId) }
        val matched = remember(session) { ChannelGraphs.matchLapsToChannels(session.laps, channels.laps) }
        var lit by rememberSaveable(session.id) {
            mutableStateOf(initial ?: ChannelGraphs.initialSelection(matched))
        }
        val opened = matched.firstOrNull { it.lap.id == lapId && it.hasChannels }?.chIdx
        val canPlay = videoApi != null && Entitlement.canSaveLapVideo(owner.entitlement(viewer))
        val binding = remember(lit, canPlay, canViewChannels, session) {
            sessionBinding(session, matched, lit, opened, canPlay, canViewChannels)
        }
        val holder = rememberLapStageHolder("session-${session.id}")
        LaunchedEffect(binding) {
            binding?.let { b -> holder.bind(b, { id -> videoApi!!.clipUrl(id).url }) }
        }
        val trace = remember(session.trace) {
            session.trace?.takeIf { it.size >= 10 }?.map { TraceSample(x = it.x, y = it.y, v = it.v) }
        }
        val panel: androidx.compose.foundation.lazy.LazyListScope.() -> Unit = {
            item("charts") {
                LapChannelChart(
                    channels = channels,
                    laps = session.laps,
                    modifier = Modifier.fillMaxWidth(),
                    initialSelection = lit,
                    pro = canViewChannels,
                    onSubscribe = onSubscribe,
                    playhead = if (binding != null) holder.playhead else null,
                    onSeek = if (binding != null) holder::seekGrid else null,
                    onScrub = if (binding != null) holder::scrubGrid else null,
                    onLitChange = { lit = it },
                )
            }
        }
        val header: androidx.compose.foundation.lazy.LazyListScope.() -> Unit = {
            item("title") {
                Text(session.label ?: "Compare laps", style = TrackTheme.typography.h2, color = colors.textStrong)
            }
        }
        if (binding == null || holder.binding == null) {
            androidx.compose.foundation.lazy.LazyColumn(
                Modifier.padding(horizontal = 16.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 12.dp),
            ) {
                header()
                panel()
            }
            return@TELoadable
        }
        LapStagePage(holder = holder, trace = trace, header = header, body = panel)
    }
}

/**
 * The session stage's binding over the lit laps: `stageSides` picks A and B;
 * a clip is playable only when the viewer may play the owner's videos; B (and
 * with it the delta) only for Pro. Null when nothing lit carries a speed trace.
 */
internal fun sessionBinding(
    session: Session,
    matched: List<ChannelGraphs.LapMatch>,
    lit: List<Int>,
    opened: Int?,
    canPlay: Boolean,
    canViewChannels: Boolean,
): LapStageHolder.Binding? {
    val channels = session.channels ?: return null
    val picks = VideoSync.stageSides(lit, channels.laps, opened) ?: return null
    val best = session.laps.minOfOrNull { it.timeMs }
    fun side(key: VideoSync.SideKey, chIdx: Int): LapStageHolder.SideInfo? {
        val entry = channels.laps.getOrNull(chIdx) ?: return null
        val lap = matched.firstOrNull { it.chIdx == chIdx }?.lap
        return stageSide(
            key, entry, channels.dStepM, lap?.lapNum ?: entry.n,
            clip = lap?.clip?.takeIf { canPlay },
            best = lap != null && lap.timeMs == best,
            chIdx = chIdx,
        )
    }
    val a = side(VideoSync.SideKey.A, picks.a) ?: return null
    val b = picks.b?.takeIf { canViewChannels }?.let { side(VideoSync.SideKey.B, it) }
    return LapStageHolder.Binding(
        key = "session-${session.id}-${picks.a}-${b?.chIdx}-$canPlay",
        a = a,
        b = b,
        showB = true,
        corners = Corners.sessionCorners(channels),
    )
}
