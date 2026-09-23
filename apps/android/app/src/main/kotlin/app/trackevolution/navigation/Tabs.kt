package app.trackevolution.navigation

import androidx.compose.material3.Badge
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfoV2
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffoldDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.navigation.NavDestination
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import app.trackevolution.R
import app.trackevolution.core.Garage
import app.trackevolution.core.model.GarageVehicle
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The two tabs (NS-37), as navigation.
 *
 * Each tab is a **nested graph** of the one `NavHost` — `EventsGraph` under
 * `Route.Dashboard`, `GarageGraph` under `Route.Garage` — and switching is the
 * Navigation library's multiple-back-stacks idiom: pop to the root graph's
 * start with `saveState`, navigate to the other graph with `restoreState`. So
 * each tab keeps its own stack across a switch, and there is still exactly one
 * owner of "where am I" — the thing `FollowTempIds`, `showDeepLink` and the
 * minimize-at-root handler all read.
 */

/** Which tab a destination is in: the Garage graph's, or else the logbook's. */
public val NavDestination?.appTab: AppTab
    get() = if (this?.hierarchy?.any { it.hasRoute(GarageGraph::class) } == true) AppTab.Garage else AppTab.Events

/** Switch tab, keeping both tabs' stacks. */
public fun NavHostController.selectTab(tab: AppTab) {
    navigate(if (tab == AppTab.Garage) GarageGraph else EventsGraph) {
        popUpTo(graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}

/**
 * Arrive at a route: its tab first, then that tab reset to its root beneath the
 * target. A link is an arrival, not a step deeper into where you already were,
 * so back from it opens the tab's root rather than retracing a stack the user
 * never walked. Deep links and every cross-tab tap go through here.
 */
public fun NavHostController.show(route: Route) {
    val tab = route.tab
    if (currentDestination.appTab != tab) selectTab(tab)
    popBackStack(tab.root, inclusive = false)
    if (route != tab.root) navigate(route)
}

/**
 * Navigate from a screen: an ordinary push within the tab, or an arrival
 * ([show]) when the route lives in the other one — a car page's "last out at"
 * link, or the dashboard's due-part line.
 */
public fun NavHostController.go(route: Route) {
    if (route.tab == currentDestination.appTab) navigate(route) else show(route)
}

/**
 * The Garage tab's badge: the maintenance reminders — due or low — across every
 * car, `Garage.garageAlerts`, which is the web's top-bar count by the same rule.
 *
 * Process-wide because several screens read `/garage` and any of them can
 * report what it saw ([note]); the shell refreshes it itself at most once a
 * minute ([isStale]) so the count is right on screens that never read it. It is
 * a number for everybody and *shown* only for Pro — the gate is at the badge,
 * not here.
 */
public object GarageBadge {
    private const val TTL_MS = 60_000L

    private val _count = MutableStateFlow(0)
    public val count: StateFlow<Int> = _count.asStateFlow()

    @Volatile private var notedAt = 0L

    public fun note(garage: List<GarageVehicle>) {
        _count.value = Garage.garageAlerts(garage).size
        notedAt = System.currentTimeMillis()
    }

    public fun isStale(now: Long = System.currentTimeMillis()): Boolean = now - notedAt > TTL_MS

    /** Sign-out, or a lapse: the next account must not inherit this one's count. */
    public fun clear() {
        _count.value = 0
        notedAt = 0L
    }
}

/** "2 maintenance reminders" — what the badge says out loud. */
internal fun badgeLabel(count: Int): String =
    "$count maintenance reminder${if (count == 1) "" else "s"}"

/**
 * The navigation suite around the signed-in content: a bottom bar at compact
 * width and a rail wider, chosen by Material from the window's adaptive info. A
 * phone in landscape is an expanded window on this platform (NS-34) and gets
 * the rail; that is the library's call and costs nothing.
 *
 * [showNavigation] false draws no bar at all — the recorder, the importer and
 * Wrapped own the window at every width, and a tab bar under a phone-in-a-mount
 * layout is a second way out of a recording.
 */
@Composable
fun AppNavigationSuite(
    selected: AppTab,
    onSelect: (AppTab) -> Unit,
    /** Reminders to count on the Garage item; 0 hides the badge. */
    garageBadge: Int,
    showNavigation: Boolean,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val colors = TrackTheme.colors
    val layoutType = if (showNavigation) {
        NavigationSuiteScaffoldDefaults.calculateFromAdaptiveInfo(currentWindowAdaptiveInfoV2())
    } else {
        NavigationSuiteType.None
    }
    val barItem = NavigationBarItemDefaults.colors(
        selectedIconColor = colors.textStrong,
        selectedTextColor = colors.textStrong,
        indicatorColor = colors.accentTint,
        unselectedIconColor = colors.textMuted,
        unselectedTextColor = colors.textMuted,
    )
    val railItem = NavigationRailItemDefaults.colors(
        selectedIconColor = colors.textStrong,
        selectedTextColor = colors.textStrong,
        indicatorColor = colors.accentTint,
        unselectedIconColor = colors.textMuted,
        unselectedTextColor = colors.textMuted,
    )
    val itemColors = NavigationSuiteDefaults.itemColors(
        navigationBarItemColors = barItem,
        navigationRailItemColors = railItem,
    )
    NavigationSuiteScaffold(
        modifier = modifier,
        layoutType = layoutType,
        containerColor = colors.bgPage,
        navigationSuiteColors = NavigationSuiteDefaults.colors(
            navigationBarContainerColor = colors.surfaceCard,
            navigationBarContentColor = colors.textMuted,
            navigationRailContainerColor = colors.surfaceCard,
            navigationRailContentColor = colors.textMuted,
        ),
        navigationSuiteItems = {
            item(
                selected = selected == AppTab.Events,
                onClick = { onSelect(AppTab.Events) },
                icon = { Icon(painterResource(R.drawable.ic_tab_events), contentDescription = null) },
                label = { Text("Events", style = TrackTheme.typography.xs) },
                colors = itemColors,
                modifier = Modifier.semantics { testTag = "tabEvents" },
            )
            item(
                selected = selected == AppTab.Garage,
                onClick = { onSelect(AppTab.Garage) },
                icon = { Icon(painterResource(R.drawable.ic_tab_garage), contentDescription = null) },
                label = { Text("Garage", style = TrackTheme.typography.xs) },
                colors = itemColors,
                badge = if (garageBadge > 0) {
                    {
                        Badge(
                            containerColor = colors.dangerTint,
                            contentColor = colors.dangerInk,
                        ) { Text("$garageBadge") }
                    }
                } else {
                    null
                },
                // The count is said on the *item*: Material clears the icon's
                // semantics — the badge's with it — whenever a label is shown,
                // so a description on the badge itself is read by nobody.
                modifier = Modifier.semantics {
                    testTag = "tabGarage"
                    if (garageBadge > 0) stateDescription = badgeLabel(garageBadge)
                },
            )
        },
    ) {
        content()
    }
}
