package app.trackevolution.ui.charts

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.PointMode
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.trackevolution.core.Balance
import app.trackevolution.core.Corners
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/**
 * The axes are padded this much past the furthest sample, and floored so a
 * session that never turned still draws a frame. `xMax` / `yMax` in the JS.
 */
private const val AXIS_PAD = 1.06
private const val MIN_ROTATION = 1e-3

/**
 * Balance — understeer or oversteer (#189) — the counterpart of
 * `balanceScatterSvg` and `balanceTableHtml` in `public/js/balance.js`.
 *
 * Steering angle across, rotation per metre up, one point per 20 m sample of
 * the highlighted laps over a dim envelope of the session's other laps, with a
 * dashed line for this car's typical response. Points above the line are
 * oversteer — the car rotated more than the steering asked for — and points
 * below it understeer. Under the plot, one row per corner: how each highlighted
 * lap took it, and the session pooled. The maths is `Balance` and `Corners` in
 * `:core`, pinned to the web implementation by `contracts/logic/balance.json`
 * and `corners.json`; this file draws.
 *
 * Four things about the drawing are load-bearing.
 *
 * **More rotation is up**, which the friction circle beside it deliberately
 * isn't: there `longG` is negative under braking and the canvas's downward y is
 * used as-is, here the y value is *subtracted* so a car rotating more than asked
 * plots above the reference line. Getting this backwards swaps understeer and
 * oversteer while failing no test.
 *
 * **The plot is not square.** The axes carry different units (degrees against
 * degrees per metre), so unlike the friction circle there is nothing to keep
 * round, and a wide box is what makes the band through the origin readable.
 *
 * **Rotation is yaw rate ÷ speed**, so a neutral car is one line through the
 * origin rather than a fan of lines, one per speed. That is what frees colour
 * for lap identity, which is what colour means everywhere else in the panel.
 *
 * **Readings are per corner, never per sample.** Yaw lags the steering at entry
 * and leads it at exit on the 20 m grid, so single points scatter around the
 * line: the scatter shows the shape and the table carries the numbers. Samples
 * that count toward no reading — straight-line, or slow — draw fainter so the
 * blob at the origin doesn't read as data.
 *
 * Unlike the web there is no per-point hover: a phone has no pointer, and the
 * best-lap track map the web rings on hover is on the event page rather than in
 * this panel.
 */
@Composable
fun BalanceScatter(
    channels: SessionChannels,
    /** Channel-lap indexes in slot order, as [LapChannelChart] keeps them. */
    lit: List<Int>,
    slots: List<Color>,
    /** The session's own lap number for a channel entry. */
    lapNumber: (Int) -> Int,
    modifier: Modifier = Modifier,
) {
    val readable = remember(channels) { Balance.balanceLaps(channels) }
    if (readable.isEmpty()) return
    val sign = remember(channels) { Balance.yawSign(channels) }
    val refGain = remember(channels) { Balance.referenceGain(channels, sign) }
    val sb = remember(channels) { Balance.sessionBalance(channels) }
    val lapPoints = remember(channels, sign) {
        readable.map { it.chIdx to Balance.balancePoints(it.entry, sign) }
    }
    val colors = TrackTheme.colors
    val measurer = rememberTextMeasurer()

    val columns = lit.mapIndexedNotNull { slot, chIdx ->
        if (readable.any { it.chIdx == chIdx }) chIdx to slots[slot % slots.size] else null
    }

    val summary = buildString {
        if (sb == null) {
            append("Not enough steering and rotation to read a balance")
        } else {
            Balance.balanceSummary(channels)?.let { append("Session: $it") }
            for ((chIdx, _) in columns) {
                val off = sb.corners.mapNotNull { row ->
                    val lap = row.laps.firstOrNull { it.chIdx == chIdx } ?: return@mapNotNull null
                    if (abs(lap.pct) < Balance.NEUTRAL_PCT) {
                        null
                    } else {
                        "${Corners.cornerLabel(row.corner)} ${Balance.fmtBalance(lap.pct)}"
                    }
                }
                append(". Lap ${lapNumber(chIdx)}: ")
                append(if (off.isEmpty()) "neutral everywhere" else off.joinToString(", "))
            }
        }
    }

    TrackCard(
        modifier
            .fillMaxWidth()
            .clearAndSetSemantics {
                testTag = "balanceScatter"
                contentDescription =
                    "Balance: rotation per metre against steering angle. $summary"
            },
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Balance", style = TrackTheme.typography.xxs, color = colors.textMuted)
            Text(
                "How much the car rotated for the steering it was given. Steering the car doesn't " +
                    "answer is understeer; rotation it wasn't asked for is oversteer.",
                style = TrackTheme.typography.xxs,
                color = colors.textFaint,
            )
            val labelStyle = TrackTheme.typography.xxs.copy(color = colors.textFaint)
            val grid = colors.chartGrid
            val border = colors.borderStrong
            val accent = colors.accent
            val dim = colors.chartDim
            Canvas(Modifier.fillMaxWidth().aspectRatio(1.6f)) {
                drawPlot(
                    lapPoints = lapPoints,
                    columns = columns,
                    refGain = refGain,
                    grid = grid,
                    border = border,
                    accent = accent,
                    dim = dim,
                    measurer = measurer,
                    labelStyle = labelStyle,
                )
            }
            if (sb != null) {
                CornerTable(
                    sb = sb,
                    columns = columns,
                    pooled = readable.size >= 2,
                    dStepM = channels.dStepM,
                    lapNumber = lapNumber,
                )
            }
            Text(
                "Corners are stretches of sustained cornering force " +
                    "(${"%.2f".format(Corners.CORNER_MIN_G)} G or more) counted from the start/finish " +
                    "line, so the T-numbers are this app's, not the circuit's. Each reading is how far " +
                    "the corner's rotation sits from this car's typical response over the whole session " +
                    "— the dashed line — because the exact version needs the wheelbase and steering " +
                    "ratio, which aren't recorded. That makes it relative: a car that pushes in every " +
                    "corner reads neutral in every corner, and what shows up is the corner that behaves " +
                    "differently from the rest.",
                style = TrackTheme.typography.xxs,
                color = colors.textFaint,
            )
        }
    }
}

private fun DrawScope.drawPlot(
    lapPoints: List<Pair<Int, List<Balance.Point>>>,
    columns: List<Pair<Int, Color>>,
    refGain: Double?,
    grid: Color,
    border: Color,
    accent: Color,
    dim: Color,
    measurer: TextMeasurer,
    labelStyle: TextStyle,
) {
    val padL = 44f * density
    val padR = 10f * density
    val padT = 16f * density
    val padB = 20f * density
    val plotW = size.width - padL - padR
    val plotH = size.height - padT - padB
    if (plotW <= 0f || plotH <= 0f) return

    var xMax = 0.0
    var yMax = 0.0
    for ((_, pts) in lapPoints) {
        for (p in pts) {
            xMax = max(xMax, abs(p.steer))
            yMax = max(yMax, abs(p.rot))
        }
    }
    xMax = max(xMax * AXIS_PAD, Balance.MIN_STEER_DEG)
    yMax = max(yMax * AXIS_PAD, MIN_ROTATION)

    val cx = padL + plotW / 2
    val cy = padT + plotH / 2
    val sx = plotW / 2 / xMax.toFloat()
    val sy = plotH / 2 / yMax.toFloat()
    fun x(deg: Double) = cx + (deg * sx).toFloat()
    // More rotation is up — see the file's documentation.
    fun y(rot: Double) = cy - (rot * sy).toFloat()

    // The frame: half-way lines and the ends, rather than a tick algorithm —
    // both axes are symmetric about zero, so those are the marks that read.
    for (fraction in listOf(-1.0, -0.5, 0.5, 1.0)) {
        val gy = y(yMax * fraction)
        drawLine(grid, Offset(padL, gy), Offset(size.width - padR, gy), strokeWidth = 1f * density)
        val label = measurer.measure("%.2f".format(yMax * fraction), labelStyle)
        drawText(label, topLeft = Offset(padL - 6f * density - label.size.width, gy - label.size.height / 2f))
    }
    for (fraction in listOf(-1.0, -0.5, 0.5, 1.0)) {
        val label = measurer.measure("%.0f°".format(xMax * fraction), labelStyle)
        drawText(
            label,
            topLeft = Offset(x(xMax * fraction) - label.size.width / 2f, size.height - padB + 2f * density),
        )
    }

    // The axes through the origin: a neutral car is a line through it.
    drawLine(border, Offset(padL, cy), Offset(size.width - padR, cy), strokeWidth = 1f * density)
    drawLine(border, Offset(cx, padT), Offset(cx, size.height - padB), strokeWidth = 1f * density)

    // The dim envelope, then the highlighted laps: a sample that counts toward
    // no reading draws fainter. Batched through drawPoints rather than a
    // drawCircle each, as the friction circle is.
    val dimPoints = ArrayList<Offset>()
    val hot = ArrayList<Triple<Color, List<Offset>, List<Offset>>>()
    for ((chIdx, pts) in lapPoints) {
        val color = columns.firstOrNull { it.first == chIdx }?.second
        if (color == null) {
            pts.forEach { dimPoints.add(Offset(x(it.steer), y(it.rot))) }
        } else {
            val counted = ArrayList<Offset>()
            val uncounted = ArrayList<Offset>()
            pts.forEach { (if (it.usable) counted else uncounted).add(Offset(x(it.steer), y(it.rot))) }
            hot.add(Triple(color, counted, uncounted))
        }
    }
    if (dimPoints.isNotEmpty()) {
        drawPoints(
            points = dimPoints,
            pointMode = PointMode.Points,
            color = dim,
            strokeWidth = 2.6f * density,
            cap = StrokeCap.Round,
        )
    }

    // The reference: this car's typical response, clipped to the plot.
    if (refGain != null && refGain > 0) {
        val xEnd = min(xMax, yMax / refGain)
        drawLine(
            color = accent,
            start = Offset(x(-xEnd), y(-xEnd * refGain)),
            end = Offset(x(xEnd), y(xEnd * refGain)),
            strokeWidth = 1.5f * density,
            pathEffect = PathEffect.dashPathEffect(floatArrayOf(5f * density, 4f * density)),
        )
        // Region words, in the right-hand half where positive steering lives.
        val over = measurer.measure("oversteer", labelStyle)
        drawText(over, topLeft = Offset(cx + 6f * density, padT))
        val under = measurer.measure("understeer", labelStyle)
        drawText(under, topLeft = Offset(size.width - padR - under.size.width, cy + 4f * density))
    }

    for ((color, counted, uncounted) in hot) {
        if (uncounted.isNotEmpty()) {
            drawPoints(
                points = uncounted,
                pointMode = PointMode.Points,
                color = color.copy(alpha = 0.3f),
                strokeWidth = 4.8f * density,
                cap = StrokeCap.Round,
            )
        }
        if (counted.isNotEmpty()) {
            drawPoints(
                points = counted,
                pointMode = PointMode.Points,
                color = color.copy(alpha = 0.85f),
                strokeWidth = 4.8f * density,
                cap = StrokeCap.Round,
            )
        }
    }
}

/**
 * One row per corner, a cell per highlighted lap and — with two or more readable
 * laps — the session pooled: `balanceTableHtml` in the JS. The corner's place on
 * track and its peak lateral G ride under its label rather than in columns of
 * their own, which is what keeps the table inside a phone's width.
 */
@Composable
private fun CornerTable(
    sb: Balance.SessionBalance,
    columns: List<Pair<Int, Color>>,
    pooled: Boolean,
    dStepM: Double,
    lapNumber: (Int) -> Int,
) {
    if (columns.isEmpty()) return
    val colors = TrackTheme.colors

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) {
                Text("Corner", style = TrackTheme.typography.xxs, color = colors.textFaint)
            }
            columns.forEach { (chIdx, color) ->
                Row(
                    Modifier.weight(1f),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(8.dp).background(color, CircleShape))
                    Text(
                        "  Lap ${lapNumber(chIdx)}",
                        style = TrackTheme.typography.xxs,
                        color = colors.textFaint,
                    )
                }
            }
            if (pooled) {
                Text(
                    "Session",
                    style = TrackTheme.typography.xxs,
                    color = colors.textFaint,
                    textAlign = TextAlign.End,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        sb.corners.forEach { row ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        Corners.cornerLabel(row.corner),
                        style = TrackTheme.typography.sm,
                        color = colors.textStrong,
                    )
                    Text(
                        "${fmtDist((row.corner.k0 * dStepM).roundToLong())} · " +
                            "${"%.2f".format(row.corner.peakG)} G",
                        style = TrackTheme.typography.xxs,
                        color = colors.textFaint,
                    )
                }
                columns.forEach { (chIdx, _) ->
                    Cell(row.laps.firstOrNull { it.chIdx == chIdx }?.pct, Modifier.weight(1f))
                }
                if (pooled) Cell(row.all.pct, Modifier.weight(1f))
            }
        }
    }
}

/**
 * A reading, or an em dash for a corner this lap never steered through. Neutral
 * reads faint and an off-reference corner strong — the same emphasis the web's
 * table uses, and deliberately not a colour per side: colour is lap identity in
 * this panel.
 */
@Composable
private fun Cell(pct: Double?, modifier: Modifier = Modifier) {
    val colors = TrackTheme.colors
    val neutral = pct == null || abs(pct) < Balance.NEUTRAL_PCT
    Text(
        pct?.let { Balance.fmtBalance(it) } ?: "—",
        style = TrackTheme.typography.xs.copy(
            fontWeight = if (neutral) FontWeight.Normal else FontWeight.SemiBold,
        ),
        color = if (neutral) colors.textFaint else colors.textStrong,
        textAlign = TextAlign.End,
        maxLines = 2,
        modifier = modifier,
    )
}

private fun fmtDist(m: Long): String =
    if (m >= 1000) {
        if (m % 1000 != 0L) "%.1f km".format(m / 1000.0) else "%.0f km".format(m / 1000.0)
    } else {
        "$m m"
    }
