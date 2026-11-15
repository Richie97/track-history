package app.trackevolution.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import app.trackevolution.core.ChannelGraphs
import app.trackevolution.core.EventDates
import app.trackevolution.core.GeoTrace
import app.trackevolution.core.LapTime
import app.trackevolution.core.Limits
import app.trackevolution.core.MapViewer
import app.trackevolution.core.MapViewer.MapType
import app.trackevolution.core.TraceHit
import app.trackevolution.core.TraceSample
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.LapChannels
import app.trackevolution.core.model.TraceGeo
import app.trackevolution.core.model.TracePoint
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.LocalUnitSystem
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.charts.TrackMap
import app.trackevolution.ui.charts.trackMapSummary
import app.trackevolution.ui.map.LocalMapAvailable
import app.trackevolution.ui.map.MapDraw
import app.trackevolution.ui.map.MapTypePreference
import app.trackevolution.ui.map.deviceMapSupport
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Which line the viewer opens on (NS-53): one session's best lap, or one
 * leaderboard row. The route's two halves, as a value.
 */
sealed interface MapSource {
    data class Session(val eventId: Int, val sessionId: Int) : MapSource
    data class LeaderboardLap(val trackId: Int, val lapId: Int) : MapSource
}

/** Everything the viewer draws, read once. `drawMapViewer`'s arguments in `public/app.js`. */
data class MapContent(
    val title: String,
    val sub: String,
    val trace: List<TracePoint>,
    val geo: TraceGeo?,
    /** The traced lap's own channel entry, for the tap's read-out; null without one. */
    val entry: LapChannels?,
    val dStepM: Double?,
    val markers: List<Limits.Marker>,
)

/**
 * The map viewer's data (NS-53): the event the page behind it already cached,
 * or the leaderboard lap — so it opens offline, on the line. `viewSessionMap` /
 * `viewLeaderboardLapMap` in `public/app.js`. [api] is the owner's client, so a
 * coach reads a student's session through the coach mount.
 */
class TrackMapModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    val source: MapSource,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set

    var content by mutableStateOf<MapContent?>(null)
        private set

    fun load() {
        state = LoadState.Loading
        scope.launch {
            try {
                val c = when (source) {
                    is MapSource.Session -> loadSession(source)
                    is MapSource.LeaderboardLap -> loadLeaderboardLap(source)
                }
                content = c
                state = if (c == null) LoadState.Failed(NO_LINE, retryable = false) else LoadState.Ready
            } catch (e: ApiException) {
                state = LoadState.Failed(e.message ?: "Couldn't open the map.")
            }
        }
    }

    private suspend fun loadSession(s: MapSource.Session): MapContent? {
        val detail = api.event(s.eventId)
        val session = detail.sessions.firstOrNull { it.id == s.sessionId } ?: return null
        val trace = session.trace.orEmpty()
        if (trace.size < MIN_POINTS || session.laps.isEmpty()) return null
        // The lap the trace was drawn from is the session's best; its channel
        // entry is what the tap's read-out and the limit marks come from.
        val best = session.laps.minBy { it.timeMs }
        val channels = session.channels
        val row = channels?.takeIf { it.laps.isNotEmpty() }?.let { ch ->
            ChannelGraphs.matchLapsToChannels(session.laps, ch.laps).firstOrNull { it.hasChannels && it.lap.id == best.id }
        }
        val samples = trace.map { TraceSample(x = it.x, y = it.y, v = it.v) }
        return MapContent(
            title = detail.event.trackName,
            sub = "${LapTime.fmtMs(best.timeMs)} · ${EventDates.fmtDate(detail.event.startDate)}",
            trace = trace,
            geo = session.traceGeo,
            entry = row?.let { channels.laps[it.chIdx] },
            dStepM = channels?.dStepM,
            markers = limitMarkers(session, samples),
        )
    }

    private suspend fun loadLeaderboardLap(s: MapSource.LeaderboardLap): MapContent? {
        val lap = api.leaderboardLap(trackId = s.trackId, lapId = s.lapId)
        val trace = lap.trace.orEmpty()
        if (trace.size < MIN_POINTS) return null
        val track = try {
            api.tracks().firstOrNull { it.id == s.trackId }
        } catch (_: ApiException) {
            null
        }
        val entry = lap.entry
        val dStepM = lap.channels?.dStepM
        val samples = trace.map { TraceSample(x = it.x, y = it.y, v = it.v) }
        return MapContent(
            title = track?.name ?: "Leaderboard lap",
            sub = "${LapTime.fmtMs(lap.timeMs)} · ${if (lap.you) "your lap" else lap.name ?: "Driver"}",
            trace = trace,
            geo = lap.traceGeo,
            entry = entry,
            dStepM = dStepM,
            markers = if (entry != null && dStepM != null) Limits.limitMarkers(entry, dStepM, samples) else emptyList(),
        )
    }

    companion object {
        /** `TrackMap`'s floor: fewer points is a glitch, not a lap. */
        const val MIN_POINTS = 10
        const val NO_LINE = "There is no racing line to show for this lap."
    }
}

/**
 * The racing line on a real map (NS-53 ticket 3), full pane: the port of
 * `public/js/map-viewer.js`.
 *
 * Three rules shape it, the web's: **nothing loads from Google until this
 * screen is open**; **the line never depends on the map** — no anchor, no key,
 * no Play services, no connection each leave it on the drawn line with one
 * sentence saying why ([MapViewer.viewerPlan]); and **the device's own position
 * is never asked for or shown**.
 *
 * The map owns its gestures outright — pan, pinch, rotate, double-tap — which
 * is why it is a page of its own rather than inline in a scrolling one.
 */
@Composable
fun TrackMapScreen(model: TrackMapModel, onBack: () -> Unit, modifier: Modifier = Modifier) {
    LaunchedEffect(Unit) { if (model.state == LoadState.Loading && model.content == null) model.load() }
    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        val content = model.content ?: return@TELoadable
        TrackMapViewer(content, onBack, modifier)
    }
}

@Composable
internal fun TrackMapViewer(content: MapContent, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val colors = TrackTheme.colors
    val units = LocalUnitSystem.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val support = LocalMapAvailable.current ?: remember(context) { deviceMapSupport(context) }
    val preference = remember(context) { MapTypePreference(context.applicationContext) }
    val stored by preference.type.collectAsState(initial = null)

    // Decided once, when the viewer opens: the web's `loadFailed` is the
    // script not arriving, ours is no network to fetch tiles over.
    val plan = remember(content.geo, support) {
        MapViewer.viewerPlan(content.geo, mapsOn = support.available, loadFailed = support.available && !support.online())
    }
    var picked by remember { mutableStateOf<MapType?>(null) }
    val type = picked ?: MapViewer.startType(plan, stored)
    var hit by remember { mutableStateOf<TraceHit?>(null) }
    var fitKey by remember { mutableIntStateOf(0) }

    val samples = remember(content.trace) { content.trace.map { TraceSample(x = it.x, y = it.y, v = it.v) } }
    val readout = hit?.let { MapViewer.readoutText(MapViewer.placeAt(it, content.entry, content.dStepM), units) }
    val label = trackMapSummary(samples, content.markers, units) + " Map type: ${type.label}."

    Column(modifier.fillMaxSize().background(colors.bgPage).semantics { testTag = "trackMapViewer" }) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = onBack, modifier = Modifier.semantics { testTag = "mapBack" }) {
                Text("‹ Back", style = TrackTheme.typography.sm, color = colors.textMuted)
            }
            Column(Modifier.weight(1f).padding(start = 4.dp)) {
                Text(content.title, style = TrackTheme.typography.bodyStrong, color = colors.textStrong)
                Text(content.sub, style = TrackTheme.typography.xs, color = colors.textMuted)
            }
        }
        plan.note?.let { note ->
            Text(
                note,
                style = TrackTheme.typography.xs,
                color = colors.textMuted,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 4.dp)
                    .semantics { testTag = "mapNote" },
            )
        }

        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .semantics {
                    testTag = "mapStage"
                    contentDescription = label
                    // The tap's read-out without a tap: 5 % of the lap a step.
                    customActions = listOf(
                        CustomAccessibilityAction("Next point") {
                            hit = MapViewer.stepHit(content.trace, hit, 1); true
                        },
                        CustomAccessibilityAction("Previous point") {
                            hit = MapViewer.stepHit(content.trace, hit, -1); true
                        },
                    )
                },
        ) {
            val geo = content.geo
            if (type == MapType.LINE || geo == null) {
                BoxWithConstraints(Modifier.fillMaxSize().padding(12.dp)) {
                    TrackMap(
                        trace = samples,
                        markers = content.markers,
                        highlight = hit?.idx,
                        height = maxHeight,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            } else {
                val selected = hit?.let { h ->
                    val p = MapViewer.pointAlong(content.trace, h.alongM)
                    GeoTrace.unprojectTrace(listOf(TracePoint(p.x, p.y, 0.0)), geo).first()
                }
                support.drawMap(
                    MapDraw(
                        trace = content.trace,
                        geo = geo,
                        type = type,
                        markers = content.markers,
                        selected = selected,
                        fitKey = fitKey,
                        onTap = { lat, lon, metresPerDp ->
                            hit = MapViewer.tapHit(content.trace, geo, lat, lon, metresPerDp)
                        },
                    ),
                )
            }
            readout?.let {
                Text(
                    it,
                    style = TrackTheme.typography.sm,
                    color = colors.textStrong,
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .padding(12.dp)
                        .background(colors.surfaceCard, RoundedCornerShape(TrackTheme.radii.sm))
                        .border(1.dp, colors.borderHairline, RoundedCornerShape(TrackTheme.radii.sm))
                        .padding(horizontal = 10.dp, vertical = 6.dp)
                        .semantics {
                            testTag = "mapReadout"
                            liveRegion = LiveRegionMode.Polite
                        },
                )
            }
        }

        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                Modifier
                    .border(1.dp, colors.borderHairline, RoundedCornerShape(TrackTheme.radii.sm))
                    .semantics { contentDescription = "Map type" },
            ) {
                for (t in MapViewer.MAP_TYPES) {
                    val enabled = t in plan.types
                    val on = t == type
                    TextButton(
                        onClick = {
                            picked = t
                            scope.launch { preference.set(t) }
                        },
                        enabled = enabled,
                        modifier = Modifier
                            .background(if (on) colors.bgSubtle else colors.surfaceCard)
                            .semantics {
                                testTag = "mapType-${t.key}"
                                role = Role.RadioButton
                                selected = on
                            },
                    ) {
                        Text(
                            t.label,
                            style = TrackTheme.typography.sm,
                            color = when {
                                !enabled -> colors.textFaint
                                on -> colors.textStrong
                                else -> colors.textMuted
                            },
                        )
                    }
                }
            }
            Spacer(Modifier.weight(1f))
            if (type != MapType.LINE && content.geo != null) {
                TextButton(
                    onClick = { fitKey += 1 },
                    modifier = Modifier.semantics { testTag = "mapFit" },
                ) { Text("Fit", style = TrackTheme.typography.sm, color = colors.textStrong) }
            }
        }
    }
}
