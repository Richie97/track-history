package app.trackevolution.ui.charts

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
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
import app.trackevolution.core.Health
import app.trackevolution.core.ChartScale
import app.trackevolution.core.LapTime
import app.trackevolution.core.Limits
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.ui.theme.TrackTheme
import kotlin.math.abs
import kotlin.math.max

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
     * Channel-lap indexes to start highlighted, in slot order. Null means the
     * fastest lap — what the event page's overlay wants. The compare-laps
     * screen passes both laps of its pair.
     */
    initialSelection: List<Int>? = null,
) {
    val colors = TrackTheme.colors
    val matches = remember(channels, laps) { ChannelGraphs.matchLapsToChannels(laps, channels.laps) }
    val present = remember(channels) { ChannelGraphs.presentChannels(channels) }

    // Survives rotation: losing a three-lap comparison to a screen turn would
    // mean rebuilding it by hand.
    var lit by rememberSaveable(channels) {
        mutableStateOf(initialSelection ?: ChannelGraphs.initialSelection(matches))
    }

    if (present.isEmpty()) {
        // A session imported without channel data is normal — a hand-entered
        // one has none — so this says so rather than rendering empty axes.
        Text(
            "No channel data for this session.",
            style = TrackTheme.typography.sm,
            color = colors.textMuted,
            modifier = modifier.padding(vertical = 8.dp),
        )
        return
    }

    val slots = listOf(colors.chartLine, colors.chartLineB, colors.chartLineC)
    val bestMs = laps.minOfOrNull { it.timeMs }
    val lapNumber: (Int) -> Int =
        { chIdx -> matches.firstOrNull { it.chIdx == chIdx }?.lap?.lapNum ?: channels.laps[chIdx].n }

    // One question per tab (epic #193). Only populated tabs are offered, and a
    // single one renders flat — a tab bar with one tab in it is a control that
    // does nothing. Survives rotation for the same reason the selection does.
    val tabs = PanelTab.entries.filter { it.hasContent(present, channels) }
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
            "Laps on a shared distance axis — tap laps to compare (up to ${ChannelGraphs.SLOT_COUNT}). " +
                "With 2+ selected, the Time tab's delta chart shows where time is gained or lost vs " +
                "the fastest; the other tabs show why.",
            style = TrackTheme.typography.xs,
            color = colors.textMuted,
        )

        if (tabs.size > 1) {
            PanelTabs(tabs = tabs, current = shown, onSelect = { tab = it })
        }

        when (shown) {
            PanelTab.TIME -> {
                // Sector splits + theoretical best for the highlighted laps (#146),
                // above the charts as on the web.
                SectorTable(channels = channels, lit = lit, slots = slots, lapNumber = lapNumber)
                val refIdx = ChannelGraphs.deltaReference(lit, channels)
                if (refIdx != null) {
                    DeltaPlot(channels = channels, matches = matches, lit = lit, refIdx = refIdx, slots = slots)
                }
            }
            // The session's shift points (#187) above the traces they explain.
            PanelTab.INPUTS -> ShiftTable(channels = channels)
            // The friction circle (#186) above the lateral-G trace it
            // summarises. It draws nothing unless the session stored longG too,
            // so a source with only lateral G still gets its trace.
            PanelTab.GRIP -> {
                FrictionCircle(channels = channels, lit = lit, slots = slots, lapNumber = lapNumber)
                // Under it, the balance scatter and its per-corner table (#189),
                // above the lateral-G and yaw traces they are read from. It draws
                // nothing unless the session stored yaw, steering and speed.
                BalanceScatter(channels = channels, lit = lit, slots = slots, lapNumber = lapNumber)
            }
            // The session health strip (#190): what the car was doing while you
            // drove it, which is the other half of a track day.
            PanelTab.CAR -> HealthStrip(channels = channels, lit = lit, slots = slots)
        }

        for (channel in present.filter { PanelTab.of(it) == shown }) {
            ChannelPlot(channel = channel, channels = channels, matches = matches, lit = lit, slots = slots)
            // The gear ribbon rides under the RPM trace, where each shift is the
            // drop in the sawtooth above it (#187).
            if (channel == ChannelGraphs.Channel.RPM) {
                GearRibbon(channels = channels, lit = lit, slots = slots, lapNumber = lapNumber)
            }
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
 * The delta chart: highlighted laps vs the fastest of the selection ([refIdx]),
 * on the same distance axis as the channels below it. Positive is slower, so a
 * climbing trace is time slipping away. The reference lap draws no trace — it
 * *is* the zero line. The maths is `ChannelGraphs.deltaSeries` in `:core`,
 * pinned to the web implementation by `contracts/logic/lap-delta.json`.
 */
@Composable
private fun DeltaPlot(
    channels: SessionChannels,
    matches: List<ChannelGraphs.LapMatch>,
    lit: List<Int>,
    refIdx: Int,
    slots: List<Color>,
) {
    val colors = TrackTheme.colors
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val labelStyle = TrackTheme.typography.xxs.copy(color = colors.textFaint)
    val titleStyle = TrackTheme.typography.xxs.copy(color = colors.textMuted)

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
    val span = ChannelGraphs.distanceSpan(ChannelGraphs.Channel.SPEED, channels)
    if (span <= 0.0) return

    val gutter = with(density) { 5.dp.toPx() }
    val padRight = with(density) { 10.dp.toPx() }
    val padTop = with(density) { 18.dp.toPx() }
    val padBottom = with(density) { 18.dp.toPx() }
    val litWidth = with(density) { 2.dp.toPx() }

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
            },
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val yTicks = ChartScale.niceNumTicks(domain.low, domain.high, 3)
            val yLabels = yTicks.map { it to measurer.measure(formatDelta(it, 1), labelStyle) }
            val padLeft = (yLabels.maxOfOrNull { it.second.size.width }?.toFloat() ?: 0f) + gutter * 2

            val plotW = size.width - padLeft - padRight
            val plotH = size.height - padTop - padBottom
            if (plotW <= 0f || plotH <= 0f) return@Canvas

            fun px(distance: Double) = padLeft + (distance / span).toFloat() * plotW
            fun py(value: Double) = padTop + ChartScale.plottedFraction(value, domain).toFloat() * plotH

            for ((tick, text) in yLabels) {
                val y = py(tick)
                drawLine(colors.chartGrid, Offset(padLeft, y), Offset(size.width - padRight, y), strokeWidth = 1f)
                drawText(text, topLeft = Offset(padLeft - gutter - text.size.width, y - text.size.height / 2f))
            }
            for (tick in ChartScale.niceNumTicks(0.0, span, 6)) {
                val text = measurer.measure(ChannelGraphs.fmtDist(tick), labelStyle)
                drawText(
                    text,
                    topLeft = Offset(
                        (px(tick) - text.size.width / 2f).coerceIn(0f, size.width - text.size.width),
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
) {
    val colors = TrackTheme.colors
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val labelStyle = TrackTheme.typography.xxs.copy(color = colors.textFaint)
    val titleStyle = TrackTheme.typography.xxs.copy(color = colors.textMuted)

    val domain = ChannelGraphs.valueDomain(channel, channels) ?: return
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

    // Measured below rather than fixed: an RPM axis label ("7400") is far wider
    // than a lateral-G one ("1.2"), and a single inset either wastes the plot or
    // lets the label run under it.
    val gutter = with(density) { 5.dp.toPx() }
    val padRight = with(density) { 10.dp.toPx() }
    val padTop = with(density) { 18.dp.toPx() }
    val padBottom = with(density) { 18.dp.toPx() }
    val dimWidth = with(density) { 1.25.dp.toPx() }
    val litWidth = with(density) { 2.dp.toPx() }

    Box(
        Modifier
            .fillMaxWidth()
            .height(150.dp)
            .semantics {
                testTag = "channelChart:${channel.key}"
                contentDescription = channelSummary(
                    channel = channel,
                    extent = ChannelGraphs.valueExtent(channel, channels),
                    spanMetres = span,
                    litCount = lit.size,
                    shaded = bands.map { it.second.label }.distinct(),
                )
            },
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val yTicks = ChartScale.niceNumTicks(domain.low, domain.high, 3)
            val yLabels = yTicks.map { it to measurer.measure(formatTick(it, channel.decimals), labelStyle) }
            val padLeft = (yLabels.maxOfOrNull { it.second.size.width }?.toFloat() ?: 0f) + gutter * 2

            val plotW = size.width - padLeft - padRight
            val plotH = size.height - padTop - padBottom
            if (plotW <= 0f || plotH <= 0f) return@Canvas

            fun px(distance: Double) =
                padLeft + (if (span <= 0.0) 0.0 else distance / span).toFloat() * plotW

            fun py(value: Double) =
                padTop + ChartScale.plottedFraction(value, domain).toFloat() * plotH

            for ((tick, text) in yLabels) {
                val y = py(tick)
                drawLine(colors.chartGrid, Offset(padLeft, y), Offset(size.width - padRight, y), strokeWidth = 1f)
                drawText(text, topLeft = Offset(padLeft - gutter - text.size.width, y - text.size.height / 2f))
            }
            for (tick in ChartScale.niceNumTicks(0.0, span, 6)) {
                val text = measurer.measure(ChannelGraphs.fmtDist(tick), labelStyle)
                drawText(
                    text,
                    topLeft = Offset(
                        (px(tick) - text.size.width / 2f).coerceIn(0f, size.width - text.size.width),
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

            val title = measurer.measure("${channel.label} (${channel.unit})", titleStyle)
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
                    val y = py(channel.convert(raw))
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
    /** Limit kinds shaded on this chart (#188) — invisible to a screen reader. */
    shaded: List<String> = emptyList(),
): String = buildString {
    append("${channel.label} against distance over ${ChannelGraphs.fmtDist(spanMetres)}")
    if (extent != null) {
        // The measured range, not the padded axis — see ChannelGraphs.valueExtent.
        append(", ${formatTick(extent.first, channel.decimals)} to ")
        append("${formatTick(extent.second, channel.decimals)} ${channel.unit}")
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
