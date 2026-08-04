package app.trackevolution.auth

import android.content.Context
import android.net.Uri
import app.trackevolution.core.EventDates
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.api.AuthProvider
import app.trackevolution.core.api.AuthProviders
import app.trackevolution.core.api.Pkce
import app.trackevolution.core.model.User
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** Where the app is in the sign-in flow. */
sealed interface AuthState {
    /** Reading the stored token — one frame, usually. */
    data object Loading : AuthState

    data class SignedOut(
        val providers: AuthProviders = AuthProviders.FALLBACK,
        /** The server's own message, when the last attempt failed. */
        val error: String? = null,
    ) : AuthState

    /** The browser is open, or the code is being exchanged. */
    data object SigningIn : AuthState

    data class SignedIn(val user: User) : AuthState
}

/**
 * The prep list a new event's checklist starts from — the user's own, or the
 * app's built-in default when they have never edited it.
 *
 * Derived from [AuthState] rather than read off [AuthController] so that a
 * composable which collects the state re-renders when the template changes:
 * Settings edits it and the event page's "Use my list" button reads it, and two
 * copies of one value is exactly how those two would disagree.
 */
val AuthState.checklistTemplate: List<String>
    get() = (this as? AuthState.SignedIn)?.user?.checklistTemplate?.takeIf { it.isNotEmpty() }
        ?: EventDates.DEFAULT_CHECKLIST

/** Whether the list above is the user's own or still the built-in default. */
val AuthState.hasCustomChecklistTemplate: Boolean
    get() = (this as? AuthState.SignedIn)?.user?.checklistTemplate?.isNotEmpty() == true

/**
 * The prep-checklist template as the Settings editor needs it: read the current
 * list, write a new one.
 *
 * An interface rather than a direct [AuthController] dependency because the
 * editor's whole job is *ordering* — move up, move down, remove, reset — and
 * that logic deserves a test that doesn't have to stand up an encrypted token
 * store and an OAuth state machine to run.
 */
interface ChecklistTemplateStore {
    val items: List<String>

    /** Throws [ApiException] on rejection: a template is never queued offline. */
    suspend fun set(items: List<String>)
}

/**
 * Owns the sign-in flow: PKCE, the browser hop, the code exchange, and the token.
 *
 * The server side already exists and is not touched (`src/routes/auth.ts`, with
 * every failure mode in `test/api/native-auth.test.ts`). Three of its properties
 * shape this class:
 *
 *  - The one-time code lives **60 seconds** and is **burned on first use, before
 *    verification**. So a failed exchange is never retried — the flow restarts
 *    from a fresh verifier — and [handleRedirect] clears the pending state on
 *    every path, success or not.
 *  - The redirect arrives as a *new intent*, which Android may deliver again
 *    after a recreate. A code with no pending flow behind it is ignored rather
 *    than exchanged, which is what stops a rotation from burning a good session.
 *  - Accounts are claimed by verified email, so Google and Apple on one address
 *    land on one account. Nothing to do here — just don't be surprised.
 */
class AuthController(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    private val store: AuthStore,
    private val providersStore: AuthProvidersStore,
    private val serverPreference: ServerPreference,
) : ChecklistTemplateStore {
    private val _state = MutableStateFlow<AuthState>(AuthState.Loading)
    val state: StateFlow<AuthState> = _state.asStateFlow()

    /**
     * Point the client at the stored server, then decide whether we have a
     * session. A stored token is only believed once `/api/me` accepts it — the
     * alternative is a signed-in-looking app whose every request 401s.
     */
    fun start() {
        scope.launch {
            api.serverUrl = serverPreference.current()
            refreshProviders()
            if (!store.isSignedIn) {
                _state.value = signedOut()
                return@launch
            }
            loadUser()
        }
    }

    private suspend fun loadUser() {
        try {
            _state.value = AuthState.SignedIn(api.me().user)
        } catch (e: ApiException) {
            if (e.isUnauthorized) {
                // Expired or revoked server-side. No silent retry.
                signOutLocally()
            } else {
                // Offline, or the server is unwell. The token is still good, so
                // staying signed out here would be the wrong call — but there is
                // no user to show yet either; NS-22's cache is what eventually
                // answers this. Until then, surface it on the sign-in screen.
                _state.value = signedOut(error = e.message)
            }
        }
    }

    /**
     * Starts a flow: fresh verifier, persisted, then the system browser.
     *
     * [activity] rather than the application context because the Custom Tab has
     * to launch into *this* task — see [CustomTabs].
     */
    fun signIn(provider: AuthProvider, activity: Context) {
        val pkce = Pkce.generate()
        store.startPending(PendingSignIn(verifier = pkce.verifier, provider = provider))
        _state.value = AuthState.SigningIn
        if (!CustomTabs.open(activity, api.signInUrl(provider, pkce.challenge))) {
            store.clearPending()
            _state.value = signedOut(error = "No browser available to sign in with.")
        }
    }

    /**
     * Handles `trackevolution://auth?code=…`. Returns true when the URL was ours,
     * so the caller knows not to treat it as navigation.
     */
    fun handleRedirect(uri: Uri): Boolean {
        if (uri.scheme != CALLBACK_SCHEME || uri.host != CALLBACK_HOST) return false

        val pending = store.pendingSignIn()
        if (pending == null) {
            // A redelivered intent after a recreate, or a redirect we never
            // started. Exchanging would burn a code we cannot verify.
            return true
        }
        val code = uri.getQueryParameter("code")
        if (code.isNullOrEmpty()) {
            store.clearPending()
            _state.value = signedOut(error = uri.getQueryParameter("error") ?: "Sign-in was cancelled.")
            return true
        }

        _state.value = AuthState.SigningIn
        scope.launch {
            try {
                store.token = api.exchange(code = code, verifier = pending.verifier)
                loadUser()
            } catch (e: ApiException) {
                _state.value = signedOut(error = e.message)
            } finally {
                // Always: the code is spent either way, so the verifier is dead
                // weight that would only produce a confusing second failure.
                store.clearPending()
            }
        }
        return true
    }

    /**
     * Replaces the prep-checklist template, and keeps the in-memory user in step
     * so the event page's button agrees without a reload — the same reason the
     * web app writes back to `state.me` after a save.
     *
     * An empty list clears the stored one, putting the user back on the built-in
     * default; `sanitizeChecklistTemplate` treats `[]` and null alike. Throws
     * [ApiException] on rejection: a template is not on the offline queue, so the
     * caller has a real answer to show.
     */
    override val items: List<String> get() = _state.value.checklistTemplate

    override suspend fun set(items: List<String>): Unit = setChecklistTemplate(items)

    suspend fun setChecklistTemplate(items: List<String>) {
        api.updateChecklistTemplate(items)
        val current = _state.value as? AuthState.SignedIn ?: return
        _state.value = AuthState.SignedIn(
            current.user.copy(checklistTemplate = items.ifEmpty { null }),
        )
    }

    /** A 401 from any request: the session is gone. Drop to sign-in, no retry. */
    fun onUnauthorized() {
        scope.launch { signOutLocally() }
    }

    /**
     * Sign-out. Revokes server-side first, then clears the token **and cached
     * data** — a shared device must not retain the previous user's logbook, the
     * way the web app already handles it.
     */
    fun signOut() {
        scope.launch {
            // Best effort: a dead network must not strand someone signed in on a
            // device they are handing over.
            runCatching { api.logout() }
            signOutLocally()
        }
    }

    private suspend fun signOutLocally() {
        store.clear()
        // The cached logbook and any unsent writes go with the token: a shared
        // device must not retain the previous user's data, and a queued write
        // replayed under the next user's session would file it to the wrong
        // account (NS-22).
        api.clearOffline()
        _state.value = signedOut()
    }

    /** Re-reads the server's provider list, remembering it per server. */
    suspend fun refreshProviders() {
        val server = api.serverUrl
        runCatching { api.authProviders() }.onSuccess { providersStore.save(it, server) }
        knownProviders = providersStore.providers(server).first()
        val current = _state.value
        if (current is AuthState.SignedOut) {
            _state.value = current.copy(providers = knownProviders)
        }
    }

    /** Points the app at another instance and re-evaluates everything. */
    fun setServer(url: String) {
        scope.launch {
            serverPreference.set(url)
            api.serverUrl = serverPreference.current()
            // A token from one server means nothing on another.
            store.clear()
            _state.value = signedOut()
            refreshProviders()
        }
    }

    /**
     * The last provider list this server advertised. Cached in memory as well as
     * on disk so the sign-in screen can be built synchronously — from
     * [signIn]'s failure path, say — without a suspending read that would blank
     * the buttons for a frame.
     */
    private var knownProviders: AuthProviders = AuthProviders.FALLBACK

    private fun signedOut(error: String? = null) =
        AuthState.SignedOut(providers = knownProviders, error = error)

    private companion object {
        const val CALLBACK_SCHEME = "trackevolution"
        const val CALLBACK_HOST = "auth"
    }
}
