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
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.PointMode
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.trackevolution.core.Grip
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlin.math.ceil
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Ring spacing, in G. A slow car simply draws fewer rings. */
private const val RING_STEP_G = 0.5

/**
 * The friction circle (#186) — the counterpart of `frictionCircleSvg` and
 * `gripReadoutHtml` in `public/js/grip.js`.
 *
 * Every 20 m sample of the highlighted laps plotted lateral against
 * longitudinal G, over a dim envelope of the session's other laps, with a
 * dashed reference arc at the session's own peak combined G. A driver who
 * brakes in a straight line, turns, then accelerates draws a cross; one who
 * trails the brake in and feeds the power out fills the circle, and the empty
 * space between the two is the lost time. The maths is `Grip` in `:core`,
 * pinned to the web implementation by `contracts/logic/grip.json`; this file
 * draws.
 *
 * Three things about the drawing are load-bearing.
 *
 * **Braking is up.** `longG` is negative under braking, so the y mapping adds
 * rather than subtracts — deceleration is what a driver feels pitching the car
 * forward, and it is the one axis here with a fixed place in their head. A
 * Compose canvas already grows y downward, so the JS mapping ports across
 * unchanged; inverting it "to fix the sign" draws the chart upside down and
 * fails no test, which is why it is written down in both ports.
 *
 * **The plot area is square** (`aspectRatio(1f)`), because a circle that draws
 * as an ellipse makes the whole reading wrong.
 *
 * **The samples go through `drawPoints`, not a `drawCircle` each.** A stored
 * session's channels are capped by `MAX_TOTAL_VALUES`, so `latG` runs to a few
 * thousand samples — one batched call per group, rather than one draw call per
 * point.
 *
 * There is no *hover* — a phone has no pointer — but there is a **tap**, and it
 * does what the web's hover does: [onHit] answers "which corner is this dot" on
 * everything drawn beside the panel (NS-34 ticket 3). That was worth nothing
 * while the panel lived inside a session card with the track map a long scroll
 * away; it is worth having now the two sit side by side at expanded width. The
 * read-out under the plot still carries the meaning when nothing is tapped.
 */
@Composable
fun FrictionCircle(
    channels: SessionChannels,
    /** Channel-lap indexes in slot order, as [LapChannelChart] keeps them. */
    lit: List<Int>,
    slots: List<Color>,
    /** The session's own lap number for a channel entry. */
    lapNumber: (Int) -> Int,
    modifier: Modifier = Modifier,
    /**
     * Tapping a sample answers "which corner is this dot" on everything drawn
     * beside it (NS-34 ticket 3). Null clears the answer.
     */
    onHit: (ChannelHit?) -> Unit = {},
) {
    val sg = remember(channels) { Grip.sessionGrip(channels) } ?: return
    val gripLaps = remember(channels) { Grip.gripLaps(channels) }
    val colors = TrackTheme.colors
    val measurer = rememberTextMeasurer()

    val rows = lit.mapIndexedNotNull { slot, chIdx ->
        sg.laps.firstOrNull { it.chIdx == chIdx }?.let { slots[slot % slots.size] to it }
    }

    val summary = buildString {
        rows.forEachIndexed { i, (_, lap) ->
            if (i > 0) append(". ")
            append("Lap ${lapNumber(lap.chIdx)}: ${lap.trailPct.roundToInt()} percent braking while ")
            append("cornering, ${lap.powerPct.roundToInt()} percent cornering on the power")
        }
        sg.peakG?.let { append(". Peak combined ${"%.2f".format(it)} G") }
    }

    TrackCard(
        modifier
            .fillMaxWidth()
            .clearAndSetSemantics {
                testTag = "frictionCircle"
                contentDescription = "Friction circle: cornering against braking and acceleration. $summary"
            },
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Friction circle", style = TrackTheme.typography.xxs, color = colors.textMuted)
            Text(
                "How much of the tyre is being used. 20 m samples, so this is the shape of " +
                    "grip usage, not peak G.",
                style = TrackTheme.typography.xxs,
                color = colors.textFaint,
            )
            val faint = colors.textFaint
            val grid = colors.chartGrid
            val border = colors.borderStrong
            val accent = colors.accent
            val dim = colors.chartDim
            val labelStyle = TrackTheme.typography.xxs.copy(color = faint)
            val arcStyle = TrackTheme.typography.xxs.copy(color = colors.accentInk)
            Canvas(
                Modifier
                    .fillMaxWidth()
                    .aspectRatio(1f)
                    // Tap, not hover: a phone has no pointer, and taking the
                    // web's hover behaviour back is the point of NS-34 ticket 3.
                    // A mouse on a tablet or Chromebook is ticket 5's, and is
                    // additive to this rather than a replacement.
                    .pointerInput(sg, lit, gripLaps) {
                        detectTapGestures { offset ->
                            onHit(hitAt(offset, size.width, size.height, sg, gripLaps, lit, density))
                        }
                    },
            ) {
                drawPlot(
                    sg = sg,
                    gripLaps = gripLaps,
                    lit = lit,
                    slots = slots,
                    grid = grid,
                    border = border,
                    accent = accent,
                    dim = dim,
                    measurer = measurer,
                    labelStyle = labelStyle,
                    arcStyle = arcStyle,
                )
            }
            Readout(sg = sg, rows = rows, lapNumber = lapNumber)
        }
    }
}

/**
 * The axis domain: the furthest sample, or the reference arc if it somehow
 * reaches further, with a little air — rounded up to a ring boundary so the
 * outermost ring is a labelled one. `axisMaxG` in the JS.
 */
private fun axisMaxG(sg: Grip.SessionGrip): Double {
    val need = max(sg.maxG, sg.peakG ?: 0.0) * 1.04
    return max(RING_STEP_G, ceil(need / RING_STEP_G) * RING_STEP_G)
}

/**
 * The plotted sample nearest a tap, among the **highlighted** laps only.
 *
 * The envelope behind them is every other lap at once; a tap landing on it has no
 * single answer to give, so it clears instead. Within a lit lap the nearest
 * sample wins, but only inside a finger-sized radius — a tap on empty canvas
 * should mean "never mind", not "the closest dot, wherever it is".
 *
 * The transform is [drawPlot]'s, deliberately duplicated rather than hoisted: one
 * takes a `DrawScope` and this takes a tap, and pulling the four lines they share
 * into a shape object would be more indirection than the arithmetic is worth.
 * They fail together, and visibly — a change to one that misses the other puts
 * the ring in the wrong corner the first time it is used.
 */
internal fun hitAt(
    offset: Offset,
    width: Int,
    height: Int,
    sg: Grip.SessionGrip,
    gripLaps: List<Grip.GripLap>,
    lit: List<Int>,
    density: Float,
): ChannelHit? {
    val inset = 18f * density
    val side = min(width.toFloat(), height.toFloat()) - inset * 2
    if (side <= 0f) return null
    val cx = width / 2f
    val cy = height / 2f
    val scale = (side / 2) / axisMaxG(sg).toFloat()
    if (scale <= 0f) return null

    var bestDistance = Float.MAX_VALUE
    var best: ChannelHit? = null
    for (chIdx in lit) {
        val lap = gripLaps.firstOrNull { it.chIdx == chIdx } ?: continue
        val points = Grip.gripPoints(lap.entry)
        if (points.size < 2) continue
        for (p in points) {
            val x = cx + (p.lat * scale).toFloat()
            val y = cy + (p.long * scale).toFloat()
            val d = hypot(x - offset.x, y - offset.y)
            if (d < bestDistance) {
                bestDistance = d
                best = ChannelHit(chIdx = chIdx, k = p.k, frac = p.k.toDouble() / (points.size - 1))
            }
        }
    }
    return if (bestDistance <= 22f * density) best else null
}

private fun DrawScope.drawPlot(
    sg: Grip.SessionGrip,
    gripLaps: List<Grip.GripLap>,
    lit: List<Int>,
    slots: List<Color>,
    grid: Color,
    border: Color,
    accent: Color,
    dim: Color,
    measurer: TextMeasurer,
    labelStyle: TextStyle,
    arcStyle: TextStyle,
) {
    // Room for the axis words above and below the plot.
    val inset = 18f * density
    val side = min(size.width, size.height) - inset * 2
    if (side <= 0f) return
    val cx = size.width / 2
    val cy = size.height / 2
    val axis = axisMaxG(sg)
    val scale = (side / 2) / axis.toFloat()

    // Braking is up: longG is negative under braking, and a canvas grows y
    // downward, so the value is *added* — see the file's documentation.
    fun point(lat: Double, long: Double) = Offset(cx + (lat * scale).toFloat(), cy + (long * scale).toFloat())

    // Rings every RING_STEP_G, labelled along the +x axis.
    var ring = RING_STEP_G
    while (ring <= axis + 1e-9) {
        val r = (ring * scale).toFloat()
        drawCircle(color = grid, radius = r, center = Offset(cx, cy), style = Stroke(width = 1f * density))
        val label = measurer.measure("%.1f".format(ring), labelStyle)
        drawText(label, topLeft = Offset(cx + r - label.size.width / 2f, cy + 3f * density))
        ring += RING_STEP_G
    }

    // The axes.
    drawLine(border, Offset(cx - side / 2, cy), Offset(cx + side / 2, cy), strokeWidth = 1f * density)
    drawLine(border, Offset(cx, cy - side / 2), Offset(cx, cy + side / 2), strokeWidth = 1f * density)

    // The dim envelope: every lap that isn't highlighted, batched into one call.
    val dimPoints = ArrayList<Offset>()
    val hot = ArrayList<Pair<Color, List<Offset>>>()
    for (lap in gripLaps) {
        val points = Grip.gripPoints(lap.entry).map { point(it.lat, it.long) }
        val slot = lit.indexOf(lap.chIdx)
        if (slot >= 0) hot.add(slots[slot % slots.size] to points) else dimPoints.addAll(points)
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

    // The reference arc: what this car did today, at the 99th percentile.
    val peak = sg.peakG
    if (peak != null && peak > 0) {
        val r = (peak * scale).toFloat()
        drawCircle(
            color = accent,
            radius = r,
            center = Offset(cx, cy),
            style = Stroke(
                width = 1.5f * density,
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(5f * density, 4f * density)),
            ),
        )
        val label = measurer.measure("%.2f G".format(peak), arcStyle)
        drawText(
            label,
            topLeft = Offset(cx - label.size.width / 2f, cy - r - label.size.height - 2f * density),
        )
    }

    for ((color, points) in hot) {
        drawPoints(
            points = points,
            pointMode = PointMode.Points,
            color = color.copy(alpha = 0.75f),
            strokeWidth = 4.8f * density,
            cap = StrokeCap.Round,
        )
    }

    // Axis words. The sides say "cornering" rather than left/right, because the
    // side is derived from the steering sign rather than stored.
    val braking = measurer.measure("braking", labelStyle)
    drawText(braking, topLeft = Offset(cx - braking.size.width / 2f, cy - side / 2 - braking.size.height))
    val power = measurer.measure("power", labelStyle)
    drawText(power, topLeft = Offset(cx - power.size.width / 2f, cy + side / 2))
    // The plot is a disc, so a corner of the square is the one place no sample
    // can ever land.
    val cornering = measurer.measure("cornering (G)", labelStyle)
    drawText(cornering, topLeft = Offset(cx - side / 2, cy - side / 2))
}

/**
 * The share of *loaded* samples spent doing two things at once, per highlighted
 * lap, with the session pooled underneath once there is more than one lap to
 * pool — `gripReadoutHtml` in the JS.
 */
@Composable
private fun Readout(
    sg: Grip.SessionGrip,
    rows: List<Pair<Color, Grip.LapShares>>,
    lapNumber: (Int) -> Int,
) {
    if (rows.isEmpty()) return
    val colors = TrackTheme.colors

    @Composable
    fun line(label: @Composable () -> Unit, trail: String, power: String, color: Color) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { label() }
            Text(
                trail,
                style = TrackTheme.typography.sm,
                color = color,
                textAlign = TextAlign.End,
                modifier = Modifier.weight(0.8f),
            )
            Text(
                power,
                style = TrackTheme.typography.sm,
                color = color,
                textAlign = TextAlign.End,
                modifier = Modifier.weight(0.8f),
            )
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        line(
            label = {},
            trail = "Braking +\ncornering",
            power = "Cornering +\npower",
            color = colors.textFaint,
        )
        rows.forEach { (color, lap) ->
            line(
                label = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(8.dp).background(color, CircleShape))
                        Text(
                            "  Lap ${lapNumber(lap.chIdx)}",
                            style = TrackTheme.typography.xs,
                            color = colors.textMuted,
                        )
                    }
                },
                trail = "${lap.trailPct.roundToInt()}%",
                power = "${lap.powerPct.roundToInt()}%",
                color = colors.textStrong,
            )
        }
        if (sg.laps.size >= 2) {
            line(
                label = {
                    Text(
                        "Session",
                        style = TrackTheme.typography.xs.copy(fontStyle = FontStyle.Italic),
                        color = colors.textMuted,
                    )
                },
                trail = "${sg.all.trailPct.roundToInt()}%",
                power = "${sg.all.powerPct.roundToInt()}%",
                color = colors.textMuted,
            )
        }
        Text(
            "Share of the samples where the tyre was working (${"%.2f".format(Grip.MIN_LOAD_G)} G combined " +
                "or more) spent doing two things at once. Brake straight, turn, then accelerate and both " +
                "stay low — the gap to the arc is time.",
            style = TrackTheme.typography.xxs,
            color = colors.textFaint,
        )
    }
}
