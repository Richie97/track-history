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
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import app.trackevolution.core.ChannelGraphs
import app.trackevolution.core.ChartScale
import app.trackevolution.core.LapTime
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.ui.theme.TrackTheme
import kotlin.math.abs

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
                "With 2+ selected, the delta chart shows where time is gained or lost vs the fastest.",
            style = TrackTheme.typography.xs,
            color = colors.textMuted,
        )

        // Sector splits + theoretical best for the highlighted laps (#146),
        // above the charts as on the web.
        SectorTable(
            channels = channels,
            lit = lit,
            slots = slots,
            lapNumber = { chIdx -> matches.firstOrNull { it.chIdx == chIdx }?.lap?.lapNum ?: channels.laps[chIdx].n },
        )

        val refIdx = ChannelGraphs.deltaReference(lit, channels)
        if (refIdx != null) {
            DeltaPlot(channels = channels, matches = matches, lit = lit, refIdx = refIdx, slots = slots)
        }

        for (channel in present) {
            ChannelPlot(channel = channel, channels = channels, matches = matches, lit = lit, slots = slots)
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

            val title = measurer.measure("${channel.label} (${channel.unit})", titleStyle)
            drawText(title, topLeft = Offset(padLeft, 0f))

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
}
