package app.trackevolution.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * The Track Evolution design system, as a Compose theme.
 *
 * A custom token layer sits *beside* Material rather than inside it: the palette
 * is semantic (`surfaceCard`, `textMuted`, `accentInk`, `chartLineB`, `mapSlow`)
 * and does not map onto Material's primary/secondary/tertiary roles. Screens
 * read `TrackTheme.colors`; the derived [ColorScheme] exists only so the
 * Material components we do use are not the wrong color.
 *
 * **Dynamic color (Material You) is deliberately absent.** The lime accent is
 * brand identity and, more concretely, the "faster / improvement" signal the
 * charts depend on — letting the wallpaper recolor it would make a chart lie.
 */
@Composable
fun TrackTheme(
    choice: ThemeChoice = ThemeChoice.System,
    content: @Composable () -> Unit,
) {
    val dark = when (choice) {
        ThemeChoice.System -> isSystemInDarkTheme()
        ThemeChoice.Light -> false
        ThemeChoice.Dark -> true
    }
    val colors = if (dark) DarkTrackColors else LightTrackColors
    val typography = TrackTypography()
    val radii = TrackRadii()

    CompositionLocalProvider(
        LocalTrackColors provides colors,
        LocalTrackTypography provides typography,
        LocalTrackRadii provides radii,
        LocalIsDarkTheme provides dark,
    ) {
        MaterialTheme(
            colorScheme = materialColorScheme(colors, dark),
            shapes = materialShapes(radii),
        ) {
            // Material's default body style is Roboto; without this, any Text
            // that doesn't name a style silently falls off the type scale.
            CompositionLocalProvider(LocalTextStyle provides typography.body, content = content)
        }
    }
}

/** Token accessors. `TrackTheme.colors.accentInk`, and so on. */
object TrackTheme {
    val colors: TrackColors
        @Composable @ReadOnlyComposable get() = LocalTrackColors.current

    val typography: TrackTypography
        @Composable @ReadOnlyComposable get() = LocalTrackTypography.current

    val radii: TrackRadii
        @Composable @ReadOnlyComposable get() = LocalTrackRadii.current

    /** For the handful of places that legitimately branch on theme (map ramps). */
    val isDark: Boolean
        @Composable @ReadOnlyComposable get() = LocalIsDarkTheme.current
}

val LocalTrackColors = staticCompositionLocalOf { DarkTrackColors }
val LocalTrackTypography = staticCompositionLocalOf { TrackTypography() }
val LocalTrackRadii = staticCompositionLocalOf { TrackRadii() }
val LocalIsDarkTheme = staticCompositionLocalOf { true }

/**
 * The Material roles, filled from our tokens.
 *
 * `surfaceTint` is transparent on purpose. Material 3 tints elevated surfaces
 * with it, which is how a Card ends up a slightly different color than the one
 * we gave it. Depth in this design system is a **hairline border plus one
 * surface step**, never a tonal wash or a stacked shadow.
 */
private fun materialColorScheme(c: TrackColors, dark: Boolean): ColorScheme {
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = c.accent,
        onPrimary = c.accentContrast,
        primaryContainer = c.accentTint,
        onPrimaryContainer = c.accentInk,
        secondary = c.accentInk,
        onSecondary = c.accentContrast,
        secondaryContainer = c.accentTint,
        onSecondaryContainer = c.accentInk,
        tertiary = c.chartLineB,
        onTertiary = c.accentContrast,
        background = c.bgPage,
        onBackground = c.textBody,
        surface = c.surfaceCard,
        onSurface = c.textBody,
        surfaceVariant = c.surfaceRaised,
        onSurfaceVariant = c.textMuted,
        surfaceContainerLowest = c.bgPage,
        surfaceContainerLow = c.bgSubtle,
        surfaceContainer = c.surfaceCard,
        surfaceContainerHigh = c.surfaceRaised,
        surfaceContainerHighest = c.surfaceHover,
        surfaceTint = Color.Transparent,
        inverseSurface = c.textStrong,
        inverseOnSurface = c.bgPage,
        outline = c.borderStrong,
        outlineVariant = c.borderHairline,
        error = c.danger,
        onError = c.accentContrast,
        errorContainer = c.dangerTint,
        onErrorContainer = c.dangerInk,
        scrim = c.shadow,
    )
}
