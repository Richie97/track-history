package app.trackevolution.ui.charts

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
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
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import app.trackevolution.core.ChannelGraphs
import app.trackevolution.core.Units
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
import kotlin.math.roundToInt

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
 * Every lap of an imported session on one driven-distance axis (NS-24) — the
 * port of `public/js/channel-graphs.js`.
 *
 * Up to three laps are highlighted in the slot colours and the rest draw as a
 * dim envelope behind them, which is what makes a single lap readable against
 * the shape of the whole session.
 *
 * **The chips are the legend.** Identity is never colour-alone — each chip
 * carries its lap number and time next to its dot, so the chart is usable
 * without colour vision and with a screen reader.
 *
 * The matching, selection and axis maths are `ChannelGraphs` in `:core`, pinned
 * to the web implementation by `contracts/logic/channels.json`. This file draws.
 */
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
     * The lap stage's playhead (NS-51), or null with no stage. A `State` read
     * only in each plot's draw phase, so a video frame moves the line without
     * recomposing a chart.
     */
    playhead: State<LapPlayhead?>? = null,
    /**
     * With a stage, what a tap on a chart does instead of parking a mark: pause
     * and seek the stage to that fractional grid index. Null keeps today's
     * behaviour — a tap parks the mark.
     */
    onSeek: ((Double) -> Unit)? = null,
    /** A mouse dragging across a chart with its button down: a fast seek per move. */
    onScrub: ((Double) -> Unit)? = null,
    /** The lit laps, as they change — the session stage picks its sides from them. */
    onLitChange: ((List<Int>) -> Unit)? = null,
) {
    val colors = TrackTheme.colors
    val matches = remember(channels, laps) { ChannelGraphs.matchLapsToChannels(laps, channels.laps) }
    val present = remember(channels) { ChannelGraphs.presentChannels(channels) }

    // Survives rotation: losing a three-lap comparison to a screen turn would
    // mean rebuilding it by hand.
    var lit by rememberSaveable(channels) {
        mutableStateOf(initialSelection ?: ChannelGraphs.initialSelection(matches))
    }

    // Where the panel is currently pointing (NS-34 ticket 3), and whether a tap
    // put it there or a mouse is merely passing over (ticket 5) — see
    // [PanelPointer]. Deliberately *not* saveable: it is a question being asked
    // right now, and restoring a mark after a rotation would answer one nobody is
    // still asking.
    val pointer = remember(channels) { PanelPointer() }
    val hit = pointer.current
    val markDistance = hit?.let { it.k * channels.dStepM }
    LaunchedEffect(lit) { onLitChange?.invoke(lit) }

    // A place every lap shares, from a chart's x — what a tap on a distance-axis
    // chart parks (NS-51: those charts answered no tap before, so the lap page's
    // "Tap a chart" was untrue). With a stage, a tap seeks it instead and the
    // playhead *is* the mark.
    val gridHit: (Double) -> ChannelHit? = { k ->
        val n = channels.laps.maxOfOrNull { it.speed?.size ?: 0 } ?: 0
        if (n <= 1) null else ChannelHit(chIdx = null, k = k.roundToInt(), frac = (k / (n - 1)).coerceIn(0.0, 1.0))
    }
    val tapAt: (Double) -> Unit = { k ->
        if (onSeek != null) {
            onSeek(k)
        } else {
            pointer.park(gridHit(k))
            onHit(pointer.current)
        }
    }
    val hoverAt: (Double?) -> Unit = { k ->
        pointer.hover(k?.let(gridHit))
        onHit(pointer.current)
    }
    // The friction circle, the balance table and the sector headings seek the
    // same way (NS-51), going outward unchanged so the map still rings.
    val parkOrSeek: (ChannelHit?) -> Unit = { h ->
        if (onSeek != null && h != null) {
            onSeek(h.k.toDouble())
            onHit(h)
        } else {
            pointer.park(h)
            onHit(pointer.current)
        }
    }

    if (present.isEmpty()) {
        // A session imported without channel data is normal — a hand-entered
        // one has none — so this says so rather than rendering empty axes.
        TEEmpty(emptyText, modifier = modifier)
        return
    }

    val slots = listOf(colors.chartLine, colors.chartLineB, colors.chartLineC)
    val bestMs = laps.minOfOrNull { it.timeMs }
    val lapNumber: (Int) -> Int =
        { chIdx -> matches.firstOrNull { it.chIdx == chIdx }?.lap?.lapNum ?: channels.laps[chIdx].n }

    // One question per tab (epic #193). Only populated tabs are offered, and a
    // single one renders flat — a tab bar with one tab in it is a control that
    // does nothing. Survives rotation for the same reason the selection does.
    // The Car tab is the per-lap scalars, which the server strips for a free
    // account; belt and braces rather than the gate.
    val tabs = PanelTab.entries.filter { it.hasContent(present, channels) && (pro || it != PanelTab.CAR) }
    var tab by rememberSaveable(channels) { mutableStateOf(tabs.firstOrNull() ?: PanelTab.TIME) }
    // A selection that empties the current tab must not leave the panel blank.
    val shown = if (tab in tabs) tab else tabs.firstOrNull() ?: PanelTab.TIME

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
            "Laps on a shared distance axis — tap laps to compare (up to ${ChannelGraphs.SLOT_COUNT})." +
                if (pro) {
                    " With 2+ selected, the Time tab's delta chart shows where time is gained or lost vs " +
                        "the fastest; the other tabs show why."
                } else {
                    ""
                },
            style = TrackTheme.typography.xs,
            color = colors.textMuted,
        )

        if (tabs.size > 1) {
            PanelTabs(tabs = tabs, current = shown, onSelect = { tab = it })
        }

        // Everything above the traces is the Pro half (#264): it derives from
        // channels the server strips for a free account, or — the sectors and
        // the delta — from the free speed trace, and is gated here for that
        // reason.
        if (pro) when (shown) {
            PanelTab.TIME -> {
                // Sector splits + theoretical best for the highlighted laps (#146),
                // above the charts as on the web.
                SectorTable(
                    channels = channels,
                    lit = lit,
                    slots = slots,
                    lapNumber = lapNumber,
                    onHit = parkOrSeek,
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
                        markDistance = markDistance,
                        playhead = playhead,
                        onTap = tapAt,
                        onHover = hoverAt,
                        onScrub = onScrub,
                    )
                }
            }
            // The session's shift points (#187) above the traces they explain.
            PanelTab.INPUTS -> ShiftTable(channels = channels)
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
                    // sample marks its distance on every chart sharing the axis,
                    // and goes outward so the map can ring the place.
                    onHit = parkOrSeek,
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
                    onHit = parkOrSeek,
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
                markDistance = markDistance,
                playhead = playhead,
                onTap = tapAt,
                onHover = hoverAt,
                onScrub = onScrub,
            )
            // The gear ribbon rides under the RPM trace, where each shift is the
            // drop in the sawtooth above it (#187).
            if (channel == ChannelGraphs.Channel.RPM && pro) {
                GearRibbon(channels = channels, lit = lit, slots = slots, lapNumber = lapNumber)
            }
        }

        if (!pro) {
            // Under every tab rather than on one of them: what Pro adds is
            // spread across all four.
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
 * The panel's tabs, in order — `TABS` in `public/js/channel-graphs.js`. [CAR] is
 * reserved for the per-lap scalars (#190) and so draws nothing yet; it is listed
 * here so the two implementations stay diffable.
 */
enum class PanelTab(val label: String) {
    TIME("Time"),
    INPUTS("Inputs"),
    GRIP("Grip"),
    CAR("Car"),
    ;

    /**
     * Whether this tab has anything to show for a session. Time always does —
     * the sector table and the speed chart both live there.
     */
    fun hasContent(present: List<ChannelGraphs.Channel>): Boolean = when (this) {
        TIME -> true
        INPUTS, GRIP -> present.any { of(it) == this }
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
            ChannelGraphs.Channel.SPEED -> TIME
            ChannelGraphs.Channel.THROTTLE,
            ChannelGraphs.Channel.BRAKE,
            ChannelGraphs.Channel.STEERING,
            ChannelGraphs.Channel.RPM,
            -> INPUTS
            ChannelGraphs.Channel.LAT_G,
            ChannelGraphs.Channel.YAW,
            -> GRIP
        }
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
 * Where a plot's data sits inside it, shared by the draw, the tap and the
 * playhead overlay so the three agree to the pixel (NS-51). The left inset is
 * the widest y label, measured in composition rather than in the draw, because
 * a tap has to map x back to a distance with the same number.
 */
private class PlotFrame(
    val padLeft: Float,
    val padRight: Float,
    val padTop: Float,
    val padBottom: Float,
    /** The driven distance the x axis spans, metres. */
    val span: Double,
) {
    fun plotW(width: Float) = width - padLeft - padRight
    fun plotH(height: Float) = height - padTop - padBottom
    fun px(width: Float, distance: Double): Float =
        padLeft + (if (span <= 0.0) 0.0 else (distance / span).coerceIn(0.0, 1.0)).toFloat() * plotW(width)

    /** A tap's x back to a fractional grid index on a [dStepM] grid. */
    fun kAt(width: Float, x: Float, dStepM: Double): Double? {
        val w = plotW(width)
        if (w <= 0f || span <= 0.0 || dStepM <= 0.0) return null
        return ((x - padLeft) / w).coerceIn(0f, 1f) * span / dStepM
    }
}

/**
 * The plot's pointer: a tap, from a finger or a mouse, says where ([onTap] with
 * a fractional grid index); a mouse borrows the mark while it hovers
 * ([onHover], null on leaving) and scrubs while its button is down ([onScrub],
 * then [onTap] on release for the exact seek). Touch never drags — the page
 * scrolls over the charts (NS-51's rule on every client).
 */
private fun Modifier.plotPointer(
    frame: PlotFrame,
    dStepM: Double,
    onTap: (Double) -> Unit,
    onHover: (Double?) -> Unit,
    onScrub: ((Double) -> Unit)?,
): Modifier = this
    .pointerInput(frame, dStepM, onTap) {
        detectTapGestures { offset -> frame.kAt(size.width.toFloat(), offset.x, dStepM)?.let(onTap) }
    }
    .pointerHover(frame, dStepM, onHover) { offset ->
        onHover(offset?.let { frame.kAt(size.width.toFloat(), it.x, dStepM) })
    }
    .then(
        if (onScrub == null) {
            Modifier
        } else {
            Modifier.mouseDrag(
                frame, dStepM, onScrub,
                onDrag = { offset -> frame.kAt(size.width.toFloat(), offset.x, dStepM)?.let(onScrub) },
                onRelease = { offset -> frame.kAt(size.width.toFloat(), offset.x, dStepM)?.let(onTap) },
            )
        },
    )

/**
 * The stage's playhead over a plot (NS-51): a solid line at side A's place and
 * a dot on each lit lap's trace at that lap's own place, plus the values in the
 * title's read-out. Read **in the draw phase** — [playhead] is a `State` whose
 * value is only touched inside `drawWithContent` — so a video frame redraws this
 * overlay and nothing else: the traces neither recompose nor re-render.
 */
private fun Modifier.playheadOverlay(
    playhead: State<LapPlayhead?>?,
    frame: PlotFrame,
    dStepM: Double,
    lit: List<Int>,
    slots: List<Color>,
    lineColor: Color,
    haloColor: Color,
    /** A lit lap's value at a fractional index, already in the axis's unit, or null where it has none. */
    valueAt: (chIdx: Int, k: Double) -> Double?,
    /** The axis value's y, as a fraction of the plot height from the top. */
    yFraction: (Double) -> Float,
    /** The title read-out's words for one value. */
    readout: (Double) -> String,
    readoutStyle: TextStyle,
    measurer: androidx.compose.ui.text.TextMeasurer,
    density: Float,
): Modifier = if (playhead == null) this else this.drawWithContent {
    drawContent()
    val p = playhead.value ?: return@drawWithContent
    val plotH = frame.plotH(size.height)
    if (frame.plotW(size.width) <= 0f || plotH <= 0f) return@drawWithContent
    val x = frame.px(size.width, p.k * dStepM)
    drawLine(lineColor, Offset(x, frame.padTop), Offset(x, frame.padTop + plotH), strokeWidth = 1.5f * density)
    val values = mutableListOf<String>()
    lit.forEachIndexed { slot, chIdx ->
        val v = valueAt(chIdx, p.kFor(chIdx)) ?: return@forEachIndexed
        val dx = frame.px(size.width, p.kFor(chIdx) * dStepM)
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

/**
 * The delta chart: highlighted laps vs the fastest of the selection ([refIdx]),
 * on the same distance axis as the channels below it. Positive is slower, so a
 * climbing trace is time slipping away. The reference lap draws no trace — it
 * *is* the zero line. The maths is `ChannelGraphs.deltaSeries` in `:core`,
 * pinned to the web implementation by `contracts/logic/lap-delta.json`.
 *
 * Since NS-51 it answers a tap like every distance-axis chart, carries the
 * panel's mark, and draws the stage's playhead.
 */
@Composable
private fun DeltaPlot(
    channels: SessionChannels,
    matches: List<ChannelGraphs.LapMatch>,
    lit: List<Int>,
    refIdx: Int,
    slots: List<Color>,
    markDistance: Double? = null,
    playhead: State<LapPlayhead?>? = null,
    onTap: (Double) -> Unit = {},
    onHover: (Double?) -> Unit = {},
    onScrub: ((Double) -> Unit)? = null,
) {
    val colors = TrackTheme.colors
    val units = LocalUnitSystem.current
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val labelStyle = TrackTheme.typography.xxs.copy(color = colors.textFaint)
    val titleStyle = TrackTheme.typography.xxs.copy(color = colors.textMuted)
    val readoutStyle = TrackTheme.typography.xxs.copy(color = colors.textStrong)

    fun lapNumber(chIdx: Int): Int =
        matches.firstOrNull { it.chIdx == chIdx }?.lap?.lapNum ?: channels.laps[chIdx].n

    val deltas = remember(channels, lit, refIdx) {
        lit
            .filter { it != refIdx && it in channels.laps.indices }
            .mapNotNull { chIdx ->
                ChannelGraphs.deltaSeries(channels.laps[chIdx], channels.laps[refIdx], channels.dStepM)
                    ?.let { chIdx to it }
            }
    }
    if (deltas.isEmpty()) return
    val domain = ChannelGraphs.deltaDomain(deltas.map { it.second }) ?: return
    val span = ChannelGraphs.distanceSpan(ChannelGraphs.Channel.SPEED, channels)
    if (span <= 0.0) return

    val gutter = with(density) { 5.dp.toPx() }
    val litWidth = with(density) { 2.dp.toPx() }
    val yLabels = remember(domain, labelStyle) {
        ChartScale.niceNumTicks(domain.low, domain.high, 3).map { it to measurer.measure(formatDelta(it, 1), labelStyle) }
    }
    val frame = remember(yLabels, span, density) {
        PlotFrame(
            padLeft = (yLabels.maxOfOrNull { it.second.size.width }?.toFloat() ?: 0f) + gutter * 2,
            padRight = with(density) { 10.dp.toPx() },
            padTop = with(density) { 18.dp.toPx() },
            padBottom = with(density) { 18.dp.toPx() },
            span = span,
        )
    }
    val bySeries = remember(deltas) { deltas.toMap() }

    val refN = lapNumber(refIdx)
    val summary = buildString {
        append("Time delta to lap $refN by driven distance — above the zero line is slower. ")
        append(
            deltas.joinToString(". ") { (chIdx, series) ->
                "Lap ${lapNumber(chIdx)}, ${formatDelta(series.last(), 2)} seconds vs lap $refN"
            },
        )
    }

    Box(
        Modifier
            .fillMaxWidth()
            .height(150.dp)
            .semantics {
                testTag = "channelChart:delta"
                contentDescription = summary
            }
            .plotPointer(frame, channels.dStepM, onTap, onHover, onScrub)
            .playheadOverlay(
                playhead = playhead,
                frame = frame,
                dStepM = channels.dStepM,
                // The reference is the zero line; its dot would sit on it.
                lit = lit.filter { it in bySeries },
                slots = slots,
                lineColor = colors.textStrong,
                haloColor = colors.surfaceCard,
                valueAt = { chIdx, k -> app.trackevolution.core.VideoSync.valueAt(bySeries[chIdx], k) },
                yFraction = { ChartScale.plottedFraction(it, domain).toFloat() },
                readout = { formatDelta(it, 2) + " s" },
                readoutStyle = readoutStyle,
                measurer = measurer,
                density = density.density,
            ),
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val plotW = frame.plotW(size.width)
            val plotH = frame.plotH(size.height)
            if (plotW <= 0f || plotH <= 0f) return@Canvas
            val padLeft = frame.padLeft
            val padRight = frame.padRight
            val padTop = frame.padTop
            val padBottom = frame.padBottom

            fun px(distance: Double) = frame.px(size.width, distance)
            fun py(value: Double) = padTop + ChartScale.plottedFraction(value, domain).toFloat() * plotH

            for ((tick, text) in yLabels) {
                val y = py(tick)
                drawLine(colors.chartGrid, Offset(padLeft, y), Offset(size.width - padRight, y), strokeWidth = 1f)
                drawText(text, topLeft = Offset(padLeft - gutter - text.size.width, y - text.size.height / 2f))
            }
            // Nice numbers in the unit the axis is labelled in — metres, or
            // miles — rather than nice metres converted (0.31, 0.62 mi…).
            for (tick in Units.distAxisTicks(span, units)) {
                val text = measurer.measure(tick.label, labelStyle)
                drawText(
                    text,
                    topLeft = Offset(
                        (px(tick.m) - text.size.width / 2f).coerceIn(0f, size.width - text.size.width),
                        size.height - text.size.height,
                    ),
                )
            }
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
                if (series.size < 2) continue
                val slot = lit.indexOf(chIdx)
                val path = Path()
                series.forEachIndexed { k, v ->
                    val x = px(k * channels.dStepM)
                    val y = py(v)
                    if (k == 0) path.moveTo(x, y) else path.lineTo(x, y)
                }
                drawPath(
                    path,
                    color = slots[(if (slot >= 0) slot else 0) % slots.size],
                    style = Stroke(width = litWidth, cap = StrokeCap.Round, join = StrokeJoin.Round),
                )
            }

            // The panel's mark, as on every chart sharing the axis (NS-51:
            // the delta chart drew none before).
            if (markDistance != null) {
                val x = px(markDistance.coerceIn(0.0, span))
                drawLine(
                    color = colors.textFaint,
                    start = Offset(x, padTop),
                    end = Offset(x, padTop + plotH),
                    strokeWidth = with(density) { 1.5.dp.toPx() },
                    pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f)),
                )
            }
        }
    }
}

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
    /**
     * A driven distance to mark, in metres, or null for none (NS-34 ticket 3).
     *
     * The port of the web's `showDistanceMark`: the friction circle hands over a
     * sample, and every chart on the shared distance axis says where that was.
     * One line on each chart is the whole mechanism — the charts already agree
     * about the axis, which is what makes the answer meaningful.
     */
    markDistance: Double? = null,
    /** The stage's playhead (NS-51), read in the draw phase only. */
    playhead: State<LapPlayhead?>? = null,
    /** A tap at a fractional grid index — a seek with a stage, a parked mark without. */
    onTap: (Double) -> Unit = {},
    onHover: (Double?) -> Unit = {},
    onScrub: ((Double) -> Unit)? = null,
) {
    val colors = TrackTheme.colors
    val units = LocalUnitSystem.current
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val labelStyle = TrackTheme.typography.xxs.copy(color = colors.textFaint)
    val titleStyle = TrackTheme.typography.xxs.copy(color = colors.textMuted)
    val readoutStyle = TrackTheme.typography.xxs.copy(color = colors.textStrong)

    val domain = ChannelGraphs.valueDomain(channel, channels, units) ?: return
    val span = ChannelGraphs.distanceSpan(channel, channels)
    val gridCount = ChannelGraphs.gridCount(channel, channels)
    if (gridCount < 2) return

    // The limit runs this chart's trace explains, for each highlighted lap
    // (#188). Empty for every channel with no kind pointed at it, and for every
    // session that stored neither `flags` nor `wheelSlip`.
    val bandKinds = Limits.LIMIT_KINDS.filter { it.channel == channel }
    val bands = if (bandKinds.isEmpty()) {
        emptyList()
    } else {
        lit.filter { it in channels.laps.indices }.flatMap { chIdx ->
            Limits.limitRuns(channels.laps[chIdx]).mapNotNull { run ->
                bandKinds.firstOrNull { it.key == run.kind }?.let { run to it }
            }
        }
    }

    // Measured here rather than fixed: an RPM axis label ("7400") is far wider
    // than a lateral-G one ("1.2"), and a single inset either wastes the plot or
    // lets the label run under it. In composition, not the draw, so a tap maps
    // x back to a distance against the same inset (NS-51).
    val gutter = with(density) { 5.dp.toPx() }
    val dimWidth = with(density) { 1.25.dp.toPx() }
    val litWidth = with(density) { 2.dp.toPx() }
    val yLabels = remember(domain, labelStyle, channel) {
        ChartScale.niceNumTicks(domain.low, domain.high, 3)
            .map { it to measurer.measure(formatTick(it, channel.decimals), labelStyle) }
    }
    val frame = remember(yLabels, span, density) {
        PlotFrame(
            padLeft = (yLabels.maxOfOrNull { it.second.size.width }?.toFloat() ?: 0f) + gutter * 2,
            padRight = with(density) { 10.dp.toPx() },
            padTop = with(density) { 18.dp.toPx() },
            padBottom = with(density) { 18.dp.toPx() },
            span = span,
        )
    }

    Box(
        Modifier
            .fillMaxWidth()
            .height(150.dp)
            .semantics {
                testTag = "channelChart:${channel.key}"
                contentDescription = channelSummary(
                    channel = channel,
                    extent = ChannelGraphs.valueExtent(channel, channels, units),
                    spanMetres = span,
                    litCount = lit.size,
                    units = units,
                    shaded = bands.map { it.second.label }.distinct(),
                )
            }
            .plotPointer(frame, channels.dStepM, onTap, onHover, onScrub)
            .playheadOverlay(
                playhead = playhead,
                frame = frame,
                dStepM = channels.dStepM,
                lit = lit.filter { it in channels.laps.indices },
                slots = slots,
                lineColor = colors.textStrong,
                haloColor = colors.surfaceCard,
                valueAt = { chIdx, k ->
                    app.trackevolution.core.VideoSync.valueAt(channel.series(channels.laps[chIdx]), k)
                        ?.let { channel.convert(it, units) }
                },
                yFraction = { ChartScale.plottedFraction(it, domain).toFloat() },
                readout = { formatTick(it, channel.decimals) + if (channel == ChannelGraphs.Channel.SPEED) " ${channel.unit(units)}" else "" },
                readoutStyle = readoutStyle,
                measurer = measurer,
                density = density.density,
            ),
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val plotW = frame.plotW(size.width)
            val plotH = frame.plotH(size.height)
            if (plotW <= 0f || plotH <= 0f) return@Canvas
            val padLeft = frame.padLeft
            val padRight = frame.padRight
            val padTop = frame.padTop
            val padBottom = frame.padBottom

            fun px(distance: Double) = frame.px(size.width, distance)

            fun py(value: Double) =
                padTop + ChartScale.plottedFraction(value, domain).toFloat() * plotH

            for ((tick, text) in yLabels) {
                val y = py(tick)
                drawLine(colors.chartGrid, Offset(padLeft, y), Offset(size.width - padRight, y), strokeWidth = 1f)
                drawText(text, topLeft = Offset(padLeft - gutter - text.size.width, y - text.size.height / 2f))
            }
            // Nice numbers in the unit the axis is labelled in — metres, or
            // miles — rather than nice metres converted (0.31, 0.62 mi…).
            for (tick in Units.distAxisTicks(span, units)) {
                val text = measurer.measure(tick.label, labelStyle)
                drawText(
                    text,
                    topLeft = Offset(
                        (px(tick.m) - text.size.width / 2f).coerceIn(0f, size.width - text.size.width),
                        size.height - text.size.height,
                    ),
                )
            }
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
            for ((run, kind) in bands) {
                val xa = px(max(0.0, run.k0 - 0.5) * channels.dStepM)
                val xb = px((run.k1 + 0.5) * channels.dStepM)
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
            val shadedKinds = bands.map { it.second.label }.distinct()
            if (shadedKinds.isNotEmpty()) {
                val note = measurer.measure("shaded: ${shadedKinds.joinToString(" / ")}", labelStyle)
                drawText(note, topLeft = Offset(size.width - padRight - note.size.width, 0f))
            }

            fun lapPath(lapIndex: Int): Path? {
                val series = channel.series(channels.laps[lapIndex]) ?: return null
                if (series.size < 2) return null
                val path = Path()
                series.forEachIndexed { k, raw ->
                    val x = px(k * channels.dStepM)
                    val y = py(channel.convert(raw, units))
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
            // Dashed and faint: it points *at* the traces rather than competing
            // with them for the eye.
            if (markDistance != null && span > 0.0) {
                val x = px(markDistance.coerceIn(0.0, span))
                drawLine(
                    color = colors.textFaint,
                    start = Offset(x, padTop),
                    end = Offset(x, padTop + plotH),
                    strokeWidth = with(density) { 1.5.dp.toPx() },
                    pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f)),
                )
            }
        }
    }
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
    spanMetres: Double,
    litCount: Int,
    units: UnitSystem,
    /** Limit kinds shaded on this chart (#188) — invisible to a screen reader. */
    shaded: List<String> = emptyList(),
): String = buildString {
    append("${channel.label} against distance over ${ChannelGraphs.fmtDist(spanMetres, units)}")
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
