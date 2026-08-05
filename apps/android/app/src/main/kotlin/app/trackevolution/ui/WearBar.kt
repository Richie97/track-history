package app.trackevolution.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.trackevolution.core.Garage
import app.trackevolution.core.model.WearEstimate
import app.trackevolution.ui.theme.TrackTheme
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * How much of a part is used up (NS-31) — `wearBarHtml` in `public/app.js`.
 *
 * Drawn on a `Canvas` rather than a recoloured `LinearProgressIndicator`: the
 * design system is a hairline plus one surface step with no elevation, and
 * Material's indicator brings its own track colour, its own corner treatment and
 * an indeterminate animation none of which are wanted here.
 *
 * **A part with no estimate draws nothing at all.** An empty bar reads as "new",
 * which is the opposite of "we have no idea" — the caller says so in words
 * instead.
 *
 * The floor of 2% is deliberate: a part one hour into a 40-hour life would
 * otherwise render as an invisible sliver, and a bar that looks empty is
 * indistinguishable from a bar that isn't there.
 */
@Composable
fun TEWearBar(wear: WearEstimate?, modifier: Modifier = Modifier) {
    val pctUsed = wear?.pctUsed ?: return
    val colors = TrackTheme.colors
    val pct = (min(1.0, pctUsed) * 100).roundToInt()
    val fill = when (Garage.partStatus(wear)) {
        Garage.PartStatus.DUE -> colors.danger
        Garage.PartStatus.LOW -> colors.accentHover
        else -> colors.accent
    }
    val track = colors.bgSubtle

    Canvas(
        modifier = modifier
            .fillMaxWidth()
            .height(8.dp)
            .semantics { contentDescription = "$pct% used" },
    ) {
        val radius = CornerRadius(size.height / 2)
        drawRoundRect(color = track, cornerRadius = radius)
        val width = max(size.height, size.width * max(0.02f, pct / 100f))
        drawRoundRect(
            color = fill,
            topLeft = Offset.Zero,
            size = Size(width, size.height),
            cornerRadius = radius,
        )
    }
}
