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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.trackevolution.core.ChannelGraphs
import app.trackevolution.core.CompareLaps
import app.trackevolution.core.Corners
import app.trackevolution.core.VideoSync
import app.trackevolution.core.Gears
import app.trackevolution.core.LapTime
import app.trackevolution.core.Limits
import app.trackevolution.core.TraceSample
import app.trackevolution.core.Units
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.LogbookOwner
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.model.EventDetail
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.Session
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.LocalUnitSystem
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TEEmptyAction
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.charts.LapChannelChart
import app.trackevolution.ui.charts.LimitLegend
import app.trackevolution.ui.charts.TrackMap
import app.trackevolution.ui.stage.LapStageHolder
import app.trackevolution.ui.stage.LapStagePage
import app.trackevolution.ui.stage.LapStepper
import app.trackevolution.ui.stage.StageHandoff
import app.trackevolution.ui.stage.rememberLapStageHolder
import app.trackevolution.ui.stage.stageSide
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
            val matched = ChannelGraphs.matchLapsToChannels(session.laps, stored.laps)
            val mine = matched.firstOrNull { it.lap.id == lapId && it.hasChannels } ?: return null
            // The stage's reference (NS-51): the session best, or the next-best
            // when this lap *is* the best — so the compare always opens on two.
            val ref = VideoSync.referenceLap(matched, mine.chIdx) ?: return listOf(mine.chIdx)
            return listOf(mine.chIdx, ref.chIdx)
        }

        /**
         * The single-lap stage's reference lap (NS-51): its channel index and
         * lap, or null when the session has no other lap with channels.
         */
        fun reference(session: Session, chIdx: Int?): ChannelGraphs.LapMatch? {
            val stored = session.channels?.takeIf { it.laps.isNotEmpty() } ?: return null
            return VideoSync.referenceLap(ChannelGraphs.matchLapsToChannels(session.laps, stored.laps), chIdx)
        }

        /**
         * The neighbouring laps with a clip, for the stage's stepper (NS-50
         * every-lap sessions): the previous and next by lap number.
         */
        fun clipNeighbours(session: Session, lap: Lap): Pair<Lap?, Lap?> {
            val withClips = session.laps.filter { it.clip != null }.sortedBy { it.lapNum }
            if (lap.clip == null || withClips.size < 2) return null to null
            return withClips.lastOrNull { it.lapNum < lap.lapNum } to withClips.firstOrNull { it.lapNum > lap.lapNum }
        }
    }
}

/**
 * One lap of one session (#268): its time, its stage and its channel traces,
 * and a door to the two-lap compare.
 *
 * Since NS-51 a lap with a channel entry opens **video-first**: the lap stage
 * (`ui/stage/`) — its video when it has one, replay on the map when it doesn't
 * — over the channel panel, every chart carrying the playhead, and the facts
 * last. The stage is one-sided, its delta measured against [LapDetail.reference].
 * A lap with no channel entry is today's page: its time, the plain video card,
 * the racing line if it is the best.
 *
 * Reached from a lap row on the event page. Reads the event detail through the
 * same `EventModel` the page uses — the same offline-cached read — and finds
 * its session and lap in it, so a lap opened in a paddock costs no request.
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
    /** The empty state's next step (#342): the importer for this lap's event. Null hides it. */
    onImport: (() -> Unit)? = null,
    /**
     * The best-lap video's client (NS-45) — the **owner's**, so a student's
     * URL comes through the coach mount. Null draws no video.
     */
    videoApi: ApiClient? = null,
    owner: LogbookOwner = LogbookOwner.Me,
    /** The viewer's own tier; [owner] decides whose is read. */
    viewer: Entitlement? = null,
    /**
     * The stage's lap stepper (NS-51): open [lapId] instead of this lap,
     * keeping the playhead's grid index. The host replaces the destination, so
     * Back still returns to the event. Null hides the stepper.
     */
    onStepLap: ((lapId: Int, k: Double?) -> Unit)? = null,
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
        val channels = view.channels
        val entry = channels?.laps?.firstOrNull()
        if (channels != null && entry != null && entry.speed != null && (entry.speed?.size ?: 0) >= 2) {
            StagedLap(
                view = view,
                channels = channels,
                canViewChannels = canViewChannels,
                onCompare = onCompare,
                onSubscribe = onSubscribe,
                videoApi = videoApi,
                owner = owner,
                viewer = viewer,
                onStepLap = onStepLap,
                onDeleted = model::load,
            )
            return@TELoadable
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("head") { LapHead(view) }

            if (videoApi != null) {
                // Above the trace (NS-45): the video is what a debrief opens on.
                item("video") {
                    LapVideoCard(
                        api = videoApi,
                        owner = owner,
                        viewer = viewer,
                        sessionId = view.session.id,
                        lap = view.lap,
                        sessionLaps = view.session.laps,
                        onSubscribe = onSubscribe,
                        onDeleted = model::load,
                    )
                }
            }

            if (view.canCompare) {
                item("compare") { CompareButton(onCompare) }
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

            if (channels != null && entry != null) {
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
                        emptyText = "No channel data for this lap.",
                    )
                }
                item("facts") { Facts(CompareLaps.lapMetrics(entry), units) }
            } else if (trace == null) {
                item("empty") {
                    TEEmpty(
                        "No telemetry for this lap. Import a session, or record laps with the app, " +
                            "and its racing line and traces land here.",
                        action = onImport?.let { TEEmptyAction("Import a session", it) },
                    )
                }
            }
        }
    }
}

@Composable
private fun LapHead(view: LapDetail) {
    val colors = TrackTheme.colors
    val spoken = "${LapTime.fmtMs(view.lap.timeMs)}, ${view.subtitle}"
    Column(
        verticalArrangement = Arrangement.spacedBy(4.dp),
        modifier = Modifier.testTag("lapDetail").semantics { contentDescription = spoken },
    ) {
        Text(LapTime.fmtMs(view.lap.timeMs), style = TrackTheme.typography.h1, color = TrackTheme.colors.textStrong)
        Text(view.subtitle, style = TrackTheme.typography.sm, color = colors.textMuted)
    }
}

@Composable
private fun CompareButton(onCompare: () -> Unit) {
    // The two-lap stage as its own destination (NS-51), this lap beside its
    // reference — the session's overlay with both lit.
    TextButton(onClick = onCompare, modifier = Modifier.testTag("compareLaps")) {
        Text("Compare laps →", style = TrackTheme.typography.sm, color = TrackTheme.colors.accentInk)
    }
}

/**
 * The lap page with a stage (NS-51): header, the stage (one-sided, the delta to
 * the reference lap), the panel inline under it carrying the playhead — a tap
 * on any chart pauses and seeks the video — and the facts last.
 */
@Composable
private fun StagedLap(
    view: LapDetail,
    channels: SessionChannels,
    canViewChannels: Boolean,
    onCompare: () -> Unit,
    onSubscribe: () -> Unit,
    videoApi: ApiClient?,
    owner: LogbookOwner,
    viewer: Entitlement?,
    onStepLap: ((Int, Double?) -> Unit)?,
    onDeleted: () -> Unit,
) {
    val colors = TrackTheme.colors
    val units = LocalUnitSystem.current
    val entry = channels.laps.first()
    val session = view.session
    val stored = session.channels!!
    val clip = view.lap.clip
    val canPlay = videoApi != null && clip != null && Entitlement.canSaveLapVideo(owner.entitlement(viewer))
    val lockedNote = when {
        clip == null || canPlay || videoApi == null -> null
        owner is LogbookOwner.Student -> LapVideoState.StudentLocked(owner.name).text
        else -> "Lap ${view.lap.lapNum} · video is Pro · replaying telemetry"
    }
    // The delta and a second lap are Pro (canViewChannels); a free account's
    // stage is one-sided with no reference.
    val ref = if (canViewChannels) LapDetail.reference(session, view.chIdx) else null
    val corners = remember(stored) { Corners.sessionCorners(stored) }
    val binding = remember(view.lap.id, ref?.chIdx, canPlay, entry, stored) {
        val a = stageSide(VideoSync.SideKey.A, entry, channels.dStepM, view.lap.lapNum, clip?.takeIf { canPlay }, view.isBest, 0, lockedNote)
        val b = ref?.let { r ->
            stageSide(VideoSync.SideKey.B, stored.laps[r.chIdx], stored.dStepM, r.lap.lapNum, null, false, null)
        }
        a?.let { LapStageHolder.Binding(key = "lap-${view.lap.id}-${ref?.chIdx}-$canPlay", a = it, b = b, showB = false, corners = corners) }
    }
    if (binding == null) return
    val holder = rememberLapStageHolder("${session.id}-${view.lap.id}")
    LaunchedEffect(binding) {
        val api = videoApi
        holder.bind(binding, { id -> api!!.clipUrl(id).url }, startK = StageHandoff.take(view.lap.id))
    }
    val (prev, next) = remember(session, view.lap) { LapDetail.clipNeighbours(session, view.lap) }
    val stepper = if (onStepLap != null && (prev != null || next != null)) {
        val here = { holder.playhead.value?.k }
        LapStepper(
            prevLabel = prev?.let { "Lap ${it.lapNum}" },
            nextLabel = next?.let { "Lap ${it.lapNum}" },
            onPrev = { prev?.let { onStepLap(it.id, here()) } },
            onNext = { next?.let { onStepLap(it.id, here()) } },
        )
    } else {
        null
    }
    val trace = remember(session.trace) {
        session.trace?.takeIf { it.size >= 10 }?.map { TraceSample(x = it.x, y = it.y, v = it.v) }
    }
    val notice: (@Composable () -> Unit)? = if (clip != null && !canPlay && videoApi != null && owner !is LogbookOwner.Student) {
        {
            app.trackevolution.ui.TEProLocked(
                title = "Lap video",
                blurb = LapVideoText.LOCKED_BLURB,
                onSubscribe = onSubscribe,
                modifier = Modifier.testTag("lapVideoLocked"),
            )
        }
    } else {
        null
    }
    if (holder.binding == null) return
    LapStagePage(
        holder = holder,
        trace = trace,
        stepper = stepper,
        notice = notice,
        header = {
            item("head") { LapHead(view) }
            if (view.canCompare) item("compare") { CompareButton(onCompare) }
        },
    ) {
        item("charts-hint") {
            Text(
                "Tap a chart to move the video there.",
                style = TrackTheme.typography.xs,
                color = colors.textFaint,
            )
        }
        item("charts") {
            LapChannelChart(
                channels = channels,
                laps = listOf(view.lap),
                initialSelection = listOf(0),
                pro = canViewChannels,
                onSubscribe = onSubscribe,
                emptyText = "No channel data for this lap.",
                playhead = holder.playhead,
                onSeek = holder::seekGrid,
                onScrub = holder::scrubGrid,
            )
        }
        item("facts") { Facts(CompareLaps.lapMetrics(entry), units) }
        if (canPlay && clip != null && videoApi != null && !owner.readOnly) {
            item("video-menu") { StageVideoMenu(videoApi, clip.id, onDeleted) }
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
