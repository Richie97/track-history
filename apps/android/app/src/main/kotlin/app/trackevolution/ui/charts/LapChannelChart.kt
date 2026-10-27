package app.trackevolution.ui.charts

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import app.trackevolution.core.ChannelGraphs
import app.trackevolution.core.LapAxis
import app.trackevolution.core.TraceSample
import app.trackevolution.core.Units
import app.trackevolution.core.VideoSync
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.Health
import app.trackevolution.core.ChartScale
import app.trackevolution.core.LapTime
import app.trackevolution.core.Limits
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import app.trackevolution.core.api.LogbookOwner
import app.trackevolution.ui.LocalChannelFreeNote
import app.trackevolution.ui.LocalLogbookOwner
import app.trackevolution.ui.studentFreeNote
import app.trackevolution.ui.LocalUnitSystem
import kotlin.math.abs
import kotlin.math.max

/**
 * A place on a lap, pointed at from one chart and answered on the others.
 *
 * The port of the `hit` the web's `bindGripCircle` / `bindBalance` hand to
 * `onHover` (`{ chIdx, k, d, frac }`), under the same field names. It exists so
 * tapping a sample on the friction circle can mark that distance across every
 * chart *and* ring the place on the track map — the behaviour NS-34 ticket 3
 * takes back from the web now that the panel sits beside the map rather than
 * inside a session card.
 *
 * [chIdx] is null for a place every lap shares — a corner row rather than a
 * sample — which is what tells the map it may ring it whichever lap the trace
 * happens to be.
 */
data class ChannelHit(
    val chIdx: Int?,
    /** The grid sample index. */
    val k: Int,
    /** How far round the lap, 0..1. What the map is placed by. */
    val frac: Double,
)

/**
 * Every lap of an imported session on one lap axis (NS-24) — the port of
 * `public/js/channel-graphs.js`.
 *
 * Up to three laps are highlighted in the slot colours and the rest draw as a
 * dim envelope behind them, which is what makes a single lap readable against
 * the shape of the whole session.
 *
 * **The chips are the legend.** Identity is never colour-alone — each chip
 * carries its lap number and time next to its dot, so the chart is usable
 * without colour vision and with a screen reader.
 *
 * The x-axis is driven distance by default, or each lap's own elapsed time (the
 * Distance / Time switch); the **cursor** is a place picked on that axis — a tap
 * parks it, a mouse borrows it — drawn as a line on every lap-axis chart, a dot
 * and a value on each lit lap's trace, and a dot per lit lap on the track map.
 * The axis and cursor maths are `LapAxis` in `:core`, pinned to the web by
 * `contracts/logic/lap-axis.json`.
 *
 * The matching, selection and axis maths are `ChannelGraphs` in `:core`, pinned
 * to the web implementation by `contracts/logic/channels.json`. This file draws.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun LapChannelChart(
    channels: SessionChannels,
    laps: List<Lap>,
    modifier: Modifier = Modifier,
    /**
     * Where the panel is currently pointing, for whatever is drawn beside it
     * (NS-34 ticket 3). Defaulted to a no-op: inside a session card there is
     * nothing beside the panel to answer.
     */
    onHit: (ChannelHit?) -> Unit = {},
    /**
     * Channel-lap indexes to start highlighted, in slot order. Null means the
     * fastest lap — what the event page's overlay wants. The compare-laps
     * screen passes both laps of its pair.
     */
    initialSelection: List<Int>? = null,
    /**
     * Whether the account gets the Pro half of the panel (#264). A free
     * account's [channels] already arrive with only speed, throttle and brake —
     * the server strips the rest — but the delta plot, the sector table, the
     * shift points, the friction circle, the balance read-out and the Car tab
     * all derive from what is left, so they are the panel's own gate: with
     * `pro = false` none of them draw, and a card under the charts says what
     * the rest of the recording would show, its button going to [onSubscribe].
     */
    pro: Boolean = true,
    onSubscribe: () -> Unit = {},
    /** What an empty panel says — "this session" by default, "this lap" on the lap page (#343). */
    emptyText: String = "No channel data for this session.",
    /**
     * The session's best-lap trace. When given, the panel draws its own small
     * track map at the top of the Traces tab with the cursor's dots on it — for
     * the places the panel has no map beside it (the session compare, the lap
     * page, a shared item). The dots go by fraction of each lap, so every lit
     * lap gets one on the best lap's line, as on the web.
     */
    trace: List<TraceSample>? = null,
    /**
     * The cursor's dots, one per lit lap, for a map drawn *beside* the panel
     * (the event page's analysis column) — null when nothing is marked.
     */
    onCursor: (List<MapDot>?) -> Unit = {},
    /**
     * The lap stage's playhead (NS-51), or null with no stage. A `State` read
     * only in each plot's draw phase, so a video frame moves the line without
     * recomposing a chart.
     */
    playhead: State<LapPlayhead?>? = null,
    /**
     * With a stage, what a tap on a chart does instead of parking the cursor:
     * pause and seek the stage to that fractional grid index on side A's lap.
     * The cursor is the panel's own only while this is null — on a stage the
     * playhead *is* the mark, so nothing is parked, borrowed or put on a map.
     */
    onSeek: ((Double) -> Unit)? = null,
    /** A mouse dragging across a chart with its button down: a fast seek per move. */
    onScrub: ((Double) -> Unit)? = null,
    /** The lit laps, as they change — the session stage picks its sides from them. */
    onLitChange: ((List<Int>) -> Unit)? = null,
) {
    val colors = TrackTheme.colors
    val units = LocalUnitSystem.current
    val matches = remember(channels, laps) { ChannelGraphs.matchLapsToChannels(laps, channels.laps) }
    val present = remember(channels) { ChannelGraphs.presentChannels(channels) }

    // Survives rotation: losing a three-lap comparison to a screen turn would
    // mean rebuilding it by hand.
    var lit by rememberSaveable(channels) {
        mutableStateOf(initialSelection ?: ChannelGraphs.initialSelection(matches))
    }

    // Where the friction circle, the balance table or a sector heading is
    // pointing (NS-34 ticket 3), and whether a tap put it there or a mouse is
    // merely passing over (ticket 5) — see [PanelPointer]. Deliberately *not*
    // saveable: it is a question being asked right now.
    val pointer = remember(channels) { PanelPointer() }
    val hit = pointer.current

    // The x-axis: distance by default, or each lap's own elapsed time. Saved by
    // key with the tab and the lit laps, so a rotation keeps it.
    val canTime = remember(channels) { PanelAxis.canTime(channels) }
    var axisKey by rememberSaveable(channels) { mutableStateOf(LapAxis.DEFAULT_AXIS.key) }
    val axisMode = LapAxis.AxisMode.of(axisKey)?.takeIf { canTime || it == LapAxis.AxisMode.DISTANCE }
        ?: LapAxis.DEFAULT_AXIS
    val axis = remember(channels, axisMode, units) { PanelAxis.of(channels, axisMode, units) }

    // The cursor: a value on the axis. A tap parks it until Clear — saveable,
    // since it is a place someone committed to, like the web's `memory.pin` —
    // and a mouse borrows it ([PanelPointer]'s rule), handing the parked one
    // back when it leaves.
    var parkedX by rememberSaveable(channels) { mutableStateOf<Double?>(null) }
    var hoveredX by remember(channels) { mutableStateOf<Double?>(null) }
    // Off while a stage owns the playhead (NS-51): a tap seeks the video there
    // instead, and the playhead is the mark.
    val cursorEnabled = onSeek == null
    val cursorX = if (cursorEnabled) hoveredX ?: parkedX else null
    LaunchedEffect(lit) { onLitChange?.invoke(lit) }

    val slots = listOf(colors.chartLine, colors.chartLineB, colors.chartLineC)
    val cursor = cursorX?.let { x ->
        val places = LapAxis.axisPlaces(channels.laps, channels.dStepM, axisMode, x, lit).map { p ->
            CursorPlace(p.chIdx, p.k, p.frac, slots[lit.indexOf(p.chIdx).coerceAtLeast(0) % slots.size])
        }
        if (places.isEmpty()) null else CursorMark(x, places)
    }
    val dots = cursor?.places?.map { MapDot(it.frac, it.color) }
    val latestOnCursor by rememberUpdatedState(onCursor)
    LaunchedEffect(dots) { latestOnCursor(dots) }
    DisposableEffect(Unit) { onDispose { latestOnCursor(null) } }

    // The stage's side-A grid index at axis value x — what [onSeek] takes. On a
    // time axis it is where A's own time series reaches x, since a chart there
    // has no grid index of its own. Read on a tap, never in composition.
    val stageGrid: (Double) -> Double? = { x ->
        when {
            channels.dStepM <= 0.0 -> null
            axisMode == LapAxis.AxisMode.DISTANCE -> x / channels.dStepM
            else -> axis.xsOf(playhead?.value?.aLap ?: lit.firstOrNull())?.let { VideoSync.gridAtElapsed(it, x) }
        }
    }
    val park: (Double?) -> Unit = { x ->
        if (onSeek != null) {
            x?.let(stageGrid)?.let(onSeek)
        } else {
            parkedX = x
        }
    }
    val hover: (Double?) -> Unit = { if (cursorEnabled) hoveredX = it }
    val scrub: ((Double) -> Unit)? = onScrub?.let { s -> { x: Double -> stageGrid(x)?.let(s) } }
    // The friction circle, the balance table and the sector headings seek the
    // same way on a stage (NS-51), still going outward so the map rings.
    val parkHit: (ChannelHit?) -> Unit = { h ->
        if (onSeek != null && h != null) {
            onSeek(h.k.toDouble())
            onHit(h)
        } else {
            pointer.park(h)
            onHit(pointer.current)
        }
    }

    // A hit from the friction circle or a sector heading is a lap's grid
    // index; on a time axis its mark goes at that lap's time there (a corner
    // row names no lap: the first lit one stands in), as the web's onHover does.
    val markX = hit?.let { axis.xAt(it.chIdx ?: lit.firstOrNull(), it.k.toDouble(), channels.dStepM) }

    if (present.isEmpty()) {
        // A session imported without channel data is normal — a hand-entered
        // one has none — so this says so rather than rendering empty axes.
        TEEmpty(emptyText, modifier = modifier)
        return
    }

    val bestMs = laps.minOfOrNull { it.timeMs }
    val lapNumber: (Int) -> Int =
        { chIdx -> matches.firstOrNull { it.chIdx == chIdx }?.lap?.lapNum ?: channels.laps[chIdx].n }

    // The first tab is the data-logger view — the delta, speed and the
    // driver's inputs on one axis; Grip and Car are the two questions that need
    // a chart of their own kind. Only populated tabs are offered, and a single
    // one renders flat. Saved by *name*, so a name an older build saved (Time,
    // Inputs) falls back to the first populated tab rather than failing to
    // restore. The Car tab is the per-lap scalars, which the server strips for
    // a free account; belt and braces rather than the gate.
    val tabs = PanelTab.entries.filter { it.hasContent(present, channels) && (pro || it != PanelTab.CAR) }
    var tabName by rememberSaveable(channels) { mutableStateOf<String?>(null) }
    val shown = tabs.firstOrNull { it.name == tabName } ?: tabs.firstOrNull() ?: PanelTab.TRACES
    // A stage carries its own map, with the playhead's dots on it.
    val mapTrace = trace?.takeIf { it.size >= 10 && cursorEnabled }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            items(matches.size) { i ->
                val match = matches[i]
                LapChip(
                    lap = match.lap,
                    isBest = bestMs != null && match.lap.timeMs == bestMs,
                    slotColor = lit.indexOf(match.chIdx).takeIf { match.hasChannels && it >= 0 }?.let { slots[it] },
                    enabled = match.hasChannels,
                    onClick = { lit = ChannelGraphs.toggle(match.chIdx, lit) },
                )
            }
        }

        Text(
            "Tap laps to compare (up to ${ChannelGraphs.SLOT_COUNT}). " +
                (
                    if (cursorEnabled) {
                        "Tap a chart to mark the place on every chart${if (mapTrace != null) " and the track map" else ""}."
                    } else {
                        "Tap a chart to move the video there."
                    }
                    ) +
                if (pro) " With 2+ laps selected, the delta chart shows where time is gained or lost vs the fastest." else "",
            style = TrackTheme.typography.xs,
            color = colors.textMuted,
        )

        if (tabs.size > 1 || canTime) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (tabs.size > 1) PanelTabs(tabs = tabs, current = shown, onSelect = { tabName = it.name })
                if (canTime) {
                    AxisSwitch(current = axisMode) { mode ->
                        if (mode != axisMode) {
                            axisKey = mode.key
                            // A parked place is a value on the old axis; it means
                            // nothing on the new one.
                            parkedX = null
                            hoveredX = null
                        }
                    }
                }
            }
        }

        parkedX?.let { x ->
            CursorBar("Marked at ${LapAxis.fmtAxisValue(x, axisMode, units)}") { parkedX = null }
        }

        if (shown == PanelTab.TRACES && mapTrace != null) {
            // On the Traces tab, above the charts: the place is wanted while
            // reading the trace. (A pinned map would need the whole page in a
            // lazy list; this one scrolls with the panel.)
            TrackMap(
                trace = mapTrace,
                dots = dots.orEmpty(),
                modifier = Modifier.fillMaxWidth().height(150.dp),
            )
        }

        // Everything above the traces is the Pro half (#264): it derives from
        // channels the server strips for a free account, or — the sectors and
        // the delta — from the free speed trace, and is gated here for that
        // reason.
        if (pro) when (shown) {
            PanelTab.TRACES -> {
                // Sector splits + theoretical best for the highlighted laps (#146),
                // above the charts as on the web.
                SectorTable(
                    channels = channels,
                    lit = lit,
                    slots = slots,
                    lapNumber = lapNumber,
                    onHit = parkHit,
                    onHover = { pointer.hover(it); onHit(pointer.current) },
                )
                val refIdx = ChannelGraphs.deltaReference(lit, channels)
                if (refIdx != null) {
                    DeltaPlot(
                        channels = channels,
                        matches = matches,
                        lit = lit,
                        refIdx = refIdx,
                        slots = slots,
                        axis = axis,
                        cursor = cursor,
                        markX = markX,
                        onPark = park,
                        onHover = hover,
                        playhead = playhead,
                        onScrub = scrub,
                        cursorEnabled = cursorEnabled,
                    )
                }
            }
            // The friction circle (#186) above the lateral-G trace it
            // summarises. It draws nothing unless the session stored longG too,
            // so a source with only lateral G still gets its trace.
            PanelTab.GRIP -> {
                FrictionCircle(
                    channels = channels,
                    lit = lit,
                    slots = slots,
                    lapNumber = lapNumber,
                    // The point of the column (NS-34 ticket 3): the tapped
                    // sample marks its place on every chart sharing the axis,
                    // and goes outward so the map can ring the place.
                    onHit = parkHit,
                    onHover = { pointer.hover(it); onHit(pointer.current) },
                )
                // Under it, the balance scatter and its per-corner table (#189),
                // above the lateral-G and yaw traces they are read from. It draws
                // nothing unless the session stored yaw, steering and speed.
                BalanceScatter(
                    channels = channels,
                    lit = lit,
                    slots = slots,
                    lapNumber = lapNumber,
                    onHit = parkHit,
                    onHover = { pointer.hover(it); onHit(pointer.current) },
                )
            }
            // The session health strip (#190): what the car was doing while you
            // drove it, which is the other half of a track day.
            PanelTab.CAR ->
                HealthStrip(channels = channels, lit = lit, slots = slots, lapNumber = lapNumber)
        }

        for (channel in present.filter { PanelTab.of(it) == shown }) {
            ChannelPlot(
                channel = channel,
                channels = channels,
                matches = matches,
                lit = lit,
                slots = slots,
                axis = axis,
                cursor = cursor,
                markX = markX,
                onPark = park,
                onHover = hover,
                playhead = playhead,
                onScrub = scrub,
                cursorEnabled = cursorEnabled,
            )
            // The gear ribbon rides under the RPM trace, where each shift is the
            // drop in the sawtooth above it (#187).
            if (channel == ChannelGraphs.Channel.RPM && pro) {
                GearRibbon(
                    channels = channels,
                    lit = lit,
                    slots = slots,
                    lapNumber = lapNumber,
                    axis = axis,
                    cursorX = cursor?.x,
                    onPark = park,
                    onHover = hover,
                )
            }
        }

        // The session's shift points (#187), under the traces they explain —
        // last on the Traces tab, as the web's `after` extra.
        if (pro && shown == PanelTab.TRACES) ShiftTable(channels = channels)

        if (!pro) {
            // Under every tab rather than on one of them: what Pro adds is
            // spread across all of them.
            ChannelProCard(onSubscribe)
        }
    }
}


/**
 * What the rest of a recording would show, and the way to it (#264). In a
 * student's logbook (NS-38) it is a note instead: the upgrade is the student's
 * to make, so their coach is told what the free half leaves out and offered
 * nothing to buy.
 */
@Composable
private fun ChannelProCard(onSubscribe: () -> Unit) {
    val colors = TrackTheme.colors
    // A shared link (NS-48): the tier is the owner's, and there is nothing to buy.
    LocalChannelFreeNote.current?.let { note ->
        TrackCard(Modifier.fillMaxWidth().semantics { testTag = "channelSharedFreeNote" }) {
            Text(note, style = TrackTheme.typography.sm, color = colors.textMuted)
        }
        return
    }
    val owner = LocalLogbookOwner.current
    if (owner is LogbookOwner.Student) {
        TrackCard(Modifier.fillMaxWidth().semantics { testTag = "channelStudentFreeNote" }) {
            Text(studentFreeNote(owner.name), style = TrackTheme.typography.sm, color = colors.textMuted)
        }
        return
    }
    TrackCard(Modifier.fillMaxWidth().semantics { testTag = "channelProCard" }) {
        Text("The rest of the recording is Pro", style = TrackTheme.typography.h3, color = colors.textStrong)
        Text(
            "Pro unlocks the rest of the recording where it carries them: steering, RPM, lateral G and yaw " +
                "traces, the gear ribbon and shift points, ABS and wheelspin marks on the map, sector splits " +
                "with a theoretical best, the car-health strip, and lap-vs-lap delta charts.",
            style = TrackTheme.typography.sm,
            color = colors.textMuted,
            modifier = Modifier.padding(top = 8.dp),
        )
        TextButton(onClick = onSubscribe) {
            Text("See Track Evolution Pro", style = TrackTheme.typography.bodyStrong, color = colors.accentInk)
        }
    }
}

/**
 * The panel's tabs, in order — `TABS` in `public/js/channel-graphs.js`, pinned
 * by `contracts/logic/lap-axis.json`'s `constants.tabs` ([key] and [label]).
 * [TRACES] is the data-logger view: the delta, speed and the driver's inputs
 * stacked on one axis, because the question a trace answers is almost always
 * "what was I doing with my feet and hands while the speed did that".
 */
enum class PanelTab(val key: String, val label: String) {
    TRACES("traces", "Traces"),
    GRIP("grip", "Grip"),
    CAR("car", "Car"),
    ;

    /**
     * Whether this tab has anything to show for a session. Traces always does —
     * the sector table and the speed chart both live there.
     */
    fun hasContent(present: List<ChannelGraphs.Channel>): Boolean = when (this) {
        TRACES -> true
        GRIP -> present.any { of(it) == this }
        // The per-lap scalars (#190). A session of hand-entered laps carries
        // none, and the tab is then absent rather than empty.
        CAR -> false
    }

    /**
     * Whether this tab has anything to show for a session, given the stored
     * channels as well as the charted ones — the Car tab is filled by the
     * per-lap scalars, which are not charted channels.
     */
    fun hasContent(present: List<ChannelGraphs.Channel>, channels: SessionChannels): Boolean =
        if (this == CAR) Health.sessionHealth(channels) != null else hasContent(present)

    companion object {
        /** Which tab a channel's chart lands on — `TAB_OF` in the JS. */
        fun of(channel: ChannelGraphs.Channel): PanelTab = when (channel) {
            ChannelGraphs.Channel.SPEED,
            ChannelGraphs.Channel.THROTTLE,
            ChannelGraphs.Channel.BRAKE,
            ChannelGraphs.Channel.STEERING,
            ChannelGraphs.Channel.RPM,
            -> TRACES
            ChannelGraphs.Channel.LAT_G,
            ChannelGraphs.Channel.YAW,
            -> GRIP
        }

        /** `TAB_OF.delta`: the delta chart's tab, which is not a stored channel. */
        val DELTA: PanelTab = TRACES
    }
}

@Composable
private fun PanelTabs(tabs: List<PanelTab>, current: PanelTab, onSelect: (PanelTab) -> Unit) {
    val colors = TrackTheme.colors
    Row(
        Modifier
            .background(colors.surfaceRaised, CircleShape)
            .border(1.dp, colors.borderHairline, CircleShape)
            .padding(3.dp)
            .semantics { testTag = "channelTabs" },
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        tabs.forEach { entry ->
            val on = entry == current
            Text(
                entry.label,
                style = TrackTheme.typography.sm,
                color = if (on) colors.accentContrast else colors.textMuted,
                modifier = Modifier
                    .background(if (on) colors.accent else Color.Transparent, CircleShape)
                    .clickable(onClick = { onSelect(entry) })
                    .padding(horizontal = 14.dp, vertical = 6.dp)
                    .semantics {
                        selected = on
                        contentDescription = entry.label
                    },
            )
        }
    }
}

@Composable
private fun LapChip(
    lap: Lap,
    isBest: Boolean,
    slotColor: Color?,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val colors = TrackTheme.colors
    val label = "Lap ${lap.lapNum} · ${LapTime.fmtMs(lap.timeMs)}" + if (isBest) " ★" else ""
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        modifier = Modifier
            .background(colors.surfaceCard, RoundedCornerShape(TrackTheme.radii.sm))
            .border(
                1.dp,
                slotColor ?: colors.borderHairline,
                RoundedCornerShape(TrackTheme.radii.sm),
            )
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 8.dp, vertical = 5.dp)
            .semantics {
                contentDescription = label +
                    if (!enabled) ", no channel data" else if (slotColor != null) ", shown" else ", tap to compare"
            },
    ) {
        Box(
            Modifier
                .size(7.dp)
                .background(slotColor ?: colors.chartDim, CircleShape),
        )
        Text(
            label,
            style = TrackTheme.typography.xs,
            color = if (enabled) colors.textStrong else colors.textFaint,
        )
    }
}

/**
 * The delta chart: highlighted laps vs the fastest of the selection ([refIdx]),
 * on the same axis as the channels below it. Positive is slower, so a climbing
 * trace is time slipping away. The reference lap draws no trace — it *is* the
 * zero line. On a time axis the delta at each grid point sits at the
 * **reference** lap's elapsed time there, as on the web. The maths is
 * `ChannelGraphs.deltaSeries` in `:core`, pinned to the web implementation by
 * `contracts/logic/lap-delta.json`.
 */
@Composable
private fun DeltaPlot(
    channels: SessionChannels,
    matches: List<ChannelGraphs.LapMatch>,
    lit: List<Int>,
    refIdx: Int,
    slots: List<Color>,
    axis: PanelAxis,
    cursor: CursorMark?,
    markX: Double?,
    onPark: (Double?) -> Unit,
    onHover: (Double?) -> Unit,
    playhead: State<LapPlayhead?>?,
    onScrub: ((Double) -> Unit)?,
    cursorEnabled: Boolean,
) {
    val colors = TrackTheme.colors
    val units = LocalUnitSystem.current
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val labelStyle = TrackTheme.typography.xxs.copy(color = colors.textFaint)
    val titleStyle = TrackTheme.typography.xxs.copy(color = colors.textMuted)
    val readoutStyle = TrackTheme.typography.xxs.copy(color = colors.textStrong)
    val edges = remember { PlotEdges() }

    fun lapNumber(chIdx: Int): Int =
        matches.firstOrNull { it.chIdx == chIdx }?.lap?.lapNum ?: channels.laps[chIdx].n

    val deltas = lit
        .filter { it != refIdx && it in channels.laps.indices }
        .mapNotNull { chIdx ->
            ChannelGraphs.deltaSeries(channels.laps[chIdx], channels.laps[refIdx], channels.dStepM)
                ?.let { chIdx to it }
        }
    if (deltas.isEmpty()) return
    val domain = ChannelGraphs.deltaDomain(deltas.map { it.second }) ?: return
    val span = axis.x1
    val refXs = axis.xsOf(refIdx) ?: return
    if (span <= 0.0) return

    val gutter = with(density) { 5.dp.toPx() }
    val padRight = with(density) { 10.dp.toPx() }
    val padTop = with(density) { 18.dp.toPx() }
    val padBottom = with(density) { 18.dp.toPx() }
    val litWidth = with(density) { 2.dp.toPx() }

    // The cursor's value per lit lap (not the reference, which is zero), at
    // the place on the reference's axis its grid index lands.
    val readings = cursor?.places.orEmpty().mapNotNull { p ->
        val series = deltas.firstOrNull { it.first == p.chIdx }?.second ?: return@mapNotNull null
        val v = valueAt(series, p.k) ?: return@mapNotNull null
        Reading(p, v, LapAxis.axisAtGrid(refXs, p.k) ?: return@mapNotNull null)
    }

    val refN = lapNumber(refIdx)
    val summary = buildString {
        append("Time delta to lap $refN by ${LapAxis.axisWord(axis.mode)} — above the zero line is slower. ")
        append(
            deltas.joinToString(". ") { (chIdx, series) ->
                "Lap ${lapNumber(chIdx)}, ${formatDelta(series.last(), 2)} seconds vs lap $refN"
            },
        )
        if (cursor != null && readings.isNotEmpty()) {
            append(". Marked at ${LapAxis.fmtAxisValue(cursor.x, axis.mode, units)}: ")
            append(readings.joinToString(", ") { "lap ${lapNumber(it.place.chIdx)} ${formatDelta(it.value, 2)} s" })
        }
    }

    // The y labels are measured here rather than in the draw, so the plot's
    // left edge is known to a tap that comes before any frame is drawn.
    val yTicks = ChartScale.niceNumTicks(domain.low, domain.high, 3)
    val yLabels = yTicks.map { it to measurer.measure(formatDelta(it, 1), labelStyle) }
    val padLeft = (yLabels.maxOfOrNull { it.second.size.width }?.toFloat() ?: 0f) + gutter * 2

    edges.left = padLeft
    Box(
        Modifier
            .fillMaxWidth()
            .height(150.dp)
            .onSizeChanged { edges.right = it.width - padRight }
            .axisCursorInput(axis, { edges.axisAt(it, span) }, onPark, onHover)
            .axisScrub(axis, edges, span, onScrub, onPark)
            .semantics {
                testTag = "channelChart:delta"
                contentDescription = summary
                // On a stage the transport's scrubber carries the actions.
                if (cursorEnabled) cursorActions(span, cursor?.x, onPark)
            }
            .playheadOverlay(
                playhead = playhead,
                frame = PlotFrame(padLeft, padRight, padTop, padBottom, span),
                // On a time axis the delta sits at the reference lap's time.
                lineX = { LapAxis.axisAtGrid(refXs, it.k) },
                dotX = { _, k -> LapAxis.axisAtGrid(refXs, k) },
                // The reference is the zero line; its dot would sit on it.
                lit = lit,
                dotLaps = deltas.map { it.first }.toSet(),
                slots = slots,
                lineColor = colors.textStrong,
                haloColor = colors.surfaceCard,
                valueAt = { chIdx, k -> VideoSync.valueAt(deltas.firstOrNull { it.first == chIdx }?.second, k) },
                yFraction = { ChartScale.plottedFraction(it, domain).toFloat() },
                readout = { formatDelta(it, 2) + " s" },
                readoutStyle = readoutStyle,
                measurer = measurer,
                density = density.density,
            ),
    ) {
        Canvas(Modifier.fillMaxSize()) {

            val plotW = size.width - padLeft - padRight
            val plotH = size.height - padTop - padBottom
            if (plotW <= 0f || plotH <= 0f) return@Canvas

            fun px(x: Double) = padLeft + (x / span).toFloat().coerceIn(0f, 1f) * plotW
            fun py(value: Double) = padTop + ChartScale.plottedFraction(value, domain).toFloat() * plotH

            for ((tick, text) in yLabels) {
                val y = py(tick)
                drawLine(colors.chartGrid, Offset(padLeft, y), Offset(size.width - padRight, y), strokeWidth = 1f)
                drawText(text, topLeft = Offset(padLeft - gutter - text.size.width, y - text.size.height / 2f))
            }
            drawAxisTicks(axis, measurer, labelStyle, ::px)
            // The zero line is the reference lap — everything is measured
            // against it, so it gets the strong stroke, not the axis.
            val zy = py(0.0)
            drawLine(colors.textFaint, Offset(padLeft, zy), Offset(size.width - padRight, zy), strokeWidth = 1f)
            drawLine(
                colors.borderStrong,
                Offset(padLeft, size.height - padBottom),
                Offset(size.width - padRight, size.height - padBottom),
                strokeWidth = 1f,
            )

            val title = measurer.measure("Delta (s) vs lap $refN — above the line is slower", titleStyle)
            drawText(title, topLeft = Offset(padLeft, 0f))

            for ((chIdx, series) in deltas) {
                val n = kotlin.math.min(series.size, refXs.size)
                if (n < 2) continue
                val slot = lit.indexOf(chIdx)
                val path = Path()
                for (k in 0 until n) {
                    val x = px(refXs[k])
                    val y = py(series[k])
                    if (k == 0) path.moveTo(x, y) else path.lineTo(x, y)
                }
                drawPath(
                    path,
                    color = slots[(if (slot >= 0) slot else 0) % slots.size],
                    style = Stroke(width = litWidth, cap = StrokeCap.Round, join = StrokeJoin.Round),
                )
            }

            drawMark(markX, ::px, padTop, plotH, colors.textFaint, density.density)
            drawCursor(
                cursor = cursor,
                readings = readings.map { Triple(px(it.x), py(it.value), it.place.color) },
                values = readings.map { formatDelta(it.value, 2) to it.place.color },
                lineX = cursor?.let { px(it.x) },
                padTop = padTop,
                plotH = plotH,
                titleEnd = padLeft + title.size.width,
                measurer = measurer,
                style = titleStyle,
                lineColor = colors.textStrong,
                ringColor = colors.surfaceCard,
                density = density.density,
            )
        }
    }
}

/** One lit lap's value under the cursor, and the axis place its dot goes at. */
private data class Reading(val place: CursorPlace, val value: Double, val x: Double)

/** `+0.4` / `−0.4` — the sign is the message, so it is always shown. */
internal fun formatDelta(value: Double, decimals: Int): String {
    val factor = Math.pow(10.0, decimals.toDouble())
    val rounded = kotlin.math.round(value * factor) / factor
    val magnitude = String.format("%.${decimals}f", abs(rounded))
    return if (rounded < 0) "−$magnitude" else "+$magnitude"
}

@Composable
private fun ChannelPlot(
    channel: ChannelGraphs.Channel,
    channels: SessionChannels,
    matches: List<ChannelGraphs.LapMatch>,
    lit: List<Int>,
    slots: List<Color>,
    axis: PanelAxis,
    /** The panel's cursor: a line, a dot per lit lap and the values in the title. */
    cursor: CursorMark?,
    /**
     * A place to mark, in axis units, or null for none (NS-34 ticket 3).
     *
     * The port of the web's `showDistanceMark`: the friction circle hands over a
     * sample, and every chart on the shared axis says where that was. One line
     * on each chart is the whole mechanism — the charts already agree about the
     * axis, which is what makes the answer meaningful.
     */
    markX: Double?,
    onPark: (Double?) -> Unit,
    onHover: (Double?) -> Unit,
    /** The stage's playhead (NS-51), read in the draw phase only. */
    playhead: State<LapPlayhead?>?,
    onScrub: ((Double) -> Unit)?,
    cursorEnabled: Boolean,
) {
    val colors = TrackTheme.colors
    val units = LocalUnitSystem.current
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val labelStyle = TrackTheme.typography.xxs.copy(color = colors.textFaint)
    val titleStyle = TrackTheme.typography.xxs.copy(color = colors.textMuted)
    val readoutStyle = TrackTheme.typography.xxs.copy(color = colors.textStrong)
    val edges = remember { PlotEdges() }

    val domain = ChannelGraphs.valueDomain(channel, channels, units) ?: return
    val span = axis.x1
    val gridCount = ChannelGraphs.gridCount(channel, channels)
    if (gridCount < 2 || span <= 0.0) return

    // The limit runs this chart's trace explains, for each highlighted lap
    // (#188). Empty for every channel with no kind pointed at it, and for every
    // session that stored neither `flags` nor `wheelSlip`.
    val bandKinds = Limits.LIMIT_KINDS.filter { it.channel == channel }
    val bands = if (bandKinds.isEmpty()) {
        emptyList()
    } else {
        lit.filter { it in channels.laps.indices }.flatMap { chIdx ->
            Limits.limitRuns(channels.laps[chIdx]).mapNotNull { run ->
                bandKinds.firstOrNull { it.key == run.kind }?.let { Triple(chIdx, run, it) }
            }
        }
    }

    // The cursor's value on each lit lap that carries this channel.
    val readings = cursor?.places.orEmpty().mapNotNull { p ->
        val raw = valueAt(channel.series(channels.laps[p.chIdx]), p.k) ?: return@mapNotNull null
        Reading(p, channel.convert(raw, units), cursor!!.x)
    }

    // Measured below rather than fixed: an RPM axis label ("7400") is far wider
    // than a lateral-G one ("1.2"), and a single inset either wastes the plot or
    // lets the label run under it.
    val gutter = with(density) { 5.dp.toPx() }
    val padRight = with(density) { 10.dp.toPx() }
    val padTop = with(density) { 18.dp.toPx() }
    val padBottom = with(density) { 18.dp.toPx() }
    val dimWidth = with(density) { 1.25.dp.toPx() }
    val litWidth = with(density) { 2.dp.toPx() }

    // The y labels are measured here rather than in the draw, so the plot's
    // left edge is known to a tap that comes before any frame is drawn.
    val yTicks = ChartScale.niceNumTicks(domain.low, domain.high, 3)
    val yLabels = yTicks.map { it to measurer.measure(formatTick(it, channel.decimals), labelStyle) }
    val padLeft = (yLabels.maxOfOrNull { it.second.size.width }?.toFloat() ?: 0f) + gutter * 2

    edges.left = padLeft
    Box(
        Modifier
            .fillMaxWidth()
            .height(150.dp)
            .onSizeChanged { edges.right = it.width - padRight }
            .axisCursorInput(axis, { edges.axisAt(it, span) }, onPark, onHover)
            .axisScrub(axis, edges, span, onScrub, onPark)
            .semantics {
                testTag = "channelChart:${channel.key}"
                contentDescription = channelSummary(
                    channel = channel,
                    extent = ChannelGraphs.valueExtent(channel, channels, units),
                    spanMetres = span,
                    litCount = lit.size,
                    units = units,
                    shaded = bands.map { it.third.label }.distinct(),
                    mode = axis.mode,
                ) + cursorSummary(cursor, readings, axis.mode, units, channel, matches, channels)
                // On a stage the transport's scrubber carries the actions.
                if (cursorEnabled) cursorActions(span, cursor?.x, onPark)
            }
            .playheadOverlay(
                playhead = playhead,
                frame = PlotFrame(padLeft, padRight, padTop, padBottom, span),
                // The line at side A's place; each lap's dot at its own.
                lineX = { axis.xAt(it.aLap ?: lit.firstOrNull(), it.k, channels.dStepM) },
                dotX = { chIdx, k -> axis.xAt(chIdx, k, channels.dStepM) },
                lit = lit,
                dotLaps = lit.filter { it in channels.laps.indices }.toSet(),
                slots = slots,
                lineColor = colors.textStrong,
                haloColor = colors.surfaceCard,
                valueAt = { chIdx, k ->
                    VideoSync.valueAt(channel.series(channels.laps[chIdx]), k)?.let { channel.convert(it, units) }
                },
                yFraction = { ChartScale.plottedFraction(it, domain).toFloat() },
                readout = {
                    formatTick(it, channel.decimals) +
                        if (channel == ChannelGraphs.Channel.SPEED) " ${channel.unit(units)}" else ""
                },
                readoutStyle = readoutStyle,
                measurer = measurer,
                density = density.density,
            ),
    ) {
        Canvas(Modifier.fillMaxSize()) {

            val plotW = size.width - padLeft - padRight
            val plotH = size.height - padTop - padBottom
            if (plotW <= 0f || plotH <= 0f) return@Canvas

            fun px(x: Double) = padLeft + (x / span).toFloat().coerceIn(0f, 1f) * plotW

            fun py(value: Double) =
                padTop + ChartScale.plottedFraction(value, domain).toFloat() * plotH

            for ((tick, text) in yLabels) {
                val y = py(tick)
                drawLine(colors.chartGrid, Offset(padLeft, y), Offset(size.width - padRight, y), strokeWidth = 1f)
                drawText(text, topLeft = Offset(padLeft - gutter - text.size.width, y - text.size.height / 2f))
            }
            // Nice numbers in the unit the axis is labelled in — metres or
            // miles, or m:ss on a time axis.
            drawAxisTicks(axis, measurer, labelStyle, ::px)
            drawLine(
                colors.borderStrong,
                Offset(padLeft, size.height - padBottom),
                Offset(size.width - padRight, size.height - padBottom),
                strokeWidth = 1f,
            )

            // Where the car was at its limit, shaded behind the trace that
            // explains it (#188) — ABS and lockup on the brake chart, traction
            // control and wheelspin on the throttle, stability control on
            // steering. Drawn before the traces so it reads as ground, not mark.
            // Each lap's run sits at that lap's own place on the axis.
            for ((chIdx, run, kind) in bands) {
                val xa = px(axis.xAt(chIdx, run.k0 - 0.5, channels.dStepM) ?: continue)
                val xb = px(axis.xAt(chIdx, run.k1 + 0.5, channels.dStepM) ?: continue)
                drawRect(
                    color = limitColor(kind.side, colors),
                    topLeft = Offset(xa, padTop),
                    size = androidx.compose.ui.geometry.Size(kotlin.math.max(1f, xb - xa), plotH),
                    alpha = if (kind.filled) 0.22f else 0.12f,
                )
            }

            val title = measurer.measure("${channel.label} (${channel.unit(units)})", titleStyle)
            drawText(title, topLeft = Offset(padLeft, 0f))
            // Name what is shaded, so a band is never an unexplained colour.
            val shadedKinds = bands.map { it.third.label }.distinct()
            if (shadedKinds.isNotEmpty() && readings.isEmpty()) {
                val note = measurer.measure("shaded: ${shadedKinds.joinToString(" / ")}", labelStyle)
                drawText(note, topLeft = Offset(size.width - padRight - note.size.width, 0f))
            }

            fun lapPath(lapIndex: Int): Path? {
                val series = channel.series(channels.laps[lapIndex]) ?: return null
                val xs = axis.xsOf(lapIndex) ?: return null
                val n = kotlin.math.min(series.size, xs.size)
                if (n < 2) return null
                val path = Path()
                for (k in 0 until n) {
                    val x = px(xs[k])
                    val y = py(channel.convert(series[k], units))
                    if (k == 0) path.moveTo(x, y) else path.lineTo(x, y)
                }
                return path
            }

            // Painter's order: the whole dim envelope first, then the
            // highlighted laps on top. Interleaving them would let a dim lap
            // cross over a lit one and break the figure/ground the highlight
            // exists to create.
            channels.laps.indices.forEach { i ->
                if (i in lit) return@forEach
                lapPath(i)?.let {
                    drawPath(it, color = colors.chartDim, style = Stroke(width = dimWidth, join = StrokeJoin.Round))
                }
            }
            lit.forEachIndexed { slot, lapIndex ->
                if (lapIndex !in channels.laps.indices) return@forEachIndexed
                lapPath(lapIndex)?.let {
                    drawPath(
                        it,
                        color = slots[slot % slots.size],
                        style = Stroke(width = litWidth, cap = StrokeCap.Round, join = StrokeJoin.Round),
                    )
                }
            }

            // Over everything, because it is the question being asked right now.
            drawMark(markX, ::px, padTop, plotH, colors.textFaint, density.density)
            drawCursor(
                cursor = cursor,
                readings = readings.map { Triple(px(it.x), py(it.value), it.place.color) },
                values = readings.map { formatTick(it.value, channel.decimals) to it.place.color },
                lineX = cursor?.let { px(it.x) },
                padTop = padTop,
                plotH = plotH,
                titleEnd = padLeft + title.size.width,
                measurer = measurer,
                style = titleStyle,
                lineColor = colors.textStrong,
                ringColor = colors.surfaceCard,
                density = density.density,
            )
        }
    }
}

/**
 * A plot's insets and the axis extent it spans, as the draw lays it out — so
 * the stage's overlay puts its line where the traces put theirs (NS-51).
 */
private class PlotFrame(
    val padLeft: Float,
    val padRight: Float,
    val padTop: Float,
    val padBottom: Float,
    /** The axis extent, in axis units. */
    val span: Double,
) {
    fun plotW(width: Float) = width - padLeft - padRight
    fun plotH(height: Float) = height - padTop - padBottom
    fun px(width: Float, x: Double): Float =
        padLeft + (if (span <= 0.0) 0f else (x / span).toFloat().coerceIn(0f, 1f)) * plotW(width)
}

/**
 * A mouse dragging across a plot with its button down scrubs the stage
 * ([onScrub], with an axis value), and its release is a tap — [onPark], the
 * exact seek. Touch never drags: the page scrolls over the charts (NS-51's rule
 * on every client). Nothing without a stage.
 */
private fun Modifier.axisScrub(
    key: Any?,
    edges: PlotEdges,
    span: Double,
    onScrub: ((Double) -> Unit)?,
    onPark: (Double?) -> Unit,
): Modifier = if (onScrub == null) {
    this
} else {
    this.mouseDrag(
        key, span, onScrub,
        onDrag = { offset -> onScrub(edges.axisAt(offset.x, span)) },
        onRelease = { offset -> onPark(edges.axisAt(offset.x, span)) },
    )
}

/**
 * The stage's playhead over a plot (NS-51): a solid line at side A's place and
 * a dot on each lit lap's trace at that lap's own place, plus the values beside
 * the line. Read **in the draw phase** — [playhead] is a `State` whose value is
 * only touched inside `drawWithContent` — so a video frame redraws this overlay
 * and nothing else: the traces neither recompose nor re-render.
 */
private fun Modifier.playheadOverlay(
    playhead: State<LapPlayhead?>?,
    frame: PlotFrame,
    /** The line's axis value. */
    lineX: (LapPlayhead) -> Double?,
    /** A lap's dot's axis value at its fractional grid index. */
    dotX: (chIdx: Int, k: Double) -> Double?,
    lit: List<Int>,
    /** The lit laps that get a dot — not a delta chart's reference. */
    dotLaps: Set<Int>,
    slots: List<Color>,
    lineColor: Color,
    haloColor: Color,
    /** A lit lap's value at a fractional index, already in the axis's unit, or null where it has none. */
    valueAt: (chIdx: Int, k: Double) -> Double?,
    /** The value's y, as a fraction of the plot height from the top. */
    yFraction: (Double) -> Float,
    /** The read-out's words for one value. */
    readout: (Double) -> String,
    readoutStyle: TextStyle,
    measurer: TextMeasurer,
    density: Float,
): Modifier = if (playhead == null) this else this.drawWithContent {
    drawContent()
    val p = playhead.value ?: return@drawWithContent
    val plotH = frame.plotH(size.height)
    if (frame.plotW(size.width) <= 0f || plotH <= 0f) return@drawWithContent
    val x = frame.px(size.width, lineX(p) ?: return@drawWithContent)
    drawLine(lineColor, Offset(x, frame.padTop), Offset(x, frame.padTop + plotH), strokeWidth = 1.5f * density)
    val values = mutableListOf<String>()
    lit.forEachIndexed { slot, chIdx ->
        if (chIdx !in dotLaps) return@forEachIndexed
        val k = p.kFor(chIdx)
        val v = valueAt(chIdx, k) ?: return@forEachIndexed
        val dx = frame.px(size.width, dotX(chIdx, k) ?: return@forEachIndexed)
        val dy = frame.padTop + yFraction(v) * plotH
        drawCircle(haloColor, radius = 4.5f * density, center = Offset(dx, dy))
        drawCircle(slots[slot % slots.size], radius = 3f * density, center = Offset(dx, dy))
        values += readout(v)
    }
    if (values.isNotEmpty()) {
        // Beside the line, inside the plot, flipping to its left near the right
        // edge — the title row already carries the chart's name and any shading
        // note, and a phone has no room left in it.
        val text = measurer.measure(values.joinToString("  "), readoutStyle)
        val gap = 4f * density
        val w = text.size.width.toFloat()
        val left = if (x + gap + w <= size.width - frame.padRight) x + gap else x - gap - w
        drawRect(
            haloColor.copy(alpha = 0.85f),
            topLeft = Offset(left - gap / 2, frame.padTop),
            size = androidx.compose.ui.geometry.Size(w + gap, text.size.height.toFloat()),
        )
        drawText(text, topLeft = Offset(left, frame.padTop))
    }
}

/** The x-axis labels, centred under their place and kept inside the chart. */
private fun DrawScope.drawAxisTicks(
    axis: PanelAxis,
    measurer: TextMeasurer,
    style: TextStyle,
    px: (Double) -> Float,
) {
    for ((x, label) in axis.ticks) {
        val text = measurer.measure(label, style)
        drawText(
            text,
            topLeft = Offset(
                (px(x) - text.size.width / 2f).coerceIn(0f, max(0f, size.width - text.size.width)),
                size.height - text.size.height,
            ),
        )
    }
}

/**
 * A place another view pointed at (the friction circle, a sector heading).
 * Dashed and faint: it points *at* the traces rather than competing with them.
 */
private fun DrawScope.drawMark(
    markX: Double?,
    px: (Double) -> Float,
    padTop: Float,
    plotH: Float,
    color: Color,
    density: Float,
) {
    if (markX == null) return
    val x = px(markX)
    drawLine(
        color = color,
        start = Offset(x, padTop),
        end = Offset(x, padTop + plotH),
        strokeWidth = 1.5f * density,
        pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f)),
    )
}

/**
 * The cursor on one chart: a solid line, a dot on each lit lap's trace in its
 * slot colour, and the values after the chart's title — the web's
 * `showPlayhead`, drawn into the canvas rather than set as attributes.
 */
private fun DrawScope.drawCursor(
    cursor: CursorMark?,
    /** Each dot: x, y in pixels, and its colour. */
    readings: List<Triple<Float, Float, Color>>,
    /** Each value as said after the title, in its lap's colour. */
    values: List<Pair<String, Color>>,
    lineX: Float?,
    padTop: Float,
    plotH: Float,
    titleEnd: Float,
    measurer: TextMeasurer,
    style: TextStyle,
    lineColor: Color,
    ringColor: Color,
    density: Float,
) {
    if (cursor == null || lineX == null) return
    drawLine(lineColor, Offset(lineX, padTop - 2f * density), Offset(lineX, padTop + plotH), strokeWidth = 1.5f * density)
    for ((x, y, color) in readings) {
        drawCircle(ringColor, radius = 5.5f * density, center = Offset(x, y))
        drawCircle(color, radius = 4f * density, center = Offset(x, y))
    }
    var at = titleEnd + 8f * density
    values.forEachIndexed { i, (text, color) ->
        val measured = measurer.measure((if (i > 0) "· " else "") + text, style.copy(color = color))
        if (at + measured.size.width > size.width) return
        drawText(measured, topLeft = Offset(at, 0f))
        at += measured.size.width + 4f * density
    }
}

/** What the cursor says to TalkBack: the place, and each lit lap's value there. */
private fun cursorSummary(
    cursor: CursorMark?,
    readings: List<Reading>,
    mode: LapAxis.AxisMode,
    units: UnitSystem,
    channel: ChannelGraphs.Channel,
    matches: List<ChannelGraphs.LapMatch>,
    channels: SessionChannels,
): String {
    if (cursor == null || readings.isEmpty()) return ""
    fun lapNumber(chIdx: Int) = matches.firstOrNull { it.chIdx == chIdx }?.lap?.lapNum ?: channels.laps[chIdx].n
    return " Marked at ${LapAxis.fmtAxisValue(cursor.x, mode, units)}: " +
        readings.joinToString(", ") {
            "lap ${lapNumber(it.place.chIdx)} ${formatTick(it.value, channel.decimals)} ${channel.unit(units)}"
        } + "."
}

private fun formatTick(value: Double, decimals: Int): String =
    if (decimals == 0) {
        // Avoid "-0" on a lateral-G axis that straddles zero.
        val rounded = kotlin.math.round(value).toInt()
        (if (rounded == 0) 0 else rounded).toString()
    } else {
        val factor = Math.pow(10.0, decimals.toDouble())
        val rounded = kotlin.math.round(value * factor) / factor
        String.format("%.${decimals}f", if (abs(rounded) < 1e-9) 0.0 else rounded)
    }

internal fun channelSummary(
    channel: ChannelGraphs.Channel,
    extent: Pair<Double, Double>?,
    /** The axis extent: metres on distance, seconds on time. */
    spanMetres: Double,
    litCount: Int,
    units: UnitSystem,
    /** Limit kinds shaded on this chart (#188) — invisible to a screen reader. */
    shaded: List<String> = emptyList(),
    mode: LapAxis.AxisMode = LapAxis.AxisMode.DISTANCE,
): String = buildString {
    append("${channel.label} by ${LapAxis.axisWord(mode)} over ")
    append(
        if (mode == LapAxis.AxisMode.TIME) {
            LapAxis.fmtAxisSeconds(spanMetres)
        } else {
            ChannelGraphs.fmtDist(spanMetres, units)
        },
    )
    if (extent != null) {
        // The measured range, not the padded axis — see ChannelGraphs.valueExtent.
        append(", ${formatTick(extent.first, channel.decimals)} to ")
        append("${formatTick(extent.second, channel.decimals)} ${channel.unit(units)}")
    }
    append(
        when (litCount) {
            0 -> ", no laps highlighted"
            1 -> ", 1 lap highlighted"
            else -> ", $litCount laps highlighted"
        },
    )
    append(".")
    if (shaded.isNotEmpty()) append(" Shaded where ${shaded.joinToString(", ")} were active.")
}

/**
 * A limit kind's colour. Generated tokens, never a hex literal, and [TrackMap]
 * draws its marks from the same two so a mark and its band cannot disagree.
 */
internal fun limitColor(side: Limits.Side, colors: app.trackevolution.ui.theme.TrackColors): Color = when (side) {
    Limits.Side.BRAKE -> colors.limitBrake
    Limits.Side.POWER -> colors.limitPower
    Limits.Side.STABILITY -> colors.textStrong
}
