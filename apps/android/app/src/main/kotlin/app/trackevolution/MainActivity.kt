package app.trackevolution

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.lifecycleScope
import app.trackevolution.auth.AuthController
import app.trackevolution.auth.AuthProvidersStore
import app.trackevolution.auth.AuthState
import app.trackevolution.auth.AuthStore
import app.trackevolution.auth.ServerPreference
import app.trackevolution.auth.ServerOverride
import app.trackevolution.auth.SignInScreen
import app.trackevolution.core.DeepLink
import app.trackevolution.core.api.ApiClient
import app.trackevolution.ui.theme.ThemeChoice
import app.trackevolution.ui.theme.ThemePreference
import app.trackevolution.ui.theme.TrackTheme
import io.ktor.client.engine.okhttp.OkHttp

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
     * A link that arrived before there was anywhere to send it. Cold start hands
     * the intent over long before NS-26's navigation exists, and dropping it
     * would make a tapped share link open a blank app.
     */
    private var pendingLink: DeepLink? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        // Must precede super.onCreate: it swaps the splash theme out for the
        // real one, so the app never flashes the splash background as a window.
        installSplashScreen()
        super.onCreate(savedInstanceState)

        val store = AuthStore(this)
        val serverPreference = ServerPreference(this)
        // OkHttp is chosen here, not in :core — that is what keeps the pure
        // module free of an HTTP engine and testable on the JVM.
        api = ApiClient(OkHttp.create(), tokens = store)
        auth = AuthController(
            scope = lifecycleScope,
            api = api,
            store = store,
            providersStore = AuthProvidersStore(this),
            serverPreference = serverPreference,
        )
        auth.start()
        // Cold start: the launching intent is delivered here, not to onNewIntent.
        handleIntent(intent)

        setContent {
            val preference = remember { ThemePreference(applicationContext) }
            val choice by preference.choice.collectAsState(initial = ThemeChoice.System)
            val state by auth.state.collectAsState()
            val server by serverPreference.url.collectAsState(initial = ApiClient.DEFAULT_BASE_URL)
            TrackTheme(choice) {
                when (state) {
                    is AuthState.SignedIn -> PlaceholderScreen(onSignOut = auth::signOut)
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
     * One entry point for every URL the app is opened with: the OAuth redirect
     * first, since it is not navigation and must not be parsed as such, then
     * anything the routing table recognises.
     */
    private fun handleIntent(intent: Intent?) {
        val uri = intent?.data ?: return
        if (auth.handleRedirect(uri)) return
        // NS-26 owns navigation; until it exists, a link is remembered rather
        // than dropped so the screens can consume it the moment they land.
        pendingLink = DeepLink.parse(uri.toString())
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

/**
 * What sits behind sign-in until NS-26. It reads from `:core` on purpose: the
 * module split is only proven if the shell actually references the pure-logic
 * module.
 */
@Composable
private fun PlaceholderScreen(onSignOut: () -> Unit) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    Column(
        modifier = Modifier.fillMaxSize().background(colors.bgPage).padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Signed in", style = type.h1, color = colors.textStrong, textAlign = TextAlign.Center)
        Text(
            text = "The logbook lands with NS-26.",
            style = type.sm,
            color = colors.textMuted,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 8.dp),
        )
        TextButton(onClick = onSignOut, modifier = Modifier.padding(top = 24.dp)) {
            Text("Sign out", style = type.bodyStrong, color = colors.accentInk)
        }
    }
}
