package app.trackevolution.ui.charts

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.semantics.clearAndSetSemantics
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
import app.trackevolution.core.SessionConditions
import app.trackevolution.core.Units
import app.trackevolution.ui.theme.TrackTheme
import app.trackevolution.ui.LocalUnitSystem

/** One plotted lap time. [x] is an epoch millisecond or an ordinal. */
data class ProgressPoint(val x: Double, val label: String, val ms: Int)

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
    band: SessionConditions.Band? = null,
) {
    // An empty chart is a layout hole, not a chart. The web returns "" here and
    // the caller decides what to say instead; same contract.
    if (points.isEmpty()) return

    val colors = TrackTheme.colors
    val condUnits = Units.condUnits(LocalUnitSystem.current)
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current

    val labelStyle = TrackTheme.typography.xxs.copy(color = colors.textFaint)
    val goalStyle = TrackTheme.typography.xxs

    // The left gutter is measured below, not fixed: "2:00.25" is wider than
    // "1:59" and a fixed inset lets the widest tick label run under the plot.
    // This is only the floor.
    val pad = with(density) { Insets(0f, 14.dp.toPx(), 10.dp.toPx(), 22.dp.toPx()) }
    val gutter = with(density) { 6.dp.toPx() }
    val lineWidth = with(density) { 2.25.dp.toPx() }
    val dotRadius = with(density) { 4.5.dp.toPx() }
    val ringWidth = with(density) { 2.dp.toPx() }
    val goalWidth = with(density) { 1.5.dp.toPx() }

    val goal = goalMs
    val domain = ChartScale.lapTimeDomain(points.map { it.ms }, goal) ?: return
    val xDomain = ChartScale.xDomain(points.map { it.x }) ?: return
    val goalMet = goal != null && points.minOf { it.ms } <= goal

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(200.dp)
            .semantics {
                testTag = "progressChart"
                // A chart that is only visual is incomplete: TalkBack gets the
                // trend in words rather than "image" — and the wash behind it
                // (#191) is precisely what a screen-reader user cannot see, so
                // it is said out loud too.
                contentDescription = listOf(
                    trendSummary(points, goalMs),
                    SessionConditions.bandLabel(band, condUnits),
                ).filter { it.isNotEmpty() }.joinToString(", ")
            },
    ) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val ticks = ChartScale.niceTimeTicks(domain.low, domain.high)
            val tickLabels = ticks.map { it to measurer.measure(LapTime.fmtMs(it), labelStyle) }
            val left = (tickLabels.maxOfOrNull { it.second.size.width }?.toFloat() ?: 0f) + gutter * 2

            val plot = Plot(
                left = left,
                top = pad.top,
                width = size.width - left - pad.right,
                height = size.height - pad.top - pad.bottom,
            )
            if (plot.width <= 0f || plot.height <= 0f) return@Canvas

            fun px(x: Double) = plot.left + (ChartScale.horizontalFraction(x, xDomain) * plot.width).toFloat()
            fun py(ms: Double) = plot.top + (ChartScale.plottedFraction(ms, domain) * plot.height).toFloat()

            // The conditions wash goes down first, behind grid, line and
            // markers (#191): one cell per event spanning the midpoints between
            // neighbours, so each event owns the width around its own mark and
            // the shading reads as territory rather than as a bar per event. A
            // cell the band left null draws nothing at all — an unknown day must
            // not be painted the coolest shade.
            if (band != null && band.cells.size == points.size) {
                val xs = points.map { px(it.x) }
                band.cells.forEachIndexed { i, cell ->
                    if (cell == null) return@forEachIndexed
                    val cellLeft = if (i == 0) plot.left else (xs[i - 1] + xs[i]) / 2f
                    val cellRight = if (i == points.size - 1) plot.right else (xs[i] + xs[i + 1]) / 2f
                    if (cellRight <= cellLeft) return@forEachIndexed
                    drawRect(
                        color = colors.heat.copy(alpha = cell.alpha.toFloat()),
                        topLeft = Offset(cellLeft, plot.top),
                        size = androidx.compose.ui.geometry.Size(cellRight - cellLeft, plot.height),
                    )
                }
            }

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

            val path = Path()
            points.forEachIndexed { i, p ->
                val x = px(p.x)
                val y = py(p.ms.toDouble())
                if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            drawPath(
                path,
                color = colors.chartLine,
                style = Stroke(width = lineWidth, cap = androidx.compose.ui.graphics.StrokeCap.Round),
            )

            if (goal != null) {
                drawGoal(plot, py(goal.toDouble()), goal, goalMet, colors, measurer, goalStyle, goalWidth)
            }

            points.forEach { p ->
                drawMarker(Offset(px(p.x), py(p.ms.toDouble())), colors.chartLine, colors.surfaceCard, dotRadius, ringWidth)
            }
        }
    }
}

/**
 * The conditions band's key, for under the chart: pale is the coolest event in
 * view, deep the hottest. The same two alphas the wash itself is drawn with, so
 * the key is the legend for the thing above it rather than an approximation.
 *
 * Hidden from TalkBack on purpose — the chart's own content description already
 * says what the shading means, and a second reading of the same two temperatures
 * is noise.
 */
@Composable
fun ConditionsKey(band: SessionConditions.Band, modifier: Modifier = Modifier) {
    val colors = TrackTheme.colors
    val condUnits = Units.condUnits(LocalUnitSystem.current)
    Row(
        modifier = modifier.padding(top = 8.dp).clearAndSetSemantics {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            SessionConditions.tempText(band.loC, condUnits),
            style = TrackTheme.typography.xxs,
            color = colors.textFaint,
        )
        Box(
            Modifier
                .width(110.dp)
                .height(6.dp)
                .clip(RoundedCornerShape(3.dp))
                .background(
                    Brush.horizontalGradient(
                        listOf(
                            colors.heat.copy(alpha = SessionConditions.BAND_MIN_ALPHA.toFloat()),
                            colors.heat.copy(alpha = SessionConditions.BAND_MAX_ALPHA.toFloat()),
                        ),
                    ),
                ),
        )
        Text(
            SessionConditions.tempText(band.hiC, condUnits),
            style = TrackTheme.typography.xxs,
            color = colors.textFaint,
        )
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
    // The ends, and nothing between them.
    //
    // The web draws two intermediate labels as well, and this used to copy it —
    // but a date reads as "Feb 12, 2019" and a phone leaves the plot around 280dp,
    // so the four ran into each other. The axis here is a *range*, not a lookup
    // table: the event list under the chart is where a day's date is read, so the
    // axis says where the series starts and where it ends and stops there. The web
    // chart keeps its middle two — it is 900pt wide and has the room.
    val indices = linkedSetOf(0, n - 1)
    for (i in indices) {
        val p = points.getOrNull(i) ?: continue
        if (p.label.isEmpty()) continue
        val text = measurer.measure(p.label, style)
        val centre = px(p.x)
        // Anchored by the inside corner: the first label grows rightwards off its
        // mark and the last one leftwards, so neither hangs past the plot.
        val x = when {
            n == 1 -> centre - text.size.width / 2f
            i == 0 -> centre
            else -> centre - text.size.width
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
