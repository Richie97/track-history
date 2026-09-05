package app.trackevolution.ui.charts

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import app.trackevolution.core.Limits
import app.trackevolution.ui.theme.TrackTheme

/**
 * The track map's limit legend (#188) — the counterpart of the `limit-legend`
 * row in `viewEvent` (`public/app.js`).
 *
 * One entry per kind actually marked on this lap, drawn with the same shape and
 * fill rule [TrackMap] uses, so the glyph on the map is matched by eye rather
 * than by memory. Nothing renders when the lap hit no limits — an empty legend
 * would imply the marks exist and are hiding somewhere.
 *
 * It says "on this lap" for a reason: the stored trace is the **best lap only**,
 * so these marks are that lap's and not the session's.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun LimitLegend(markers: List<Limits.Marker>, modifier: Modifier = Modifier) {
    val kinds = Limits.LIMIT_KINDS.filter { kind -> markers.any { it.kind == kind.key } }
    if (kinds.isEmpty()) return
    val colors = TrackTheme.colors

    // Wraps rather than scrolls: five kinds of two words each will not fit one
    // phone line, and a legend you have to scroll is not a legend.
    FlowRow(
        modifier
            .fillMaxWidth()
            .clearAndSetSemantics {
                contentDescription = "At the limit on this lap: " + kinds.joinToString(", ") { it.label }
            },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("At the limit on this lap:", style = TrackTheme.typography.xxs, color = colors.textFaint)
        kinds.forEach { kind ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                LimitGlyph(kind)
                Text(kind.label, style = TrackTheme.typography.xxs, color = colors.textMuted)
            }
        }
    }
}

/** One kind's marker at legend size: the same shape and fill rule the map draws. */
@Composable
private fun LimitGlyph(kind: Limits.Kind) {
    val colors = TrackTheme.colors
    Canvas(Modifier.size(11.dp)) {
        val color = limitColor(kind.side, colors)
        val fill = if (kind.filled) color else colors.surfaceCard
        val r = size.minDimension / 2f - 1f
        val centre = Offset(size.width / 2f, size.height / 2f)
        when (kind.shape) {
            Limits.Shape.CIRCLE -> {
                drawCircle(fill, radius = r, center = centre)
                drawCircle(color, radius = r, center = centre, style = Stroke(width = 1.6f * density))
            }
            Limits.Shape.TRIANGLE, Limits.Shape.DIAMOND -> {
                val path = Path()
                if (kind.shape == Limits.Shape.TRIANGLE) {
                    path.moveTo(centre.x, centre.y - r)
                    path.lineTo(centre.x + r, centre.y + r)
                    path.lineTo(centre.x - r, centre.y + r)
                } else {
                    path.moveTo(centre.x, centre.y - r)
                    path.lineTo(centre.x + r, centre.y)
                    path.lineTo(centre.x, centre.y + r)
                    path.lineTo(centre.x - r, centre.y)
                }
                path.close()
                drawPath(path, color = fill)
                drawPath(path, color = color, style = Stroke(width = 1.6f * density))
            }
        }
    }
}
