package app.trackevolution.recording

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import app.trackevolution.core.Gate
import app.trackevolution.core.TraceMap
import app.trackevolution.core.TracePoint
import app.trackevolution.ui.theme.TrackTheme

/**
 * Pick the start/finish line by tapping the driven trace.
 *
 * A live recording has no lap markers (`needsLine = true`), so this is how a
 * recording becomes laps: tap a point, `GeoTrace.buildGate` builds a gate
 * perpendicular to the direction of travel there, and every pass across it is
 * timed. The caller re-derives the lap list on each tap, so a bad pick is
 * obvious at once rather than after saving.
 *
 * Pan and zoom are a deliberate improvement on the web version, where the touch
 * target for a pick is tiny. The geometry — fitting, hit-testing, the y-flip —
 * lives in [TraceMap] in `:core`, so it is unit-tested; this only draws and
 * routes gestures.
 */
@Composable
fun LinePicker(
    trace: List<TracePoint>,
    gate: Gate?,
    pickedIndex: Int?,
    onPick: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    var scale by remember { mutableFloatStateOf(1f) }
    var pan by remember { mutableStateOf(Offset.Zero) }
    var size by remember { mutableStateOf(Offset.Zero) }
    val strokeWidth = with(LocalDensity.current) { 2.dp.toPx() }
    val gateWidth = with(LocalDensity.current) { 3.dp.toPx() }
    val dotRadius = with(LocalDensity.current) { 5.dp.toPx() }

    fun map(): TraceMap? = TraceMap.fit(
        trace = trace,
        width = size.x.toDouble(),
        height = size.y.toDouble(),
        scale = scale.toDouble(),
        panX = pan.x.toDouble(),
        panY = pan.y.toDouble(),
    )

    Box(
        modifier = modifier
            .background(colors.bgSubtle, RoundedCornerShape(TrackTheme.radii.md))
            .border(1.dp, colors.borderHairline, RoundedCornerShape(TrackTheme.radii.md)),
    ) {
        Canvas(
            modifier = Modifier
                .fillMaxSize()
                // Measured here rather than read inside the draw scope: writing
                // state during a draw re-triggers the draw, forever.
                .onSizeChanged { size = Offset(it.width.toFloat(), it.height.toFloat()) }
                .semantics {
                    testTag = "linePickerMap"
                    contentDescription = "Driven trace. Tap to place the start/finish line."
                }
                // Transform first: a pinch that also moved would otherwise be
                // read as a tap when it ends.
                .pointerInput(Unit) {
                    detectTransformGestures { _, panChange, zoomChange, _ ->
                        scale = (scale * zoomChange).coerceIn(1f, 12f)
                        pan = if (scale <= 1f) Offset.Zero else pan + panChange
                    }
                }
                .pointerInput(trace, scale, pan, size) {
                    detectTapGestures { offset ->
                        val m = map() ?: return@detectTapGestures
                        m.nearestIndex(offset.x.toDouble(), offset.y.toDouble(), trace)
                            ?.let(onPick)
                    }
                },
        ) {
            val m = TraceMap.fit(
                trace = trace,
                width = this.size.width.toDouble(),
                height = this.size.height.toDouble(),
                scale = scale.toDouble(),
                panX = pan.x.toDouble(),
                panY = pan.y.toDouble(),
            ) ?: return@Canvas

            drawTrace(m, trace, colors.mapTarmac, strokeWidth)
            gate?.let { drawGate(m, it, colors.accent, gateWidth) }
            pickedIndex?.let { index ->
                trace.getOrNull(index)?.let { point ->
                    val p = m.viewPoint(point)
                    drawCircle(
                        color = colors.accent,
                        radius = dotRadius,
                        center = Offset(p.x.toFloat(), p.y.toFloat()),
                    )
                }
            }
        }

        if (scale > 1.01f || pan != Offset.Zero) {
            ResetButton { scale = 1f; pan = Offset.Zero }
        }
    }
}

@Composable
private fun BoxScope.ResetButton(onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        modifier = Modifier.align(Alignment.TopEnd).padding(4.dp),
    ) {
        Text("Reset view", style = TrackTheme.typography.xs, color = TrackTheme.colors.accentInk)
    }
}

private fun DrawScope.drawTrace(
    map: TraceMap,
    trace: List<TracePoint>,
    color: androidx.compose.ui.graphics.Color,
    width: Float,
) {
    if (trace.size < 2) return
    val path = Path()
    trace.forEachIndexed { i, point ->
        val p = map.viewPoint(point)
        if (i == 0) path.moveTo(p.x.toFloat(), p.y.toFloat()) else path.lineTo(p.x.toFloat(), p.y.toFloat())
    }
    drawPath(path, color = color, style = Stroke(width = width))
}

private fun DrawScope.drawGate(
    map: TraceMap,
    gate: Gate,
    color: androidx.compose.ui.graphics.Color,
    width: Float,
) {
    val (from, to) = map.viewSegment(gate)
    drawLine(
        color = color,
        start = Offset(from.x.toFloat(), from.y.toFloat()),
        end = Offset(to.x.toFloat(), to.y.toFloat()),
        strokeWidth = width,
    )
}
