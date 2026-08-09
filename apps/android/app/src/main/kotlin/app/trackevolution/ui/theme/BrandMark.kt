package app.trackevolution.ui.theme

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.cos
import kotlin.math.sin

/**
 * The app mark: the Speedshift double-bar on a lime disc.
 *
 * The port of `appLogoHtml`/`ssBars` in `public/app.js`, by way of the iOS
 * `BrandMark` — same viewBox, same two rectangles, same rule that the bars are
 * drawn in `accentContrast` because dark ink is what sits on the lime fill.
 * `.app-logo` is 26px in the web header and 56px (`.lg`) on the login card;
 * callers pass the matching [size].
 *
 * Drawn on a Canvas rather than shipped as an image so it scales to any size
 * and follows the color tokens in both themes; there is no logo asset in the
 * resources to drift from. Purely decorative — the name is always written out
 * beside it — so it carries no semantics.
 */
@Composable
fun BrandMark(size: Dp = 56.dp, modifier: Modifier = Modifier) {
    val colors = TrackTheme.colors
    Canvas(modifier = modifier.size(size)) {
        val d = this.size.minDimension
        drawCircle(color = colors.accent, radius = d / 2f)

        // `.app-logo svg { height: 54% }` — the mark sits inside the disc
        // rather than spanning it. The viewBox aspect-fits that box, as an
        // <svg> does by default.
        val innerH = d * 0.54f
        val scale = innerH / VIEWBOX_H
        val originX = (d - VIEWBOX_W * scale) / 2f
        val originY = (d - VIEWBOX_H * scale) / 2f

        val path = Path()
        for (bar in BARS) {
            val radians = bar.degrees * (Math.PI.toFloat() / 180f)
            // SVG's `rotate(a cx cy)` turns the rect about (cx, cy) — which
            // here is the rect's own origin, so the corners rotate around it.
            val corners = listOf(
                0f to 0f,
                bar.width to 0f,
                bar.width to bar.height,
                0f to bar.height,
            ).map { (x, y) ->
                Pair(
                    originX + (x * cos(radians) - y * sin(radians) + bar.x) * scale,
                    originY + (x * sin(radians) + y * cos(radians) + bar.y) * scale,
                )
            }
            path.moveTo(corners[0].first, corners[0].second)
            for (corner in corners.drop(1)) path.lineTo(corner.first, corner.second)
            path.close()
        }
        drawPath(path, color = colors.accentContrast)
    }
}

/**
 * The two slashes of the Speedshift mark, straight from the SVG in
 * `public/app.js`: a rect apiece, each rotated about its own origin, laid out
 * in a 429×629 viewBox they fill exactly.
 */
private const val VIEWBOX_W = 429f
private const val VIEWBOX_H = 629f

private data class Bar(val x: Float, val y: Float, val width: Float, val height: Float, val degrees: Float)

private val BARS = listOf(
    Bar(0.589722f, 115.848f, 163f, 442.765f, -44.9265f),
    Bar(311.969f, 198.246f, 163f, 442.765f, 44.5184f),
)

@Preview
@Composable
private fun BrandMarkPreview() {
    TrackTheme(ThemeChoice.Dark) {
        androidx.compose.foundation.layout.Column {
            BrandMark()
            BrandMark(size = 26.dp)
        }
    }
}
