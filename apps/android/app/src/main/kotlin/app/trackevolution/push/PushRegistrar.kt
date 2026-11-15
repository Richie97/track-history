package app.trackevolution.push

import android.os.Build
import android.util.Log
import androidx.compose.runtime.staticCompositionLocalOf
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * What the screens see of coach-comment notifications (NS-54): Settings'
 * toggle and the in-context ask under a thread. Published as
 * [LocalCommentPush]; the default is inert, so a Robolectric screen test never
 * reaches Firebase.
 */
interface CommentPushControl {
    /** The driver turned notifications on for this phone. */
    val enabled: StateFlow<Boolean>

    /** The in-context ask has been answered, either way. */
    val asked: StateFlow<Boolean>

    /** Settings' toggle, and the ask's *Turn on*: registers or unregisters. */
    fun setEnabled(on: Boolean)

    /** The ask's *Not now*, or a denied permission: never offered again. */
    fun markAsked()

    companion object {
        val NONE: CommentPushControl = object : CommentPushControl {
            override val enabled: StateFlow<Boolean> = MutableStateFlow(false)
            override val asked: StateFlow<Boolean> = MutableStateFlow(true)
            override fun setEnabled(on: Boolean) = Unit
            override fun markAsked() = Unit
        }
    }
}

/** Published once by `MainActivity`, from `AppServices.push`. */
val LocalCommentPush = staticCompositionLocalOf { CommentPushControl.NONE }

/** Where this install's FCM registration token comes from — Firebase, or a test's fake. */
fun interface PushTokenSource {
    suspend fun token(): String
}

/**
 * Firebase's token, minted on first ask. Auto-init is off in the manifest
 * (`firebase_messaging_auto_init_enabled`), so no token exists — and nothing
 * is sent to Firebase — until a driver turns notifications on; turning them on
 * switches auto-init on so Firebase keeps the token fresh from then on.
 */
object FirebasePushTokens : PushTokenSource {
    override suspend fun token(): String = suspendCancellableCoroutine { cont ->
        val messaging = FirebaseMessaging.getInstance()
        messaging.isAutoInitEnabled = true
        messaging.token.addOnCompleteListener { task ->
            if (task.isSuccessful && task.result != null) {
                cont.resume(task.result)
            } else {
                cont.resumeWithException(task.exception ?: IllegalStateException("no FCM token"))
            }
        }
    }
}

/**
 * Keeps this phone's registration on the server in step with the driver's
 * choice (NS-54), the way `BillingController` keeps purchases in step with
 * the session: process-wide on `AppServices`, driven by `MainActivity`'s
 * auth-state collector ([onSignedIn]) and by Firebase's token rotation
 * ([onNewToken], from [CommentMessagingService]).
 *
 * The server keys a device on the session that registered it, so **sign-out
 * needs nothing here** — deleting the session deletes the row — and every
 * sign-in registers again. Registration is a live write; a failure is logged
 * and retried at the next launch or sign-in, never queued.
 */
class PushRegistrar(
    private val scope: CoroutineScope,
    private val register: suspend (token: String) -> Unit,
    private val unregister: suspend () -> Unit,
    private val tokens: PushTokenSource,
    private val isSignedIn: () -> Boolean,
    /** The OS will show a notification: the permission on API 33+, and not switched off. */
    private val notificationsAllowed: () -> Boolean,
    private val prefs: PushPrefs,
) : CommentPushControl {

    /** Serialises register / unregister, so a quick off-on cannot land out of order. */
    private val lock = Mutex()

    override val enabled: StateFlow<Boolean> get() = prefs.enabled
    override val asked: StateFlow<Boolean> get() = prefs.asked

    /** Each time the app becomes signed in — at launch on a stored token, and after sign-in. */
    fun onSignedIn() {
        scope.launch { sync() }
    }

    /** Firebase rotated the token. Registered only if this phone wants notifications. */
    fun onNewToken(token: String) {
        scope.launch {
            lock.withLock {
                if (wanted()) attempt("register") { register(token) }
            }
        }
    }

    override fun setEnabled(on: Boolean) {
        prefs.setEnabled(on)
        prefs.setAsked()
        scope.launch {
            if (on) {
                sync()
            } else {
                lock.withLock { if (isSignedIn()) attempt("unregister") { unregister() } }
            }
        }
    }

    override fun markAsked() = prefs.setAsked()

    private fun wanted() = isSignedIn() && prefs.enabled.value && notificationsAllowed()

    private suspend fun sync() = lock.withLock {
        if (!wanted()) return@withLock
        attempt("register") { register(tokens.token()) }
    }

    private suspend fun attempt(what: String, block: suspend () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Best effort: the next launch or sign-in tries again.
            runCatching { Log.w(TAG, "push $what failed", e) }
        }
    }

    private companion object {
        const val TAG = "PushRegistrar"
    }
}

/**
 * Whether a comment thread offers *Get notified when <name> replies* (NS-54).
 *
 * The moment it means something: a student who has a comment from their coach
 * in front of them, or a coach who has sent one. Never on launch, never once
 * answered (*Not now* included), never when this phone is already on — and
 * on API 32 and below there is no permission to ask, so the card is only the
 * switch it turns on. Split out from the composable so it is plain-JUnit tested.
 */
internal object CommentPushAsk {
    fun shouldOffer(
        isOwner: Boolean,
        hasTheirs: Boolean,
        hasMine: Boolean,
        enabled: Boolean,
        asked: Boolean,
    ): Boolean = !enabled && !asked && (if (isOwner) hasTheirs else hasMine)

    /** Whether *Turn on* has to go through the system prompt first. */
    fun needsPermission(sdkInt: Int, granted: Boolean): Boolean =
        sdkInt >= Build.VERSION_CODES.TIRAMISU && !granted
}
