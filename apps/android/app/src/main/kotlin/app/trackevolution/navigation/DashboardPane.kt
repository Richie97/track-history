package app.trackevolution.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import app.trackevolution.core.api.ApiClient
import app.trackevolution.screens.DashboardModel
import app.trackevolution.screens.DashboardScreen

/**
 * The dashboard, wherever it is being shown (spec: NS-34 ticket 2).
 *
 * It has two homes and the same behaviour in both, which is the whole reason this
 * exists rather than two call sites drifting apart: below expanded width it is the
 * nav graph's start destination, and at expanded width it is the **list pane**
 * beside the detail. One function, one set of callbacks, one place to change what
 * tapping a track does.
 *
 * [inListPane] is the only difference, and it changes two things:
 *
 *  - **Navigation replaces the detail rather than deepening it.** Picking a second
 *    track from a list that is still on screen means "show me this one", never
 *    "push this on top of the last one" — see [showFromList].
 *  - **The selected row is marked.** Only worth doing beside a visible detail: at
 *    compact width the detail *is* the screen you just left, and highlighting a
 *    row you can no longer see would be describing something off-screen.
 */
@Composable
fun DashboardPane(
    nav: NavHostController,
    api: ApiClient,
    recorderIdle: Boolean,
    selection: Route?,
    inListPane: Boolean,
) {
    // Keyed, because the reified type this resolves by erases to
    // `ScreenModelHolder` — two models in one store owner would otherwise be one
    // model. In the list pane the owner is the activity rather than a back stack
    // entry, since the pane outlives every destination beside it.
    val model = rememberScreenModel(key = if (inListPane) "listPaneDashboard" else null) {
            scope, _ ->
        DashboardModel(scope, api)
    }
    DashboardScreen(
        model = model,
        onOpenEvent = { nav.open(Route.Event(it), inListPane) },
        onOpenTrack = { nav.open(Route.Track(it), inListPane) },
        onOpenVehicle = { nav.open(Route.Vehicle(it), inListPane) },
        onNewEvent = { nav.open(Route.EventForm(), inListPane) },
        onOpenSettings = { nav.open(Route.Settings, inListPane) },
        // Never replaced or paned: the record screen owns the window at every
        // width, and `SignedInScaffold` drops to one pane for that destination.
        onRecord = { nav.navigate(Route.Record(eventId = it)) },
        recorderIdle = recorderIdle,
        selection = if (inListPane) selection else null,
    )
}

/**
 * Navigate from the dashboard.
 *
 * From the list pane this replaces the detail — `popUpTo(Dashboard)` first, so the
 * detail is always exactly one destination deep and back from it lands on the
 * empty state rather than on the previous selection. From the start destination it
 * is an ordinary navigate, and the `popUpTo` is a no-op there because the
 * dashboard is already the only thing on the stack. One call, both widths.
 */
private fun NavHostController.open(route: Route, fromListPane: Boolean) {
    if (fromListPane) {
        navigate(route) { popUpTo(Route.Dashboard) { inclusive = false } }
    } else {
        navigate(route)
    }
}

/**
 * Which list row the detail is currently showing, or null for none.
 *
 * Only the three routes the dashboard actually lists can be selected; a form, the
 * settings screen or the recorder is a destination the list has no row for, and
 * marking nothing is the honest answer there.
 */
fun NavBackStackEntry.selectionRoute(): Route? = when {
    destination.hasRoute(Route.Event::class) -> toRoute<Route.Event>()
    destination.hasRoute(Route.Track::class) -> toRoute<Route.Track>()
    destination.hasRoute(Route.Vehicle::class) -> toRoute<Route.Vehicle>()
    else -> null
}
