package app.trackevolution.navigation

import android.net.Uri
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.toRoute
import app.trackevolution.auth.ChecklistTemplateStore
import app.trackevolution.auth.CustomTabs
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.model.Entitlement
import app.trackevolution.core.offline.OfflineStore
import app.trackevolution.recording.RecordScreen
import app.trackevolution.recording.RecorderState
import app.trackevolution.screens.CompareLapsModel
import app.trackevolution.screens.CompareLapsScreen
import app.trackevolution.screens.DetailPlaceholder
import app.trackevolution.screens.EventFormModel
import app.trackevolution.screens.EventFormScreen
import app.trackevolution.screens.EventModel
import app.trackevolution.screens.EventScreen
import app.trackevolution.screens.LeaderboardLapModel
import app.trackevolution.screens.LeaderboardLapScreen
import app.trackevolution.screens.LeaderboardModel
import app.trackevolution.screens.LeaderboardScreen
import app.trackevolution.screens.SettingsModel
import app.trackevolution.screens.SettingsScreen
import app.trackevolution.screens.SharedLogbookModel
import app.trackevolution.screens.SharedLogbookScreen
import app.trackevolution.screens.TrackModel
import app.trackevolution.screens.TrackScreen
import app.trackevolution.screens.VehicleModel
import app.trackevolution.screens.VehicleScreen
import app.trackevolution.ui.LayoutClass
import app.trackevolution.ui.LocalLayoutMetrics
import app.trackevolution.ui.PageColumn
import app.trackevolution.ui.PaneWidth
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.videoimport.ImportModel
import app.trackevolution.videoimport.ImportScreen
import app.trackevolution.videoimport.ImportedClip

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
    /**
     * Parsed clips leaving the import chooser for the review overlay, with the
     * event they were imported from. Defaulted so a test composing the graph
     * for something else need not care.
     */
    onImportParsed: (Int?, List<ImportedClip>) -> Unit = { _, _ -> },
    /** Videos handed in by the share sheet, waiting for the import chooser. */
    incomingImport: List<Uri>? = null,
    onConsumedIncomingImport: () -> Unit = {},
    /**
     * The account's tier as the server last said it (NS-32) — offline, the
     * cached `/api/me`. Null is "no session", which the gates treat as free.
     * Defaulted so a test composing the graph for something else need not care,
     * and because the gates are off until phase D anyway.
     */
    entitlement: Entitlement? = null,
    /**
     * A Pro surface was asked for by a free account with the gates on, or
     * Settings' Subscribe was tapped: the scaffold shows the paywall sheet.
     */
    onRequirePro: () -> Unit = {},
    /**
     * Whether the start destination should render the detail pane's empty state
     * rather than the dashboard (NS-34).
     *
     * True exactly when the dashboard is already the list pane beside this graph.
     * The *route* is unchanged either way — `Route.Dashboard` is still the start
     * destination, still what `popUpTo` targets and still where back lands — so
     * nothing about navigation has two versions; only what that one destination
     * draws does.
     */
    dashboardAsDetailPlaceholder: Boolean = false,
    /** Which row the list pane should mark, when there is a list pane. */
    selection: Route? = null,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val openLink: (String) -> Unit = { CustomTabs.open(context, it) }
    val share: (String) -> Unit = { shareLink(context, it) }

    FollowTempIds(nav, api)

    NavHost(navController = nav, startDestination = Route.Dashboard, modifier = modifier) {

        pageComposable<Route.Dashboard> {
            if (dashboardAsDetailPlaceholder) {
                DetailPlaceholder(
                    api = api,
                    onOpenEvent = { nav.navigate(Route.Event(it)) },
                )
            } else {
                DashboardPane(
                    nav = nav,
                    api = api,
                    recorderIdle = recorderIdle,
                    selection = selection,
                    inListPane = false,
                )
            }
        }

        pageComposable<Route.Event> { entry ->
            val route = entry.toRoute<Route.Event>()
            val model = rememberScreenModel { scope, _ -> EventModel(scope, api, route.id) }
            EventScreen(
                model = model,
                checklistTemplate = checklistTemplate,
                onEdit = { nav.navigate(Route.EventForm(editId = it)) },
                onOpenTrack = { nav.navigate(Route.Track(it)) },
                onRecord = { nav.navigate(Route.Record(eventId = it)) },
                // Not gated: importing is free (NS-32). What a free account
                // gets out of a clip is the lap times, the racing line and the
                // car metrics — the per-lap channels the same import writes are
                // withheld by the server on the way back out, not by a paywall
                // on the way in.
                onImport = { id -> nav.navigate(Route.Import(eventId = id)) },
                onDeleted = { nav.popBackStack() },
                // Always: the recorder is built into this app, unlike the web
                // build where `platform.bgLocation` is null and it is hidden.
                recorderAvailable = true,
            )
        }

        pageComposable<Route.EventForm> { entry ->
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

        pageComposable<Route.Track> { entry ->
            val route = entry.toRoute<Route.Track>()
            val model = rememberScreenModel { scope, _ -> TrackModel(scope, api, route.id) }
            // At expanded width the two-lap compare opens **beside** the page
            // rather than as its own destination (NS-34 ticket 3). Same
            // `CompareLapsScreen`, same `Route.CompareLaps` — which a deep link
            // can still land on — only the container changes.
            val sideBySide = LocalLayoutMetrics.current.layoutClass == LayoutClass.Expanded
            var comparing by rememberSaveable { mutableStateOf(false) }
            val page = @Composable {
                TrackScreen(
                    model = model,
                    onOpenEvent = { nav.navigate(Route.Event(it)) },
                    onAddEvent = { name -> nav.navigate(Route.EventForm(presetTrack = name)) },
                    onCompareLaps = {
                        if (sideBySide) comparing = true else nav.navigate(Route.CompareLaps(route.id))
                    },
                    // A destination rather than a column, at every width: other
                    // drivers' laps are a place you go and come back from, not a
                    // second reading of this page's own.
                    onLeaderboard = { nav.navigate(Route.Leaderboard(route.id)) },
                    onShare = share,
                    serverUrl = serverUrl,
                )
            }
            if (sideBySide && comparing) {
                Row(Modifier.fillMaxSize()) {
                    PaneWidth(Modifier.weight(1f)) { page() }
                    VerticalDivider()
                    PaneWidth(
                        Modifier.width(
                            (LocalLayoutMetrics.current.contentWidth * 0.46f).coerceIn(380.dp, 620.dp),
                        ),
                    ) {
                        val compare = rememberScreenModel(key = "compare-${route.id}") { scope, _ ->
                            CompareLapsModel(scope, api, route.id)
                        }
                        // A destination has a back gesture and a column has
                        // nothing, so the column needs a way out of its own.
                        CompareLapsScreen(model = compare, onClose = { comparing = false })
                    }
                }
            } else {
                page()
            }
        }

        pageComposable<Route.CompareLaps> { entry ->
            val route = entry.toRoute<Route.CompareLaps>()
            val model = rememberScreenModel { scope, _ -> CompareLapsModel(scope, api, route.trackId) }
            CompareLapsScreen(model = model)
        }

        pageComposable<Route.Leaderboard> { entry ->
            val route = entry.toRoute<Route.Leaderboard>()
            val model = rememberScreenModel { scope, _ -> LeaderboardModel(scope, api, route.trackId) }
            LeaderboardScreen(
                model = model,
                onOpenLap = { nav.navigate(Route.LeaderboardLap(route.trackId, it)) },
            )
        }

        pageComposable<Route.LeaderboardLap> { entry ->
            val route = entry.toRoute<Route.LeaderboardLap>()
            val model = rememberScreenModel { scope, _ ->
                LeaderboardLapModel(scope, api, route.trackId, route.lapId)
            }
            LeaderboardLapScreen(
                model = model,
                canViewChannels = Entitlement.canViewChannels(entitlement),
                onSubscribe = onRequirePro,
            )
        }

        pageComposable<Route.Settings> {
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
                entitlement = entitlement ?: Entitlement.FREE,
                onSubscribe = onRequirePro,
            )
        }

        composable<Route.Record> { entry ->
            val route = entry.toRoute<Route.Record>()

            // Which event this recording actually belongs to. A *running*
            // recording carries its own attachment and outranks the route,
            // because it may have been started somewhere the route knows
            // nothing about — the notification, or the banner, both of which
            // navigate here as `Route.Record()` with no id at all. Reading the
            // route in that case is how the screen ends up describing an
            // attachment that isn't the one in effect.
            val targetId = recorderState.eventId?.toIntOrNull() ?: route.eventId

            // The name is a lookup rather than something the route carries, for
            // the same reason: the id in effect isn't always the id we were
            // navigated with. `events()` is the offline layer's cached list the
            // dashboard already warmed, so this is normally free, and null —
            // offline with a cold cache — degrades to naming no track rather
            // than to claiming there is no event.
            val eventLabel by produceState<String?>(null, targetId) {
                value = targetId?.let { id ->
                    runCatching { api.events().firstOrNull { it.id == id }?.trackName }.getOrNull()
                }
            }

            RecordScreen(
                state = recorderState,
                isAttached = targetId != null,
                eventLabel = eventLabel,
                // The recorder's gate is at *start* (NS-32 rule 5): a free account
                // with the gates on sees the paywall here instead of a disabled
                // button, and a cached Pro proceeds offline. Stop is never gated.
                onStart = {
                    if (Entitlement.recordGate(entitlement) == Entitlement.Gate.PAYWALL) {
                        onRequirePro()
                    } else {
                        onStartRecording(route.eventId)
                    }
                },
                onStop = onStopRecording,
            )
        }

        composable<Route.Import> { entry ->
            val route = entry.toRoute<Route.Import>()
            val resolver = context.applicationContext.contentResolver
            val model = rememberScreenModel { scope, _ -> ImportModel(scope, resolver) }
            ImportScreen(
                model = model,
                incoming = incomingImport,
                onConsumedIncoming = onConsumedIncomingImport,
                onParsed = { clips -> onImportParsed(route.eventId, clips) },
            )
        }

        pageComposable<Route.Vehicle> { entry ->
            val route = entry.toRoute<Route.Vehicle>()
            val model = rememberScreenModel { scope, _ -> VehicleModel(scope, api, route.id) }
            VehicleScreen(
                model = model,
                onOpenEvent = { nav.navigate(Route.Event(it)) },
                onRequirePro = onRequirePro,
            )
        }

        pageComposable<Route.Shared> { entry ->
            val route = entry.toRoute<Route.Shared>()
            val model = rememberScreenModel { scope, _ -> SharedLogbookModel(scope, api, route.slug) }
            SharedLogbookScreen(model = model)
        }
    }
}

/**
 * A logbook destination, with its content column capped and centred (NS-34).
 *
 * Identical to `composable<T>` except for the [PageColumn] around the screen, so
 * that "this page is read as a column" is one word at the destination rather
 * than a wrapper indented into every screen. Below the cap it is a no-op, which
 * is why a phone renders exactly as it did.
 *
 * The two destinations that deliberately keep `composable<T>` are **Record** and
 * **Import**: the record screen is a phone-in-a-mount layout and stays
 * full-window at every width (NS-34 explicitly gives it no width work), and the
 * importer is a chooser that hands straight over to the review overlay, which is
 * modal over the whole window.
 */
private inline fun <reified T : Any> NavGraphBuilder.pageComposable(
    noinline content: @Composable (NavBackStackEntry) -> Unit,
) = composable<T> { entry -> PageColumn { content(entry) } }

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
    destination.hasRoute(Route.Import::class) -> toRoute<Route.Import>()
    else -> null
}

/** The temp id this route is parked on, if any. */
private fun Route.tempId(): Int? {
    val id = when (this) {
        is Route.Event -> id
        is Route.EventForm -> editId
        is Route.Record -> eventId
        is Route.Import -> eventId
        else -> null
    } ?: return null
    return id.takeIf { OfflineStore.isTemp(it) }
}
