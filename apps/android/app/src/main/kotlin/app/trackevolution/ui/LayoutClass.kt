package app.trackevolution.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.trackevolution.ui.theme.LayoutTokens

/**
 * How much width the app has to lay out in (spec: NS-34).
 *
 * The unit of decision is the **window**, never the device or the form factor: a
 * tablet, a Fold opened flat, a phone in landscape and a Chromebook window all
 * land in the same three rules, and none of them is asked what kind of hardware
 * it is. The names and breakpoints are Material's window size classes — which is
 * also what the iOS port uses, in `App/DesignSystem/LayoutClass.swift`, so the
 * two clients cannot classify the same window differently.
 *
 * Deliberately **not** in `:core`. Every value here is a fact about a window
 * rather than about the domain, and `:core` may not depend on Android at all
 * (`checkNoAndroidDependency`); the two platforms pin the breakpoints with a
 * test each instead of sharing an implementation.
 *
 * **One divergence from iOS, deliberate and open.** iOS classifies an iPhone in
 * landscape as compact whatever its width, because UIKit hands it a `.compact`
 * horizontal size class — the OS saying "this is a one-column device". Android
 * has no equivalent signal, so a phone in landscape is classified by its width
 * and a 915dp-wide Pixel lands in [Expanded], the same class a small tablet
 * gets. That costs nothing while medium and expanded are the same layout, which
 * is the case for the whole of ticket 1. The two-pane shell (#216) is where it
 * becomes a decision: two panes on a 915 × 412dp window is a worse phone, so
 * that ticket has to either guard on height or read `smallestScreenWidthDp`,
 * which is the stable "is this a phone" signal on this platform.
 */
enum class LayoutClass {
    /**
     * Under 600dp. Today's phone layout, unchanged — this spec adds classes above
     * it and touches nothing in it.
     */
    Compact,

    /**
     * 600–839dp. The phone layout with its column capped and centred and its
     * grids filling by width. Half of a folded-open Fold lives here.
     */
    Medium,

    /** 840dp and up. Two-pane list-detail, and analysis beside the track map. */
    Expanded;

    /** Whether the phone layout applies as-is. */
    val isCompact: Boolean get() = this == Compact

    companion object {
        /**
         * The Material breakpoint between a phone layout and a capped one.
         *
         * Duplicated in `LayoutClass.MEDIUM_MIN_DP` on iOS, and pinned there by
         * `LayoutClassTests` as it is here by [app.trackevolution.ui.LayoutClassTest]
         * — a PR that changes one number and not the other fails the other
         * platform's test.
         */
        const val MEDIUM_MIN_DP: Int = 600

        /** The Material breakpoint at which a second pane earns its place. */
        const val EXPANDED_MIN_DP: Int = 840

        /** The class for a window of this width. The pure rule iOS mirrors. */
        fun ofWidth(widthDp: Int): LayoutClass = when {
            widthDp >= EXPANDED_MIN_DP -> Expanded
            widthDp >= MEDIUM_MIN_DP -> Medium
            else -> Compact
        }
    }
}

/**
 * The window's layout class and the width of the column content is being laid
 * out in.
 *
 * Two values rather than one because they answer different questions and change
 * at different times: the class is a fact about the *window* (and stays that, so
 * a narrow detail pane never redraws itself as a phone), while the content width
 * is a fact about the column the caller is inside — [PageColumn] narrows it when
 * it caps the page, and a pane will narrow it again.
 */
@Immutable
data class LayoutMetrics(
    val layoutClass: LayoutClass,
    /** The usable width of the current column, gutters already deducted. */
    val contentWidth: Dp,
) {
    /**
     * How many columns of at least [minimum] fit, with [gap] between them — the
     * native reading of the web's `repeat(auto-fill, minmax(<minimum>, 1fr))`.
     *
     * Never fewer than one: a column narrower than the minimum gets one item per
     * row and lets it be as narrow as it must be, exactly as CSS does.
     */
    fun columns(minimum: Dp, gap: Dp = 12.dp): Int {
        if (contentWidth <= 0.dp || minimum <= 0.dp) return 1
        return maxOf(1, ((contentWidth + gap) / (minimum + gap)).toInt())
    }

    /** The same metrics for a narrower column. */
    fun narrowedTo(width: Dp): LayoutMetrics = copy(contentWidth = minOf(contentWidth, width))

    /**
     * How wide a second column beside the page should be, or null for one column.
     *
     * The two pages that split — the event's analysis, the vehicle's selected
     * part — share this rule rather than each carrying its own pair of numbers,
     * and it is the same rule and the same numbers as iOS's
     * `LayoutMetrics.sideColumnWidth`.
     *
     * It reads [contentWidth], **never [layoutClass]**, and that is the point.
     * The class is a fact about the *window* and stays one, so a pane never
     * decides it is a phone — but "is there room here for two columns" is a
     * question about the container this page is in, and on a tablet in portrait
     * those two answers disagree: an expanded window, and a detail pane with
     * ~627dp of usable width. Splitting that gave the page column 300dp with a
     * chart column beside it, where iOS ran the same arithmetic and put its
     * column off the side of the screen.
     *
     * `null` below [LayoutClass.EXPANDED_MIN_DP] is the window's own threshold
     * applied one level down: a column too narrow to be a two-pane window is too
     * narrow to hold two columns of its own.
     */
    fun sideColumnWidth(fraction: Float, minimum: Dp, maximum: Dp): Dp? {
        if (contentWidth < LayoutClass.EXPANDED_MIN_DP.dp) return null
        return (contentWidth * fraction).coerceIn(minimum, maximum)
    }
}

/**
 * The window's layout metrics, published once by [ProvideLayoutMetrics].
 *
 * `static` because it changes rarely — a fold, a rotation, a resize — and every
 * screen reads it: an ordinary `compositionLocalOf` would track readers for a
 * value that is better off invalidating the whole subtree on the few occasions
 * it moves.
 */
val LocalLayoutMetrics = staticCompositionLocalOf {
    // A phone, until the window is measured. Nothing renders before it is, and
    // defaulting the other way would flash a two-pane layout.
    LayoutMetrics(LayoutClass.Compact, 0.dp)
}

/**
 * Measure the window and publish its layout class to everything below.
 *
 * The width comes from `Configuration.screenWidthDp`, which is a **deviation
 * from NS-34's letter** — the spec says `WindowSizeClass` from `androidx.window`'s
 * window metrics — taken for two reasons, and recorded here rather than in a
 * commit message the way NS-15 and NS-16 recorded theirs.
 *
 * The first is accuracy, and it runs the opposite way to the usual advice.
 * Window metrics report the window's whole bounds, decorations included; the
 * configuration reports it with the system decorations removed. Material
 * recommends the former because most apps let the system inset them. This app
 * does not: it draws edge to edge and insets its own content with
 * `systemBarsPadding()` in [app.trackevolution.SignedInScaffold], so the width a
 * layout actually receives is the decoration-free one — which is the number the
 * configuration already carries. Reading the raw bounds would classify a window
 * by space the content never gets.
 *
 * The second is that it is live, testable and free: `Configuration` recomposes on
 * every resize (a fold, Stage-Manager-style multi-window, rotation), it is what
 * Robolectric's `w840dp` qualifiers set, and it works in a `@Preview` — where an
 * `Activity`-based `WindowSizeClass` reads the *host* window and previews at
 * 400/700/1000dp would all report the same class.
 *
 * The breakpoints themselves are unchanged, so this classifies windows exactly
 * as `WindowSizeClass` would.
 */
@Composable
fun ProvideLayoutMetrics(content: @Composable () -> Unit) {
    val widthDp = LocalConfiguration.current.screenWidthDp
    val layoutClass = LayoutClass.ofWidth(widthDp)
    val metrics = LayoutMetrics(
        layoutClass = layoutClass,
        contentWidth = (widthDp.dp - pageGutter(layoutClass) * 2).coerceAtLeast(0.dp),
    )
    CompositionLocalProvider(LocalLayoutMetrics provides metrics) {
        content()
    }
}

/**
 * The page padding for a layout class.
 *
 * A phone keeps the 16dp the logbook screens have always used — 28dp of margin
 * on each side of a 412dp screen is most of a column. Once there is width to
 * spare the app uses the web's own `--page-gutter`, which is what makes a capped
 * page on a tablet sit the way the same page does in a browser beside it.
 *
 * The screens themselves still apply [PHONE_PAGE_GUTTER], as they have since
 * NS-26; [PageColumn] adds the difference above compact width, so no screen
 * needed editing and none of them can be left behind.
 */
fun pageGutter(layoutClass: LayoutClass): Dp =
    if (layoutClass.isCompact) PHONE_PAGE_GUTTER else LayoutTokens.PAGE_GUTTER

/** The gutter every logbook screen has used since NS-26. */
val PHONE_PAGE_GUTTER: Dp = 16.dp

/**
 * How narrow a card in an auto-filling grid may get — the web's
 * `.cards { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)) }`.
 *
 * A phone is narrower than this, so those grids are one column there and the
 * compact layout is unchanged by construction rather than by a branch.
 */
val CARD_GRID_MINIMUM: Dp = 280.dp

/**
 * Cards laid out across as many columns as the width allows — the web's
 * `repeat(auto-fill, minmax(280px, 1fr))` — inside a `LazyColumn`.
 *
 * The rows stay lazy, which the phone list already relied on: this chunks the
 * list into rows of [columns] and emits one item per row, rather than one per
 * card. At one column — which is where every phone lands, since a phone is
 * narrower than [CARD_GRID_MINIMUM] — a row holds exactly one full-width card
 * and the emitted list is item-for-item what it was.
 *
 * Rows are keyed by their first card, so at one column the keys are unchanged
 * too and a scroll position survives.
 */
fun <T> LazyListScope.cardGridItems(
    items: List<T>,
    columns: Int,
    key: (T) -> Any,
    gap: Dp = 12.dp,
    itemContent: @Composable (T) -> Unit,
) {
    val rows = items.chunked(maxOf(1, columns))
    items(rows, key = { row -> key(row.first()) }) { row ->
        Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
            row.forEach { item ->
                Box(Modifier.weight(1f)) { itemContent(item) }
            }
            // Keeps a short last row's cards the width of the ones above rather
            // than stretching two cards across four columns.
            repeat(maxOf(1, columns) - row.size) { Spacer(Modifier.weight(1f)) }
        }
    }
}

/**
 * The logbook's content column: capped at `--page-max` and centred above phone
 * width, the way the web app's `.shell` is.
 *
 * Below the cap `widthIn(max = …)` is a no-op, so a phone renders exactly as it
 * did. The narrowed metrics are republished so a grid inside counts its columns
 * against the column it is actually in rather than against the window.
 */
@Composable
fun PageColumn(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val metrics = LocalLayoutMetrics.current
    // The screens pad themselves by PHONE_PAGE_GUTTER, so only the difference is
    // added here. At compact width that difference is zero and this whole
    // wrapper is inert, which is what makes the phone layout unchanged by
    // construction rather than by a branch in ten screens.
    val extraGutter = pageGutter(metrics.layoutClass) - PHONE_PAGE_GUTTER
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Box(
            Modifier
                .fillMaxSize()
                .widthIn(max = LayoutTokens.PAGE_MAX)
                .padding(horizontal = extraGutter),
        ) {
            CompositionLocalProvider(
                LocalLayoutMetrics provides metrics.narrowedTo(
                    LayoutTokens.PAGE_MAX - pageGutter(metrics.layoutClass) * 2,
                ),
            ) {
                content()
            }
        }
    }
}
