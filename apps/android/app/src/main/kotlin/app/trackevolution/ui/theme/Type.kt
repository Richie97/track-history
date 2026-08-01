package app.trackevolution.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.trackevolution.R

/**
 * The type scale from `public/style.css`, in Geist.
 *
 * The web loads Geist and Geist Mono from Google Fonts; a native app has to
 * carry them, so both are bundled as **variable** fonts (one `wght` axis each)
 * under `res/font/`. That is two files instead of seven, and every weight the
 * stylesheet asks for is exact rather than synthesized. They are SIL OFL 1.1 —
 * the license ships in `assets/licenses/geist-ofl.txt`.
 *
 * Sizes are in **sp**, so the system font-size setting scales them. The
 * stylesheet's `--tracking-*` values are in `em` and stay in `em` here, which
 * means tracking scales with the text instead of drifting at large sizes.
 */
private val GeistFamily = FontFamily(
    variableFont(R.font.geist_variable, FontWeight.Light, 300),
    variableFont(R.font.geist_variable, FontWeight.Normal, 400),
    variableFont(R.font.geist_variable, FontWeight.Medium, 500),
    variableFont(R.font.geist_variable, FontWeight.SemiBold, 600),
    variableFont(R.font.geist_variable, FontWeight.Bold, 700),
)

/** Only the two weights `style.css` imports — the rest would be dead bytes. */
private val GeistMonoFamily = FontFamily(
    variableFont(R.font.geist_mono_variable, FontWeight.Normal, 400),
    variableFont(R.font.geist_mono_variable, FontWeight.Medium, 500),
)

/**
 * One instance of a variable font, pinned to a weight on its `wght` axis.
 *
 * Without the variation setting the platform picks the axis default and then
 * fakes the other weights by smearing the glyphs, which is exactly the mushy
 * look bundling a real variable font is meant to avoid.
 */
@OptIn(ExperimentalTextApi::class) // FontVariation.Settings
private fun variableFont(resId: Int, weight: FontWeight, wght: Int) = Font(
    resId = resId,
    weight = weight,
    variationSettings = FontVariation.Settings(FontVariation.weight(wght)),
)

/** Tabular figures: a column of lap times has to align on the decimal point. */
private const val TABULAR = "tnum"

// Tracking tokens: tight -0.02em · snug -0.01em · wide 0.08em

/**
 * The app's text styles. Named for the stylesheet's `--fs-*` tokens rather than
 * Material's roles, so a screen spec that says "h2" means the same thing on all
 * three clients.
 */
@Immutable
data class TrackTypography(
    /** `--fs-hero` 34sp — the big number on a stat tile. */
    val hero: TextStyle = TextStyle(
        fontFamily = GeistFamily,
        fontSize = 34.sp,
        fontWeight = FontWeight.Medium,
        letterSpacing = (-0.02).em,
    ),
    /** `--fs-h1` 26sp page title. */
    val h1: TextStyle = TextStyle(
        fontFamily = GeistFamily,
        fontSize = 26.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = (-0.02).em,
    ),
    /** `--fs-h2` 17sp section heading. */
    val h2: TextStyle = TextStyle(
        fontFamily = GeistFamily,
        fontSize = 17.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = (-0.01).em,
    ),
    /** `--fs-h3` 15sp card heading. */
    val h3: TextStyle = TextStyle(
        fontFamily = GeistFamily,
        fontSize = 15.sp,
        fontWeight = FontWeight.SemiBold,
    ),
    /** `--fs-body` 14.5sp. */
    val body: TextStyle = TextStyle(fontFamily = GeistFamily, fontSize = 14.5.sp),
    val bodyStrong: TextStyle = TextStyle(
        fontFamily = GeistFamily,
        fontSize = 14.5.sp,
        fontWeight = FontWeight.Medium,
    ),
    /** `--fs-sm` 13.5sp. */
    val sm: TextStyle = TextStyle(fontFamily = GeistFamily, fontSize = 13.5.sp),
    /** `--fs-xs` 12.5sp. */
    val xs: TextStyle = TextStyle(fontFamily = GeistFamily, fontSize = 12.5.sp),
    /** `--fs-2xs` 11sp. */
    val xxs: TextStyle = TextStyle(fontFamily = GeistFamily, fontSize = 11.sp),
    /**
     * The uppercase label above a stat — `--fs-2xs` with `--tracking-wide`.
     * Uppercasing is the caller's (`String.uppercase()`), not a text transform,
     * so screen readers get the original word.
     */
    val eyebrow: TextStyle = TextStyle(
        fontFamily = GeistFamily,
        fontSize = 11.sp,
        fontWeight = FontWeight.Medium,
        letterSpacing = 0.08.em,
    ),
    /** A lap time in a list: monospaced, tabular. Non-negotiable. */
    val lapTime: TextStyle = TextStyle(
        fontFamily = GeistMonoFamily,
        fontSize = 14.5.sp,
        fontWeight = FontWeight.Medium,
        fontFeatureSettings = TABULAR,
    ),
    /** The headline lap time on an event or session. */
    val lapTimeHero: TextStyle = TextStyle(
        fontFamily = GeistMonoFamily,
        fontSize = 34.sp,
        fontWeight = FontWeight.Medium,
        letterSpacing = (-0.02).em,
        fontFeatureSettings = TABULAR,
    ),
) {
    /** Every style, for the debug token gallery. */
    val all: List<Pair<String, TextStyle>>
        get() = listOf(
            "hero" to hero, "h1" to h1, "h2" to h2, "h3" to h3,
            "body" to body, "bodyStrong" to bodyStrong, "sm" to sm, "xs" to xs, "xxs" to xxs,
            "eyebrow" to eyebrow, "lapTime" to lapTime, "lapTimeHero" to lapTimeHero,
        )
}
