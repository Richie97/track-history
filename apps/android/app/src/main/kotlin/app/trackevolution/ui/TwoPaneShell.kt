package app.trackevolution.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.layout.AnimatedPane
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffold
import androidx.compose.material3.adaptive.layout.PaneAdaptedValue
import androidx.compose.material3.adaptive.layout.PaneScaffoldDirective
import androidx.compose.material3.adaptive.layout.ThreePaneScaffoldValue
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * List beside detail at expanded width, detail alone below it (spec: NS-34).
 *
 * Material's [ListDetailPaneScaffold], used as a **layout** and nothing more: the
 * pane values are fixed by [twoPane] rather than computed, and the scaffold's own
 * navigator (`adaptive-navigation`, `rememberListDetailPaneScaffoldNavigator`) is
 * deliberately not adopted.
 *
 * That is not laziness, it is the spec's own constraint. NS-34 says `Route` and
 * `DeepLink` do not change and that the `NavHost` from NS-26 keeps the graph — so
 * navigation has exactly one owner, and a second navigator with its own back
 * stack and its own `BackHandler` would be a second answer to "where am I" that
 * `FollowTempIds`, `showDeepLink` and NS-18's minimize-at-root handler would all
 * have to be taught about. What the scaffold is still worth having for is the
 * thing it is actually good at: pane widths and spacing that match the platform,
 * and a seam ticket 3 can hang a third pane on.
 *
 * Below expanded width this composes the detail alone, with no scaffold and no
 * wrapper of any kind, so the phone layout is untouched.
 */
@OptIn(ExperimentalMaterial3AdaptiveApi::class)
@Composable
fun TwoPaneShell(
    twoPane: Boolean,
    listPane: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    detailPane: @Composable () -> Unit,
) {
    if (!twoPane) {
        Box(modifier.fillMaxSize()) { detailPane() }
        return
    }
    @Suppress("NAME_SHADOWING") val listPane = @Composable { InPane(listPane) }
    @Suppress("NAME_SHADOWING") val detailPane = @Composable { InPane(detailPane) }
    ListDetailPaneScaffold(
        // The window is already known to be expanded — that decision is
        // `LayoutClass`'s and is made once, at the root — so the directive only
        // has to say "two panes, standard gutter" rather than measure again and
        // risk disagreeing with the class the rest of the app is laid out by.
        directive = PaneScaffoldDirective.Default,
        value = ThreePaneScaffoldValue(
            primary = PaneAdaptedValue.Expanded,
            secondary = PaneAdaptedValue.Expanded,
            tertiary = PaneAdaptedValue.Hidden,
        ),
        listPane = { AnimatedPane { listPane() } },
        detailPane = { AnimatedPane { detailPane() } },
        modifier = modifier.fillMaxSize(),
    )
}

/**
 * Republish the layout metrics for a pane, measured.
 *
 * The **class stays the window's**, which is the spec's rule and the right one: a
 * pane must not decide it is a phone and start hiding things. What has to change
 * is the *content width*, because everything that counts columns counts them
 * against the column it is actually in. Without this a 400dp list pane inherits
 * the window's content width and lays its track cards out three across, at about
 * 110dp each — which is how a list pane ends up far too narrow for what is in it.
 *
 * `BoxWithConstraints` rather than an assumed width: the scaffold decides how it
 * splits the window, and that is not a number this file should be guessing.
 */
@Composable
private fun InPane(content: @Composable () -> Unit) {
    val metrics = LocalLayoutMetrics.current
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val width = (maxWidth - pageGutter(metrics.layoutClass) * 2).coerceAtLeast(0.dp)
        CompositionLocalProvider(
            LocalLayoutMetrics provides metrics.copy(contentWidth = width),
        ) {
            content()
        }
    }
}
