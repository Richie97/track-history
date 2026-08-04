package app.trackevolution

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
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
import app.trackevolution.auth.checklistTemplate
import app.trackevolution.auth.hasCustomChecklistTemplate
import app.trackevolution.core.api.ApiClient
import app.trackevolution.navigation.AppNavHost
import app.trackevolution.navigation.Route
import app.trackevolution.navigation.Router
import app.trackevolution.navigation.showDeepLink
import app.trackevolution.recording.RecordingBanner
import app.trackevolution.recording.Recorder
import app.trackevolution.recording.RecordingFlow
import app.trackevolution.recording.ReviewScreen
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.ui.theme.TrackTheme

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
    router: Router,
    flow: RecordingFlow,
    serverUrl: String,
    themeChoice: ThemeChoice,
    onThemeChange: (ThemeChoice) -> Unit,
    startOnRecord: Boolean,
    onConsumedStartOnRecord: () -> Unit,
    onStartRecording: (Int?) -> Unit,
    onSignOut: () -> Unit,
) {
    val context = LocalContext.current
    val nav = rememberNavController()
    val recorder by Recorder.state.collectAsState()
    val pending by Recorder.finished.collectAsState()
    val review by flow.state.collectAsState()
    val saved by flow.saved.collectAsState()
    val parkedLink by router.pending.collectAsState()
    val entry by nav.currentBackStackEntryAsState()

    // Saveable: the system killing the app mid-review must not lose the fact
    // that there is a recording waiting to be saved.
    var reviewing by rememberSaveable { mutableStateOf(false) }

    val onRecordScreen = entry?.destination?.hasRoute(Route.Record::class) == true
    val atRoot = entry?.destination?.hasRoute(Route.Dashboard::class) == true

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
            nav.popBackStack(Route.Dashboard, inclusive = false)
            flow.acknowledgeSaved()
        }
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
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(TrackTheme.colors.bgPage)
            .systemBarsPadding(),
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
            AppNavHost(
                nav = nav,
                api = api,
                auth = auth,
                checklistTemplate = authState.checklistTemplate,
                hasCustomChecklistTemplate = authState.hasCustomChecklistTemplate,
                themeChoice = themeChoice,
                onThemeChange = onThemeChange,
                serverUrl = serverUrl,
                recorderState = recorder,
                onStartRecording = onStartRecording,
                onStopRecording = { Recorder.stop(context) },
                onSignOut = onSignOut,
            )
            if (reviewing) {
                ReviewScreen(
                    state = review,
                    onPick = flow::pick,
                    onLabelChange = flow::setLabel,
                    onNotesChange = flow::setNotes,
                    onSelectEvent = flow::selectEvent,
                    onSave = { flow.save(context) },
                    onDiscard = { flow.discard(context); reviewing = false },
                )
            }
        }
    }
}
