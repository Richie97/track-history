package app.trackevolution.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.toRoute
import app.trackevolution.auth.ChecklistTemplateStore
import app.trackevolution.auth.CustomTabs
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.offline.OfflineStore
import app.trackevolution.recording.RecordScreen
import app.trackevolution.recording.RecorderState
import app.trackevolution.screens.DashboardModel
import app.trackevolution.screens.DashboardScreen
import app.trackevolution.screens.EventFormModel
import app.trackevolution.screens.EventFormScreen
import app.trackevolution.screens.EventModel
import app.trackevolution.screens.EventScreen
import app.trackevolution.screens.SettingsModel
import app.trackevolution.screens.SettingsScreen
import app.trackevolution.screens.SharedLogbookModel
import app.trackevolution.screens.SharedLogbookScreen
import app.trackevolution.screens.TrackModel
import app.trackevolution.screens.TrackScreen
import app.trackevolution.screens.VehicleModel
import app.trackevolution.screens.VehicleScreen
import app.trackevolution.ui.theme.ThemeChoice

/**
 * The logbook's navigation graph (NS-26).
 *
 * Navigation Compose with **type-safe routes**: a destination is a
 * `@Serializable` class from [Route], so a renamed argument breaks the build
 * rather than a tap. The Capacitor app approximated all of this with a
 * `backButton` listener and a hash router; none of that is ported.
 *
 * Every screen reads through [ApiClient], which **is** the offline layer
 * (NS-22) — no composable here talks to the network any other way, so there is
 * no second path with its own offline behaviour to get wrong.
 */
@Composable
fun AppNavHost(
    nav: NavHostController,
    api: ApiClient,
    /**
     * Only ever reaches [SettingsModel], so this is typed as the narrow
     * interface rather than `AuthController`: it lets the whole graph be
     * composed in a Robolectric test without standing up an encrypted token
     * store, which is what #108's dashboard → record test needs.
     */
    auth: ChecklistTemplateStore,
    checklistTemplate: List<String>,
    hasCustomChecklistTemplate: Boolean,
    themeChoice: ThemeChoice,
    onThemeChange: (ThemeChoice) -> Unit,
    serverUrl: String,
    recorderState: RecorderState,
    /** Idle means no live recording and none waiting to be saved (#108). */
    recorderIdle: Boolean,
    onStartRecording: (Int?) -> Unit,
    onStopRecording: () -> Unit,
    onSignOut: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val openLink: (String) -> Unit = { CustomTabs.open(context, it) }
    val share: (String) -> Unit = { shareLink(context, it) }

    FollowTempIds(nav, api)

    NavHost(navController = nav, startDestination = Route.Dashboard, modifier = modifier) {

        composable<Route.Dashboard> {
            val model = rememberScreenModel { scope, _ -> DashboardModel(scope, api) }
            DashboardScreen(
                model = model,
                onOpenEvent = { nav.navigate(Route.Event(it)) },
                onOpenTrack = { nav.navigate(Route.Track(it)) },
                onOpenVehicle = { nav.navigate(Route.Vehicle(it)) },
                onNewEvent = { nav.navigate(Route.EventForm()) },
                onOpenSettings = { nav.navigate(Route.Settings) },
                onRecord = { nav.navigate(Route.Record(eventId = it)) },
                recorderIdle = recorderIdle,
            )
        }

        composable<Route.Event> { entry ->
            val route = entry.toRoute<Route.Event>()
            val model = rememberScreenModel { scope, _ -> EventModel(scope, api, route.id) }
            EventScreen(
                model = model,
                checklistTemplate = checklistTemplate,
                onEdit = { nav.navigate(Route.EventForm(editId = it)) },
                onOpenTrack = { nav.navigate(Route.Track(it)) },
                onRecord = { nav.navigate(Route.Record(eventId = it)) },
                onDeleted = { nav.popBackStack() },
                // Always: the recorder is built into this app, unlike the web
                // build where `platform.bgLocation` is null and it is hidden.
                recorderAvailable = true,
            )
        }

        composable<Route.EventForm> { entry ->
            val route = entry.toRoute<Route.EventForm>()
            // The form's own destination, so saving can pop exactly it and
            // nothing else — the screen underneath might be the dashboard, an
            // event, or a track page.
            val formDestination = entry.destination.id
            val model = rememberScreenModel { scope, handle ->
                EventFormModel(
                    scope = scope,
                    api = api,
                    editId = route.editId,
                    presetTrack = route.presetTrack,
                    saved = handle,
                )
            }
            EventFormScreen(
                model = model,
                onSaved = { id ->
                    // A new event opens; an edit returns to the event that was
                    // already underneath. Either way the form itself is gone
                    // from the back stack — going "back" into a saved form is
                    // an invitation to save it twice.
                    if (route.editId == null) {
                        nav.navigate(Route.Event(id)) {
                            popUpTo(formDestination) { inclusive = true }
                        }
                    } else {
                        nav.popBackStack()
                    }
                },
                onCancel = { nav.popBackStack() },
            )
        }

        composable<Route.Track> { entry ->
            val route = entry.toRoute<Route.Track>()
            val model = rememberScreenModel { scope, _ -> TrackModel(scope, api, route.id) }
            TrackScreen(
                model = model,
                onOpenEvent = { nav.navigate(Route.Event(it)) },
                onAddEvent = { name -> nav.navigate(Route.EventForm(presetTrack = name)) },
                onShare = share,
                serverUrl = serverUrl,
            )
        }

        composable<Route.Settings> {
            val model = rememberScreenModel { scope, _ -> SettingsModel(scope, api, auth) }
            SettingsScreen(
                model = model,
                checklistTemplate = checklistTemplate,
                hasCustomChecklistTemplate = hasCustomChecklistTemplate,
                themeChoice = themeChoice,
                onThemeChange = onThemeChange,
                serverUrl = serverUrl,
                onOpenLink = openLink,
                onOpenVehicle = { nav.navigate(Route.Vehicle(it)) },
                onShare = share,
                onSignOut = onSignOut,
            )
        }

        composable<Route.Record> { entry ->
            val route = entry.toRoute<Route.Record>()
            RecordScreen(
                state = recorderState,
                eventLabel = null,
                onStart = { onStartRecording(route.eventId) },
                onStop = onStopRecording,
            )
        }

        composable<Route.Vehicle> { entry ->
            val route = entry.toRoute<Route.Vehicle>()
            val model = rememberScreenModel { scope, _ -> VehicleModel(scope, api, route.id) }
            VehicleScreen(
                model = model,
                onOpenEvent = { nav.navigate(Route.Event(it)) },
            )
        }

        composable<Route.Shared> { entry ->
            val route = entry.toRoute<Route.Shared>()
            val model = rememberScreenModel { scope, _ -> SharedLogbookModel(scope, api, route.slug) }
            SharedLogbookScreen(model = model)
        }
    }
}

/**
 * Follows a row created offline to its real id once the queue has flushed.
 *
 * An offline create hands back a negative temp id (NS-22) and the screen
 * navigates straight to it. When the write reaches the server that id stops
 * existing — so the destination is replaced rather than left to 404 on its next
 * refresh, and the back stack entry underneath goes with it, since going back to
 * a screen that can no longer load is the same bug one gesture later.
 */
@Composable
private fun FollowTempIds(nav: NavHostController, api: ApiClient) {
    val sync by api.syncStatus.collectAsState()
    val entry by nav.currentBackStackEntryAsState()

    LaunchedEffect(sync.pending, entry) {
        if (sync.pending != 0) return@LaunchedEffect
        val current = entry ?: return@LaunchedEffect
        val route = current.routeOrNull() ?: return@LaunchedEffect
        val from = route.tempId() ?: return@LaunchedEffect
        val to = api.resolveTempId(from) ?: return@LaunchedEffect
        nav.navigate(route.remapTempId(from, to)) {
            popUpTo(current.destination.id) { inclusive = true }
        }
    }
}

/**
 * The route a back stack entry is showing, for the two things that need to know
 * — temp-id remapping and the "am I at the root" back rule.
 *
 * Only the id-carrying destinations are recognised, because they are the only
 * ones either caller acts on.
 */
private fun NavBackStackEntry.routeOrNull(): Route? = when {
    destination.hasRoute(Route.Event::class) -> toRoute<Route.Event>()
    destination.hasRoute(Route.EventForm::class) -> toRoute<Route.EventForm>()
    destination.hasRoute(Route.Record::class) -> toRoute<Route.Record>()
    else -> null
}

/** The temp id this route is parked on, if any. */
private fun Route.tempId(): Int? {
    val id = when (this) {
        is Route.Event -> id
        is Route.EventForm -> editId
        is Route.Record -> eventId
        else -> null
    } ?: return null
    return id.takeIf { OfflineStore.isTemp(it) }
}
