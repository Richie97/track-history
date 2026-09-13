package app.trackevolution

import android.app.Activity
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import app.trackevolution.auth.AuthController
import app.trackevolution.auth.AuthState
import app.trackevolution.auth.CustomTabs
import app.trackevolution.auth.checklistTemplate
import app.trackevolution.auth.entitlement
import app.trackevolution.auth.hasCustomChecklistTemplate
import app.trackevolution.billing.BillingController
import app.trackevolution.billing.PaywallSheet
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.model.Entitlement
import app.trackevolution.navigation.AppNavHost
import app.trackevolution.navigation.DashboardPane
import app.trackevolution.navigation.Route
import app.trackevolution.navigation.Router
import app.trackevolution.navigation.selectionRoute
import app.trackevolution.navigation.showDeepLink
import app.trackevolution.ui.LayoutClass
import app.trackevolution.ui.LocalLayoutMetrics
import app.trackevolution.ui.LocalUnitSystem
import app.trackevolution.ui.TwoPaneShell
import app.trackevolution.recording.RecordingBanner
import app.trackevolution.recording.Recorder
import app.trackevolution.recording.RecordingFlow
import app.trackevolution.recording.ReviewScreen
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.ui.theme.TrackTheme
import app.trackevolution.videoimport.ImportedClip

/**
 * The signed-in shell: the recording banner, the navigation graph, and the
 * review flow that sits over both.
 *
 * Three rules here are load-bearing, and NS-26 inherits all three from NS-18:
 *
 *  - **The banner is above the destination**, so a recording in progress — or,
 *    worse, an unsaved one sitting on disk — is visible from every screen. An
 *    unattached recording belongs to no event, so there is no page to stumble
 *    across it on.
 *  - **Back never stops a recording.** It navigates; the service carries on.
 *  - **Back at the root minimizes** rather than finishing the activity, because
 *    a recording may be running and the task should stay where the user left it.
 *
 * Review is an overlay rather than a destination on purpose: "save or discard
 * this recording" is modal by nature, and putting it on the back stack would let
 * a gesture bury an unsaved session behind the logbook.
 */
@Composable
fun SignedInScaffold(
    api: ApiClient,
    auth: AuthController,
    authState: AuthState,
    /** The purchase terminal behind the paywall sheet (NS-32 phase C). */
    billing: BillingController,
    router: Router,
    flow: RecordingFlow,
    serverUrl: String,
    themeChoice: ThemeChoice,
    onThemeChange: (ThemeChoice) -> Unit,
    startOnRecord: Boolean,
    onConsumedStartOnRecord: () -> Unit,
    onStartRecording: (Int?) -> Unit,
    onSignOut: () -> Unit,
    /** Videos the share sheet handed the app, waiting for the import chooser. */
    incomingImport: List<Uri>? = null,
    onConsumedIncomingImport: () -> Unit = {},
) {
    val context = LocalContext.current
    val units = LocalUnitSystem.current
    val nav = rememberNavController()
    val recorder by Recorder.state.collectAsState()
    val pending by Recorder.finished.collectAsState()
    val review by flow.state.collectAsState()
    val saved by flow.saved.collectAsState()
    val stagedImports by flow.staged.collectAsState()
    val parkedLink by router.pending.collectAsState()
    val entry by nav.currentBackStackEntryAsState()

    // Saveable: the system killing the app mid-review must not lose the fact
    // that there is a recording waiting to be saved.
    var reviewing by rememberSaveable { mutableStateOf(false) }

    // The paywall (NS-32 rule 5): a sheet over whatever asked for Pro — the
    // recorder's Start, Settings' Subscribe, a Pro-gated read that came back
    // 402 — never a disabled control. The gate itself is decided in :core
    // (`Entitlement.recordGate`) against the entitlement on the auth state,
    // which offline is the cached `/api/me`.
    var paywall by rememberSaveable { mutableStateOf(false) }
    val entitlement = authState.entitlement

    val onRecordScreen = entry?.destination?.hasRoute(Route.Record::class) == true
    val atRoot = entry?.destination?.hasRoute(Route.Dashboard::class) == true

    // Two panes, or one (NS-34).
    //
    // Expanded width and nothing that owns the window. The record screen is a
    // phone-in-a-mount layout meant to be read at a glance and the importer hands
    // straight over to the modal review, so both drop to a single pane rather than
    // being squeezed into half a tablet — the same rule iOS spells as
    // `Route.ownsTheWindow`. Dropping the *scaffold* rather than presenting over
    // it is what keeps navigation in one place: these are ordinary destinations on
    // the ordinary back stack, at every width.
    val onImportScreen = entry?.destination?.hasRoute(Route.Import::class) == true
    val twoPane = LocalLayoutMetrics.current.layoutClass == LayoutClass.Expanded &&
        !onRecordScreen && !onImportScreen

    // Which list row the detail is showing. Null below expanded width, where the
    // detail is the whole screen and there is no list beside it to mark.
    val selection = if (twoPane) entry?.selectionRoute() else null

    val recorderIdle = !recorder.isRecording && pending == null

    // A link that arrived before there was a graph to send it to — a cold start
    // hands the intent over long before this composes.
    LaunchedEffect(parkedLink) {
        val route = router.consume() ?: return@LaunchedEffect
        nav.showDeepLink(route)
    }

    // Tapping the recording notification must land on the recording, not the
    // dashboard — the whole point of it while driving.
    LaunchedEffect(startOnRecord) {
        if (startOnRecord) {
            nav.navigate(Route.Record())
            onConsumedStartOnRecord()
        }
    }

    // A recording that just stopped, or one recovered from a previous launch,
    // is what the review screen is for.
    LaunchedEffect(pending) {
        val recording = pending ?: return@LaunchedEffect
        flow.begin(recording)
        // Stopping goes straight to review — that is the flow. A recording
        // *recovered* at launch does not hijack the app the same way: the
        // banner offers it, and the user decides when.
        if (onRecordScreen) {
            reviewing = true
            // Take the recorder off the stack with it, so backing out of review
            // lands on the logbook rather than on a stopped recorder.
            nav.popBackStack()
        }
    }

    LaunchedEffect(saved) {
        if (saved) {
            reviewing = false
            if (review.forNewEvent) {
                // The drafts went to `flow.staged`, and the New Event form is the
                // destination underneath — the chooser came off the stack when the
                // review opened — so closing the review is all there is to do.
                flow.acknowledgeSaved()
                return@LaunchedEffect
            }
            val importedInto = if (review.isImport) flow.savedEventId else null
            nav.popBackStack(Route.Dashboard, inclusive = false)
            // An import came from an event's page and its sessions are now on
            // it, so that is where it lands — on a fresh destination, which is
            // what makes the page re-fetch and show them. A recording keeps
            // landing on the dashboard, as it always has.
            if (importedInto != null) nav.navigate(Route.Event(importedInto))
            flow.acknowledgeSaved()
        }
    }

    // Videos shared into the app open the chooser, which parses them on arrival.
    // Signed-out arrivals park here until there is a graph to send them to.
    // Ungated, like the event page's button — importing is free.
    LaunchedEffect(incomingImport) {
        if (incomingImport == null) return@LaunchedEffect
        nav.navigate(Route.Import())
    }

    // Leaving review does not stop or discard anything: the recording stays
    // checkpointed and the banner keeps offering it.
    BackHandler(enabled = reviewing) { reviewing = false }

    // The root. Finishing the activity would tear down a task that may have a
    // recording notification attached to it; the Capacitor app called
    // `App.minimizeApp()` here for the same reason.
    BackHandler(enabled = atRoot && !reviewing) {
        (context as? Activity)?.moveTaskToBack(true)
    }

    // The insets live here, once: the app draws edge to edge behind the system
    // bars, and every screen below is laid out inside them.
    //
    // `imePadding` is not optional. Without it the keyboard draws *over* the
    // content, and the submit button of any form long enough to need scrolling —
    // the event form, a wear measurement — ends up behind it with no way to
    // reach it. Shrinking the content area instead is also what lets a focused
    // field scroll itself into view.
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(TrackTheme.colors.bgPage)
            .systemBarsPadding()
            .imePadding(),
    ) {
        if (!reviewing && !onRecordScreen) {
            RecordingBanner(
                state = recorder,
                pending = pending,
                onOpen = {
                    if (pending != null && !recorder.isRecording) {
                        reviewing = true
                    } else {
                        nav.navigate(Route.Record())
                    }
                },
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
        }

        Box(modifier = Modifier.weight(1f)) {
            // The graph stays composed underneath: review is a cover, not a
            // replacement, so returning from it does not rebuild the back stack.
            //
            // At expanded width it is the *detail* of a two-pane scaffold with the
            // dashboard beside it (NS-34). Both panes are inside this Box, so the
            // banners above still span the window and the review overlay below
            // still covers both — which is the rule NS-18 set and a second pane is
            // the easiest way to break by accident.
            TwoPaneShell(
                twoPane = twoPane,
                listPane = {
                    DashboardPane(
                        nav = nav,
                        api = api,
                        recorderIdle = recorderIdle,
                        selection = selection,
                        inListPane = true,
                    )
                },
            ) {
                AppNavHost(
                    nav = nav,
                    api = api,
                    auth = auth,
                    unitsStore = auth,
                    checklistTemplate = authState.checklistTemplate,
                    hasCustomChecklistTemplate = authState.hasCustomChecklistTemplate,
                    themeChoice = themeChoice,
                    onThemeChange = onThemeChange,
                    serverUrl = serverUrl,
                    recorderState = recorder,
                    // Idle is "nothing to say about a recording": none running, and
                    // none stopped-but-unsaved. Either of those already has a
                    // visible affordance above, so the dashboard's door stands down.
                    recorderIdle = !recorder.isRecording && pending == null,
                    onStartRecording = onStartRecording,
                    onStopRecording = { Recorder.stop(context) },
                    onSignOut = onSignOut,
                    entitlement = entitlement,
                    onRequirePro = { paywall = true },
                    onImportParsed = { route, clips: List<ImportedClip> ->
                        // Same shape as a recording stopping: the review covers the
                        // graph, and the chooser comes off the stack underneath it
                        // so backing out of the review lands on the event page — or
                        // on the New Event form, for an import started from it.
                        flow.beginImport(clips, route.eventId, forNewEvent = route.forNewEvent)
                        reviewing = true
                        nav.popBackStack()
                    },
                    stagedImports = stagedImports,
                    onConsumeStagedImports = { flow.takeStaged() },
                    incomingImport = incomingImport,
                    onConsumedIncomingImport = onConsumedIncomingImport,
                    // At expanded width the dashboard is the pane beside this, so the
                    // graph's start destination renders the empty state instead — the
                    // one thing NS-34 rules out by name is showing the dashboard
                    // twice. The *route* is unchanged, which is what keeps deep links,
                    // `popUpTo(Route.Dashboard)` and the minimize-at-root handler
                    // working identically at both widths.
                    dashboardAsDetailPlaceholder = twoPane,
                    selection = selection,
                )
            }
            if (reviewing) {
                ReviewScreen(
                    state = review,
                    onPick = flow::pick,
                    onLabelChange = flow::setLabel,
                    onIncludeChange = flow::setInclude,
                    onNotesChange = flow::setNotes,
                    onSelectEvent = flow::selectEvent,
                    onSave = { flow.save(context, units) },
                    onDiscard = { flow.discard(context); reviewing = false },
                )
            }
        }
    }

    if (paywall) {
        PaywallSheet(
            billing = billing,
            onDismiss = { paywall = false; billing.clearMessage() },
            onOpenLink = { CustomTabs.open(context, it) },
        )
    }
}
