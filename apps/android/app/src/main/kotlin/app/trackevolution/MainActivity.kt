package app.trackevolution

import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import app.trackevolution.auth.AuthController
import app.trackevolution.auth.AuthProvidersStore
import app.trackevolution.auth.AuthState
import app.trackevolution.auth.ServerPreference
import app.trackevolution.auth.ServerOverride
import app.trackevolution.auth.SignInScreen
import app.trackevolution.core.DeepLink
import app.trackevolution.core.api.ApiClient
import app.trackevolution.data.AppServices
import app.trackevolution.navigation.Router
import app.trackevolution.recording.Haptics
import app.trackevolution.recording.Recorder
import app.trackevolution.recording.RecorderPermissions
import app.trackevolution.recording.RecordingFlow
import app.trackevolution.recording.RecordingService
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.ui.theme.ThemePreference
import app.trackevolution.ui.theme.TrackTheme

/**
 * The single activity the app runs in (spec: NS-02).
 *
 * It now owns the theme and the sign-in flow. The logbook screens arrive with
 * NS-26 and the recorder UI with NS-18, so what sits behind sign-in is still a
 * placeholder — but everything under it is real.
 *
 * `launchMode="singleTask"` in the manifest is load-bearing for auth: returning
 * from the browser has to resume *this* task and arrive at [onNewIntent], rather
 * than stacking a second activity that knows nothing about the flow in progress.
 */
class MainActivity : ComponentActivity() {

    private lateinit var api: ApiClient
    private lateinit var auth: AuthController

    /**
     * Where a link waits until there is a graph and a session to send it to. A
     * cold start hands the intent over long before either exists, and dropping
     * it would make a tapped share link open a blank app.
     */
    private val router = Router()

    private lateinit var flow: RecordingFlow

    /**
     * Set when the app was opened by tapping the recording notification, which
     * must land on the recording rather than the dashboard.
     */
    private var openRecorder by mutableStateOf(false)

    /**
     * Fine location and notifications, asked for at the moment the user asks to
     * record — in context, not at launch. Background location is a separate,
     * later escalation; Android rejects a combined request.
     */
    private val requestRecordingPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            startRecordingIfAllowed()
        }

    /**
     * The event the pending start belongs to, held across the permission prompt
     * — the result callback has no arguments of its own, and a recording that
     * lost its event on the way through a system dialog would land unattached.
     */
    private var recordingEventId: Int? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        // Must precede super.onCreate: it swaps the splash theme out for the
        // real one, so the app never flashes the splash background as a window.
        installSplashScreen()
        super.onCreate(savedInstanceState)

        // Process-wide, not activity-scoped: the offline store behind this
        // client keeps the queue's pending count and flush lock in memory, and
        // the replay worker has to share them. See AppServices.
        val services = AppServices.get(this)
        val store = services.authStore
        val serverPreference = ServerPreference(this)
        api = services.api
        auth = AuthController(
            scope = lifecycleScope,
            api = api,
            store = store,
            providersStore = AuthProvidersStore(this),
            serverPreference = serverPreference,
        )
        flow = RecordingFlow(scope = lifecycleScope, api = api)
        auth.start()
        // A recording a previous launch never finished is offered back rather
        // than left on disk unmentioned.
        Recorder.recoverPending(this)
        // Cold start: the launching intent is delivered here, not to onNewIntent.
        handleIntent(intent)

        setContent {
            val preference = remember { ThemePreference(applicationContext) }
            val choice by preference.choice.collectAsState(initial = ThemeChoice.System)
            val state by auth.state.collectAsState()
            val server by serverPreference.url.collectAsState(initial = ApiClient.DEFAULT_BASE_URL)
            TrackTheme(choice) {
                when (state) {
                    is AuthState.SignedIn -> SignedInScaffold(
                        api = api,
                        auth = auth,
                        authState = state,
                        router = router,
                        flow = flow,
                        serverUrl = server,
                        themeChoice = choice,
                        onThemeChange = { next ->
                            lifecycleScope.launch { preference.set(next) }
                        },
                        startOnRecord = openRecorder,
                        onConsumedStartOnRecord = { openRecorder = false },
                        onStartRecording = ::requestPermissionsThenRecord,
                        onSignOut = {
                            // A deep link parked for a session that no longer
                            // exists must not fire under the next one.
                            router.clear()
                            auth.signOut()
                        },
                    )
                    AuthState.Loading -> LoadingScreen()
                    else -> SignInScreen(
                        state = state,
                        onSignIn = { auth.signIn(it, this@MainActivity) },
                        // Debug only: pointing the app at `wrangler dev` is a
                        // development affordance, not a user-facing setting.
                        serverOverride = if (BuildConfig.DEBUG) {
                            ServerOverride(current = server, onChange = auth::setServer)
                        } else {
                            null
                        },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Keep it as *the* intent so a later recreate sees the same one, and so
        // the guard in handleRedirect (no pending flow → ignore) does its job.
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onDestroy() {
        super.onDestroy()
        api.close()
    }

    /**
     * Ask, then record. Asking here rather than at launch is the point: a
     * permission prompt makes sense the moment someone taps "record", and makes
     * none on first open.
     */
    private fun requestPermissionsThenRecord(eventId: Int?) {
        recordingEventId = eventId
        val needed = buildList {
            if (!RecorderPermissions.hasFineLocation(this@MainActivity)) {
                add(android.Manifest.permission.ACCESS_FINE_LOCATION)
                add(android.Manifest.permission.ACCESS_COARSE_LOCATION)
            }
            if (!RecorderPermissions.hasNotifications(this@MainActivity) &&
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            ) {
                add(android.Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        if (needed.isEmpty()) startRecordingIfAllowed() else requestRecordingPermissions.launch(needed.toTypedArray())
    }

    private fun startRecordingIfAllowed() {
        // The service refuses and reports anything still blocking, so this only
        // has to not start a recording that obviously cannot work.
        Recorder.start(this, eventId = recordingEventId?.toString())
        Haptics.confirm(this)
    }

    /**
     * One entry point for every URL the app is opened with: the OAuth redirect
     * first, since it is not navigation and must not be parsed as such, then
     * anything the routing table recognises.
     */
    private fun handleIntent(intent: Intent?) {
        if (intent?.getBooleanExtra(RecordingService.EXTRA_OPEN_RECORDER, false) == true) {
            openRecorder = true
        }
        val uri = intent?.data ?: return
        if (auth.handleRedirect(uri)) return
        // Parked rather than navigated to: the nav graph consumes it once it
        // exists, which on a cold start is several frames after this.
        DeepLink.parse(uri.toString())?.let(router::offer)
    }
}

@Composable
private fun LoadingScreen() {
    Box(
        modifier = Modifier.fillMaxSize().background(TrackTheme.colors.bgPage),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator(color = TrackTheme.colors.accent)
    }
}
