package app.trackevolution.ui.theme

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * A card, the way this design system draws one: **a hairline border and one
 * surface step, with no shadow at all.**
 *
 * Material's `Card` defaults to a 1dp shadow elevation plus a tonal overlay, and
 * both fight the flat look the web app has. Rather than remember to pass
 * `elevation = 0.dp` at every call site, screens use this.
 */
@Composable
fun TrackCard(
    modifier: Modifier = Modifier,
    color: Color? = null,
    border: Color? = null,
    shape: Shape? = null,
    contentPadding: Dp = 16.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = TrackTheme.colors
    val resolvedShape = shape ?: RoundedCornerShape(TrackTheme.radii.lg)
    Column(
        modifier = modifier
            .clip(resolvedShape)
            .background(color ?: colors.surfaceCard)
            .border(BorderStroke(1.dp, border ?: colors.borderHairline), resolvedShape)
            .padding(contentPadding),
        content = content,
    )
}
