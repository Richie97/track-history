package app.trackevolution.ui.charts

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import app.trackevolution.core.ChartScale
import app.trackevolution.core.LapTime
import app.trackevolution.ui.theme.TrackTheme

/** One plotted lap time. [x] is an epoch millisecond or an ordinal. */
data class ProgressPoint(val x: Double, val label: String, val ms: Int)

enum class ProgressChartStyle { Full, Sparkline }

/**
 * The lap-time progress chart (NS-24) — the port of `lineChart` in
 * `public/js/chart.js`.
 *
 * **Lower is faster.** Improvement trends *downward*, which is the opposite of
 * most charts and is the single thing to get right here: the inversion lives in
 * `ChartScale.plottedFraction`, and because a Compose canvas already has y
 * growing downward, the fraction it returns is used as-is. Inverting a second
 * time would silently produce a chart that reads exactly backwards — the iOS
 * port shipped that bug once.
 *
 * Hand-rolled on `Canvas` rather than built on a charting library: the whole
 * thing is one path, some rules and a goal line, and a library's axis defaults
 * would have to be fought rather than used. It also keeps every colour coming
 * from `TrackTheme`, which NS-24 requires.
 */
@Composable
fun ProgressChart(
    points: List<ProgressPoint>,
    modifier: Modifier = Modifier,
    goalMs: Int? = null,
    style: ProgressChartStyle = ProgressChartStyle.Full,
) {
    // An empty chart is a layout hole, not a chart. The web returns "" here and
    // the caller decides what to say instead; same contract.
    if (points.isEmpty()) return

    val colors = TrackTheme.colors
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val sparkline = style == ProgressChartStyle.Sparkline

    val labelStyle = TrackTheme.typography.xxs.copy(color = colors.textFaint)
    val goalStyle = TrackTheme.typography.xxs

    val pad = with(density) {
        if (sparkline) {
            Insets(2.dp.toPx(), 6.dp.toPx(), 4.dp.toPx(), 4.dp.toPx())
        } else {
            // The left gutter is measured below, not fixed: "2:00.25" is wider
            // than "1:59" and a fixed inset lets the widest tick label run under
            // the plot. This is only the floor.
            Insets(0f, 14.dp.toPx(), 10.dp.toPx(), 22.dp.toPx())
        }
    }
    val gutter = with(density) { 6.dp.toPx() }
    val lineWidth = with(density) { (if (sparkline) 1.5.dp else 2.25.dp).toPx() }
    val dotRadius = with(density) { (if (sparkline) 3.dp else 4.5.dp).toPx() }
    val ringWidth = with(density) { 2.dp.toPx() }
    val goalWidth = with(density) { 1.5.dp.toPx() }

    // The goal only applies to the full chart — a sparkline has no room to say
    // what the dashed line means, and an unexplained rule is noise.
    val goal = goalMs?.takeIf { !sparkline }
    val domain = ChartScale.lapTimeDomain(points.map { it.ms }, goal) ?: return
    val xDomain = ChartScale.xDomain(points.map { it.x }) ?: return
    val goalMet = goal != null && points.minOf { it.ms } <= goal

    Box(
        modifier = modifier
            .fillMaxWidth()
            .then(if (sparkline) Modifier.height(44.dp) else Modifier.height(200.dp))
            .semantics {
                testTag = if (sparkline) "progressSparkline" else "progressChart"
                // A chart that is only visual is incomplete: TalkBack gets the
                // trend in words rather than "image".
                contentDescription = trendSummary(points, goalMs)
            },
    ) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val ticks = if (sparkline) emptyList() else ChartScale.niceTimeTicks(domain.low, domain.high)
            val tickLabels = ticks.map { it to measurer.measure(LapTime.fmtMs(it), labelStyle) }
            val left = if (sparkline) {
                pad.left
            } else {
                (tickLabels.maxOfOrNull { it.second.size.width }?.toFloat() ?: 0f) + gutter * 2
            }

            val plot = Plot(
                left = left,
                top = pad.top,
                width = size.width - left - pad.right,
                height = size.height - pad.top - pad.bottom,
            )
            if (plot.width <= 0f || plot.height <= 0f) return@Canvas

            fun px(x: Double) = plot.left + (ChartScale.horizontalFraction(x, xDomain) * plot.width).toFloat()
            fun py(ms: Double) = plot.top + (ChartScale.plottedFraction(ms, domain) * plot.height).toFloat()

            if (!sparkline) {
                for ((tick, text) in tickLabels) {
                    val y = py(tick)
                    drawLine(colors.chartGrid, Offset(plot.left, y), Offset(plot.right, y), strokeWidth = 1f)
                    drawText(
                        text,
                        topLeft = Offset(plot.left - gutter - text.size.width, y - text.size.height / 2f),
                    )
                }
                drawLine(
                    colors.borderStrong,
                    Offset(plot.left, plot.bottom),
                    Offset(plot.right, plot.bottom),
                    strokeWidth = 1f,
                )
                drawXLabels(plot, points, measurer, labelStyle, ::px, size.height)
            }

            val path = Path()
            points.forEachIndexed { i, p ->
                val x = px(p.x)
                val y = py(p.ms.toDouble())
                if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            drawPath(
                path,
                color = if (sparkline) colors.textFaint else colors.chartLine,
                style = Stroke(width = lineWidth, cap = androidx.compose.ui.graphics.StrokeCap.Round),
            )

            if (goal != null) {
                drawGoal(plot, py(goal.toDouble()), goal, goalMet, colors, measurer, goalStyle, goalWidth)
            }

            if (sparkline) {
                // Only the newest point, as the web does — a 44dp strip cannot
                // carry a marker per event.
                val last = points.last()
                drawMarker(Offset(px(last.x), py(last.ms.toDouble())), colors.accent, colors.surfaceCard, dotRadius, ringWidth)
            } else {
                points.forEach { p ->
                    drawMarker(Offset(px(p.x), py(p.ms.toDouble())), colors.chartLine, colors.surfaceCard, dotRadius, ringWidth)
                }
            }
        }
    }
}

private data class Insets(val left: Float, val right: Float, val top: Float, val bottom: Float)

private data class Plot(val left: Float, val top: Float, val width: Float, val height: Float) {
    val right: Float get() = left + width
    val bottom: Float get() = top + height
}

private fun DrawScope.drawXLabels(
    plot: Plot,
    points: List<ProgressPoint>,
    measurer: TextMeasurer,
    style: TextStyle,
    px: (Double) -> Float,
    canvasHeight: Float,
) {
    val n = points.size
    // First, last, and up to two between — the web's choice, and enough for a
    // phone without labels colliding.
    val indices = linkedSetOf(0, (n - 1) / 3, (n - 1) * 2 / 3, n - 1)
    for (i in indices) {
        val p = points.getOrNull(i) ?: continue
        if (p.label.isEmpty()) continue
        val text = measurer.measure(p.label, style)
        val centre = px(p.x)
        val x = when {
            n == 1 -> centre - text.size.width / 2f
            i == 0 -> centre
            i == n - 1 -> centre - text.size.width
            else -> centre - text.size.width / 2f
        }
        drawText(
            text,
            topLeft = Offset(
                x.coerceIn(plot.left, plot.right - text.size.width),
                canvasHeight - text.size.height,
            ),
        )
    }
}

private fun DrawScope.drawGoal(
    plot: Plot,
    y: Float,
    goalMs: Int,
    met: Boolean,
    colors: app.trackevolution.ui.theme.TrackColors,
    measurer: TextMeasurer,
    style: TextStyle,
    width: Float,
) {
    // Green once beaten, red while it stands — the same semantics the web uses,
    // so the colour carries the state and not just the line's identity.
    val color = if (met) colors.positive else colors.danger
    drawLine(
        color = color,
        start = Offset(plot.left, y),
        end = Offset(plot.right, y),
        strokeWidth = width,
        pathEffect = PathEffect.dashPathEffect(floatArrayOf(12f, 10f)),
    )
    val label = "Goal ${LapTime.fmtMs(goalMs)}" + if (met) " ✓" else ""
    val text = measurer.measure(label, style.copy(color = color))
    drawText(
        text,
        topLeft = Offset(plot.right - text.size.width, y - text.size.height - 2f),
    )
}

private fun DrawScope.drawMarker(
    centre: Offset,
    fill: Color,
    ring: Color,
    radius: Float,
    ringWidth: Float,
) {
    // The ring is what keeps a marker legible where the line passes behind it.
    drawCircle(color = ring, radius = radius + ringWidth / 2f, center = centre)
    drawCircle(color = fill, radius = radius, center = centre)
}

/**
 * What TalkBack reads instead of the picture.
 *
 * Deliberately says the direction in words — "improving" rather than a slope —
 * because the whole convention of this chart is that down is better, and that
 * is exactly the part a screen reader user cannot see.
 */
internal fun trendSummary(points: List<ProgressPoint>, goalMs: Int?): String {
    if (points.isEmpty()) return "No lap times yet."
    val best = points.minOf { it.ms }
    val parts = mutableListOf<String>()
    parts += "${points.size} ${if (points.size == 1) "entry" else "entries"}"
    parts += "best ${LapTime.fmtMs(best)}"
    if (points.size >= 2) {
        val first = points.first().ms
        val last = points.last().ms
        parts += when {
            last < first -> "improving by ${LapTime.fmtMs(first - last)}"
            last > first -> "slower by ${LapTime.fmtMs(last - first)}"
            else -> "unchanged"
        }
    }
    if (goalMs != null) {
        parts += if (best <= goalMs) "goal ${LapTime.fmtMs(goalMs)} met" else "goal ${LapTime.fmtMs(goalMs)} not yet met"
    }
    return parts.joinToString(", ") + "."
}
