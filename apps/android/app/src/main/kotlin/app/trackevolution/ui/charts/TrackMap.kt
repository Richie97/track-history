package app.trackevolution.ui.charts

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import app.trackevolution.core.ChartScale
import app.trackevolution.core.Limits
import app.trackevolution.core.TraceMap
import app.trackevolution.core.TracePoint
import app.trackevolution.core.TraceSample
import app.trackevolution.ui.theme.TrackColors
import app.trackevolution.ui.theme.TrackTheme
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The best lap's GPS trace, painted by speed (NS-24) — the port of
 * `public/js/trackmap.js`.
 *
 * Two passes, and the first is not decorative: a single tarmac-coloured [Path]
 * under the whole trace keeps the racing line continuous where the speed ramp's
 * per-segment strokes would otherwise show hairline gaps on tight corners.
 *
 * The fit, and in particular the y-flip that keeps north up, come from
 * [TraceMap] in `:core`, which is unit-tested. Get that flip wrong and every
 * circuit draws mirrored — recognisably a track, and the wrong way round.
 */
@Composable
fun TrackMap(
    trace: List<TraceSample>,
    modifier: Modifier = Modifier,
    /**
     * Where the best lap hit its limit (#188), placed on this trace by driven
     * distance ([Limits.limitMarkers]). Empty for a session with no `flags` or
     * `wheelSlip` channel, which is every recorded lap and every non-PDR import.
     */
    markers: List<Limits.Marker> = emptyList(),
) {
    // Matching `renderTrackMap`'s bail: fewer than ten points is a GPS glitch,
    // not a lap, and drawing it would claim more than we know.
    if (trace.size < MIN_POINTS) return

    val colors = TrackTheme.colors
    val density = LocalDensity.current
    val tarmacWidth = with(density) { 9.dp.toPx() }
    val rampWidth = with(density) { 3.5.dp.toPx() }
    val tickWidth = with(density) { 2.dp.toPx() }
    val tickLength = with(density) { 7.dp.toPx() }
    val markerRadius = with(density) { 6.dp.toPx() }
    val markerRing = with(density) { 2.dp.toPx() }
    // In dp, not raw pixels: the web's 14/15 are CSS pixels, and a marker that
    // clears its neighbour on a phone has to clear it at every density.
    val markerGap = with(density) { 14.dp.toPx() }
    val markerStep = with(density) { 15.dp.toPx() }

    // Stored samples carry no timestamp; TraceMap only needs the geometry.
    val points = remember(trace) { trace.map { TracePoint(t = 0.0, x = it.x, y = it.y, v = it.v) } }
    val speeds = remember(trace) { ChartScale.speedRange(trace) }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(220.dp)
            .background(colors.bgSubtle, RoundedCornerShape(TrackTheme.radii.md))
            .border(1.dp, colors.borderHairline, RoundedCornerShape(TrackTheme.radii.md))
            .semantics {
                testTag = "trackMap"
                contentDescription = trackMapSummary(trace, markers)
            },
    ) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val map = TraceMap.fit(
                trace = points,
                width = size.width.toDouble(),
                height = size.height.toDouble(),
                padding = TRACE_PADDING,
            ) ?: return@Canvas

            val view = points.map { map.viewPoint(it) }

            val path = Path()
            view.forEachIndexed { i, p ->
                if (i == 0) path.moveTo(p.x.toFloat(), p.y.toFloat()) else path.lineTo(p.x.toFloat(), p.y.toFloat())
            }
            drawPath(
                path,
                color = colors.mapTarmac,
                style = Stroke(width = tarmacWidth, cap = StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round),
            )

            // The ramp is drawn as one Path per colour band, not one drawLine
            // per segment.
            //
            // **Measured.** The per-segment version profiled at a 600 ms median
            // frame for four maps on the emulator — a 280-point trace is 279
            // draw calls. Bucketing into RAMP_BUCKETS bands makes it at most 16,
            // and took the whole chart gallery from 150 ms to 42 ms a frame. At
            // a 3.5 dp stroke the banding is not visible.
            //
            // This is the trap NS-24 flags, and the profiling confirmed which
            // half of it matters: a 20,000-point polyline in one Path is cheap,
            // while a few hundred separate draw calls are not. The web gets away
            // with per-segment strokes because a browser canvas batches them.
            val (slowest, fastest) = speeds ?: (0.0 to 0.0)
            val bands = Array(RAMP_BUCKETS) { Path() }
            for (i in 1 until view.size) {
                // The segment's colour averages its two ends, as the web does —
                // colouring by one end makes the ramp lag half a segment behind
                // the car through a corner.
                val t = (
                    ChartScale.speedFraction(trace[i - 1].v, slowest, fastest) +
                        ChartScale.speedFraction(trace[i].v, slowest, fastest)
                    ) / 2.0
                val bucket = (t.coerceIn(0.0, 1.0) * (RAMP_BUCKETS - 1)).roundToInt()
                bands[bucket].apply {
                    moveTo(view[i - 1].x.toFloat(), view[i - 1].y.toFloat())
                    lineTo(view[i].x.toFloat(), view[i].y.toFloat())
                }
            }
            bands.forEachIndexed { bucket, band ->
                if (band.isEmpty) return@forEachIndexed
                drawPath(
                    band,
                    color = lerp(colors.mapSlow, colors.mapFast, bucket / (RAMP_BUCKETS - 1f)),
                    style = Stroke(width = rampWidth, cap = StrokeCap.Round),
                )
            }

            // Then the limit marks on top (#188). Two kinds often fire in one
            // place — traction control *because of* wheelspin — so a mark landing
            // on an earlier one is stepped off the line rather than hidden under
            // it.
            val placed = mutableListOf<Offset>()
            for (marker in markers) {
                val kind = Limits.kindDef(marker.kind) ?: continue
                val p = view[marker.idx.coerceIn(0, view.size - 1)]
                var point = Offset(p.x.toFloat(), p.y.toFloat())
                while (placed.any { hypot((it.x - point.x).toDouble(), (it.y - point.y).toDouble()) < markerGap }) {
                    point = Offset(point.x, point.y - markerStep)
                }
                placed.add(point)
                drawLimitMarker(kind, point, colors, markerRadius, markerRing)
            }

            // Start/finish: a tick normal to the heading out of the first point.
            val head = view.getOrNull(min(3, view.size - 1))
            val start = view.first()
            if (head != null) {
                val dx = head.x - start.x
                val dy = head.y - start.y
                val len = hypot(dx, dy)
                if (len > 0.0) {
                    val nx = (-dy / len * tickLength).toFloat()
                    val ny = (dx / len * tickLength).toFloat()
                    drawLine(
                        color = colors.textStrong,
                        start = Offset(start.x.toFloat() - nx, start.y.toFloat() - ny),
                        end = Offset(start.x.toFloat() + nx, start.y.toFloat() + ny),
                        strokeWidth = tickWidth,
                        cap = StrokeCap.Round,
                    )
                }
            }
        }
    }
}

/** Fewer points than this is a glitch rather than a lap. */
private const val MIN_POINTS = 10

private const val TRACE_PADDING = 14.0

/**
 * Colour bands in the speed ramp. Enough that the gradient reads as continuous
 * at a 3.5 dp stroke, few enough that the whole trace is at most this many draw
 * calls regardless of how many fixes it holds.
 */
private const val RAMP_BUCKETS = 16

private const val MS_TO_MPH = 2.236936

/**
 * One limit marker: the kind's shape, filled or hollow in its side's colour with
 * a ring in the card colour, so shape and fill carry identity beside the hue and
 * no two kinds of one side are colour-alone.
 */
private fun DrawScope.drawLimitMarker(
    kind: Limits.Kind,
    at: Offset,
    colors: TrackColors,
    r: Float,
    ring: Float,
) {
    val color = limitColor(kind.side, colors)
    val fill = if (kind.filled) color else colors.surfaceCard
    val stroke = if (kind.filled) colors.surfaceCard else color
    when (kind.shape) {
        Limits.Shape.CIRCLE -> {
            drawCircle(fill, radius = r, center = at)
            drawCircle(stroke, radius = r, center = at, style = Stroke(width = ring))
        }
        Limits.Shape.TRIANGLE, Limits.Shape.DIAMOND -> {
            val path = Path()
            if (kind.shape == Limits.Shape.TRIANGLE) {
                path.moveTo(at.x, at.y - r * 1.15f)
                path.lineTo(at.x + r * 1.05f, at.y + r * 0.75f)
                path.lineTo(at.x - r * 1.05f, at.y + r * 0.75f)
            } else {
                path.moveTo(at.x, at.y - r * 1.2f)
                path.lineTo(at.x + r * 1.2f, at.y)
                path.lineTo(at.x, at.y + r * 1.2f)
                path.lineTo(at.x - r * 1.2f, at.y)
            }
            path.close()
            drawPath(path, color = fill)
            drawPath(path, color = stroke, style = Stroke(width = ring))
        }
    }
}

/**
 * The trace in words: TalkBack cannot see a racing line, and the limit marks are
 * the part of it that cannot be inferred from anything else on the page.
 */
internal fun trackMapSummary(
    trace: List<TraceSample>,
    markers: List<Limits.Marker> = emptyList(),
): String {
    val range = ChartScale.speedRange(trace)
        ?: return "Track map, ${trace.size} points."
    val (slowest, fastest) = range
    val line = "Track map, ${trace.size} points, " +
        "${(slowest * MS_TO_MPH).roundToInt()} to ${(fastest * MS_TO_MPH).roundToInt()} mph."
    if (markers.isEmpty()) return line
    val counts = Limits.LIMIT_KINDS.mapNotNull { kind ->
        val n = markers.count { it.kind == kind.key }
        if (n == 0) null else "${Limits.sentenceLabel(kind.key)} in $n place${if (n == 1) "" else "s"}"
    }
    return "$line ${counts.joinToString(", ")}."
}

/** Exposed for the palette check in tests. */
internal fun rampColor(fraction: Double, slow: Color, fast: Color): Color =
    lerp(slow, fast, fraction.toFloat().coerceIn(0f, 1f))
