package app.trackevolution.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.trackevolution.core.ChannelGraphs
import app.trackevolution.core.CompareLaps
import app.trackevolution.core.Gears
import app.trackevolution.core.LapTime
import app.trackevolution.core.Limits
import app.trackevolution.core.TraceSample
import app.trackevolution.core.Units
import app.trackevolution.core.model.EventDetail
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.Session
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.LocalUnitSystem
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.charts.LapChannelChart
import app.trackevolution.ui.charts.LimitLegend
import app.trackevolution.ui.charts.TrackMap
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlin.math.roundToInt

/**
 * What the lap detail draws (#268), computed once from the event detail. Pure,
 * so the rules — which lap gets the map, what the gap reads, what the compare
 * lights first — are tested without a view (`LapDetailTest`).
 *
 * **The map is the best lap's.** `sessions.trace` is one polyline, stored for
 * the session's best lap (migration 0005), so only that lap gets the racing
 * line; any other lap would be drawn on a line it never took. The channel
 * traces are per lap and every lap that has an entry gets its own.
 */
internal data class LapDetail(
    val session: Session,
    val lap: Lap,
    /**
     * The lap's channel entry alone in a blob of its own, so the panel draws
     * exactly this lap — the same shape the leaderboard lap uses. Null when the
     * lap stored none (hand-entered, or added by hand to an imported session).
     */
    val channels: SessionChannels?,
    /** Where the entry sits in the session's own blob, for the compare. */
    val chIdx: Int?,
    val isBest: Boolean,
    /** Milliseconds behind the session's best; 0 for the best itself. */
    val gapMs: Int,
    /** The racing line — only when this is the lap it was drawn from. */
    val trace: List<TraceSample>?,
    val markers: List<Limits.Marker>,
) {
    /** "Lap 3 of 12 · Session 2 · +0.412 vs best", or "★ best of the session". */
    val subtitle: String
        get() = listOf(
            "Lap ${lap.lapNum} of ${session.laps.size}",
            session.label ?: "Session",
            if (isBest) "★ best of the session" else "${LapTime.fmtDelta(gapMs)} vs best",
        ).joinToString(" · ")

    /** Whether the session has an overlay to open at all. */
    val canCompare: Boolean
        get() = !session.channels?.laps.isNullOrEmpty()

    companion object {
        fun build(detail: EventDetail, sessionId: Int, lapId: Int): LapDetail? {
            val session = detail.sessions.firstOrNull { it.id == sessionId } ?: return null
            val lap = session.laps.firstOrNull { it.id == lapId } ?: return null
            val best = session.bestLapMs ?: lap.timeMs
            val isBest = lap.timeMs == best
            val stored = session.channels?.takeIf { it.laps.isNotEmpty() }
            val match = stored
                ?.let { ChannelGraphs.matchLapsToChannels(session.laps, it.laps) }
                ?.firstOrNull { it.lap.id == lap.id }
                ?.takeIf { it.hasChannels }
            val channels = if (stored != null && match != null) {
                SessionChannels(v = 1, dStepM = stored.dStepM, laps = listOf(stored.laps[match.chIdx]))
            } else {
                null
            }
            // Ten points is `TrackMap`'s floor, as on the event page.
            val traced = isBest && (session.trace?.size ?: 0) >= 10
            val samples = if (traced) session.trace.orEmpty().map { TraceSample(x = it.x, y = it.y, v = it.v) } else null
            return LapDetail(
                session = session,
                lap = lap,
                channels = channels,
                chIdx = match?.chIdx,
                isBest = isBest,
                gapMs = lap.timeMs - best,
                trace = samples,
                markers = samples?.let { limitMarkers(session, it) } ?: emptyList(),
            )
        }

        /**
         * What the compare lights first: this lap, then the session's best
         * beside it when that is a different lap — the comparison anyone opening
         * a lap wants. Null (the panel's own default, the fastest) when the lap
         * has no entry to light, or no lap was named.
         */
        fun comparePreselect(session: Session, lapId: Int?): List<Int>? {
            val stored = session.channels?.takeIf { it.laps.isNotEmpty() } ?: return null
            val matched = ChannelGraphs.matchLapsToChannels(session.laps, stored.laps).filter { it.hasChannels }
            val mine = matched.firstOrNull { it.lap.id == lapId } ?: return null
            val best = matched.minByOrNull { it.lap.timeMs } ?: return listOf(mine.chIdx)
            return if (best.chIdx == mine.chIdx) listOf(mine.chIdx) else listOf(mine.chIdx, best.chIdx)
        }
    }
}

/**
 * One lap of one session (#268): its time, its racing line when it is the lap
 * the session's trace was drawn from, its channel traces, and a door to the
 * multi-lap compare.
 *
 * Reached from a lap row on the event page. Reads the event detail through the
 * same `EventModel` the page uses — the same offline-cached read — and finds
 * its session and lap in it, so a lap opened in a paddock costs no request.
 * Everything below the time is optional: a hand-entered lap is a time and a
 * sentence, and the screen says which of the rest it has rather than drawing
 * empty frames.
 */
@Composable
fun LapDetailScreen(
    model: EventModel,
    sessionId: Int,
    lapId: Int,
    /** The panel's Pro half (#264) — see `LapChannelChart`. */
    canViewChannels: Boolean,
    onCompare: () -> Unit,
    modifier: Modifier = Modifier,
    onSubscribe: () -> Unit = {},
) {
    val colors = TrackTheme.colors
    val units = LocalUnitSystem.current

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        val detail = model.detail ?: return@TELoadable
        val view = LapDetail.build(detail, sessionId, lapId)
        if (view == null) {
            // The lap was deleted under us — from another device, or on the
            // page underneath after this was opened.
            TEEmpty("This lap is no longer in the logbook.", Modifier.padding(16.dp))
            return@TELoadable
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("head") {
                val spoken = "${LapTime.fmtMs(view.lap.timeMs)}, ${view.subtitle}"
                Column(
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                    modifier = Modifier.testTag("lapDetail").semantics { contentDescription = spoken },
                ) {
                    Text(LapTime.fmtMs(view.lap.timeMs), style = TrackTheme.typography.h1, color = colors.textStrong)
                    Text(view.subtitle, style = TrackTheme.typography.sm, color = colors.textMuted)
                }
            }

            if (view.canCompare) {
                item("compare") {
                    // The session's overlay as its own destination, with this lap
                    // lit first — the same panel the session card used to inline.
                    TextButton(onClick = onCompare, modifier = Modifier.testTag("compareLaps")) {
                        Text("Compare laps →", style = TrackTheme.typography.sm, color = colors.accentInk)
                    }
                }
            }

            val trace = view.trace
            if (trace != null) {
                item("map") {
                    TrackCard(Modifier.fillMaxWidth()) {
                        Text(
                            "Racing line — brighter is faster",
                            style = TrackTheme.typography.xs,
                            color = colors.textFaint,
                        )
                        TrackMap(
                            trace = trace,
                            markers = view.markers,
                            modifier = Modifier.fillMaxWidth().height(220.dp),
                        )
                        LimitLegend(view.markers, Modifier.padding(top = 6.dp))
                    }
                }
            }

            val channels = view.channels
            val entry = channels?.laps?.firstOrNull()
            if (channels != null && entry != null) {
                item("facts") { Facts(CompareLaps.lapMetrics(entry), units) }
                item("charts-hint") {
                    Text("Tap a chart to read values.", style = TrackTheme.typography.xs, color = colors.textFaint)
                }
                item("charts") {
                    LapChannelChart(
                        channels = channels,
                        laps = listOf(view.lap),
                        initialSelection = listOf(0),
                        pro = canViewChannels,
                        onSubscribe = onSubscribe,
                    )
                }
            } else if (trace == null) {
                item("empty") {
                    TEEmpty(
                        "No telemetry for this lap. Record with the app or import a video, " +
                            "and its racing line and traces land here.",
                    )
                }
            }
        }
    }
}

/**
 * The lap's numbers, from the same reduction the two-lap compare's head-to-head
 * uses. A figure the lap didn't store is a row that isn't there.
 */
@Composable
private fun Facts(m: CompareLaps.Metrics, units: UnitSystem) {
    val colors = TrackTheme.colors
    val rows = listOfNotNull(
        m.topSpeedKph?.let { "Top speed" to Units.fmtSpeedKph(it, units) },
        m.minSpeedKph?.let { "Min speed" to Units.fmtSpeedKph(it, units) },
        m.avgSpeedKph?.let { "Avg speed" to Units.fmtSpeedKph(it, units) },
        m.maxRpm?.let { "Max RPM" to "${Gears.fmtRpm(it)} rpm" },
        m.maxLatG?.let { "Max lateral G" to String.format("%.2f G", it) },
        m.fullThrottlePct?.let { "Full throttle" to "${it.roundToInt()}% of lap" },
        m.brakingPct?.let { "On the brakes" to "${it.roundToInt()}% of lap" },
    )
    if (rows.isEmpty()) return
    TrackCard(Modifier.fillMaxWidth().testTag("lapFacts")) {
        rows.forEachIndexed { index, (label, value) ->
            if (index > 0) HorizontalDivider(color = colors.borderHairline)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 6.dp)
                    .semantics { contentDescription = "$label: $value" },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(label, style = TrackTheme.typography.sm, color = colors.textMuted, modifier = Modifier.weight(1f))
                Text(value, style = TrackTheme.typography.lapTime, color = colors.textStrong)
            }
        }
    }
}
