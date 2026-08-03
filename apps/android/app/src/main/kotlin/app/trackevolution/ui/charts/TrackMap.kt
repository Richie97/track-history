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
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import app.trackevolution.core.ChartScale
import app.trackevolution.core.TraceMap
import app.trackevolution.core.TracePoint
import app.trackevolution.core.TraceSample
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
                contentDescription = trackMapSummary(trace)
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

/** The trace in words: TalkBack cannot see a racing line. */
internal fun trackMapSummary(trace: List<TraceSample>): String {
    val range = ChartScale.speedRange(trace)
        ?: return "Track map, ${trace.size} points."
    val (slowest, fastest) = range
    return "Track map, ${trace.size} points, " +
        "${(slowest * MS_TO_MPH).roundToInt()} to ${(fastest * MS_TO_MPH).roundToInt()} mph."
}

/** Exposed for the palette check in tests. */
internal fun rampColor(fraction: Double, slow: Color, fast: Color): Color =
    lerp(slow, fast, fraction.toFloat().coerceIn(0f, 1f))
