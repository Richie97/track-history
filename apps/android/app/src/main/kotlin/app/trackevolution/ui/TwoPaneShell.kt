package app.trackevolution.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.layout.AnimatedPane
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffold
import androidx.compose.material3.adaptive.layout.PaneAdaptedValue
import androidx.compose.material3.adaptive.layout.PaneScaffoldDirective
import androidx.compose.material3.adaptive.layout.ThreePaneScaffoldValue
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

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
