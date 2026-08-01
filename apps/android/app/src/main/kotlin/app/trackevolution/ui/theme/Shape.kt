package app.trackevolution.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.tween
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.runtime.Immutable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The `--radius-*` tokens from `public/style.css`.
 *
 * In `dp`, not `sp`: corners are a physical dimension and must not grow with the
 * user's font-size setting.
 */
@Immutable
data class TrackRadii(
    val xs: Dp = 7.dp,
    val sm: Dp = 9.dp,
    val md: Dp = 11.dp,
    val lg: Dp = 14.dp,
    val xl: Dp = 20.dp,
    /** `--radius-pill` 999px — anything past half the height is a pill. */
    val pill: Dp = 999.dp,
) {
    /** Every radius, for the debug token gallery. */
    val all: List<Pair<String, Dp>>
        get() = listOf("xs" to xs, "sm" to sm, "md" to md, "lg" to lg, "xl" to xl, "pill" to pill)
}

/**
 * Motion. `--ease-standard` is `cubic-bezier(0.22, 1, 0.36, 1)` and
 * `--dur-fast` / `--dur-med` are 130ms / 220ms.
 *
 * Use these rather than ad-hoc `tween(...)` calls: one easing across the app is
 * most of what makes hand-rolled motion feel deliberate instead of assorted.
 */
object TrackMotion {
    val standard: Easing = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)

    /** `--dur-fast`: hovers, presses, small state flips. */
    const val FAST_MS: Int = 130

    /** `--dur-med`: expansion, screen-level transitions. */
    const val MEDIUM_MS: Int = 220

    fun <T> fast(): FiniteAnimationSpec<T> = tween(FAST_MS, easing = standard)

    fun <T> medium(): FiniteAnimationSpec<T> = tween(MEDIUM_MS, easing = standard)
}

/**
 * The Material `Shapes` that Material components pick up, mapped onto the same
 * radii so a `Button` or `AlertDialog` we don't wrap still has the right
 * corners.
 */
internal fun materialShapes(radii: TrackRadii) = Shapes(
    extraSmall = RoundedCornerShape(radii.xs),
    small = RoundedCornerShape(radii.sm),
    medium = RoundedCornerShape(radii.md),
    large = RoundedCornerShape(radii.lg),
    extraLarge = RoundedCornerShape(radii.xl),
)
