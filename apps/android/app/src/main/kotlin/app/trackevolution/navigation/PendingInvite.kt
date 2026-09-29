package app.trackevolution.navigation

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * A coaching invite link (NS-38) that arrived before there was a session to
 * accept it with — held until sign-in, the way `BillingController` holds a
 * purchase Play reported while signed out, rather than dropped.
 *
 * Persisted, unlike [Router]'s in-memory parking, because the arrival that
 * needs it most is the signed-out one: the next thing that happens is a Custom
 * Tab sign-in, and the system is free to destroy this process while the
 * browser is in front. A share link lost that way costs a re-tap; an invite
 * lost that way costs asking the driver for a new one. The web keeps the token
 * in `sessionStorage` for the same reason.
 *
 * Only ever the token of the last link opened — a newer link replaces an older
 * one — and taken ([take]) the moment the signed-in shell sends it to the
 * accept screen, whose route then carries it. Cleared on sign-out, so a link
 * one account opened never lands under the next.
 */
class PendingInvite(context: Context) {

    private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    private val _token = MutableStateFlow(prefs.getString(KEY, null))

    /** The parked token, if any. */
    val token: StateFlow<String?> = _token.asStateFlow()

    fun park(token: String) {
        prefs.edit().putString(KEY, token).apply()
        _token.value = token
    }

    /** The parked token, cleared — so it is acted on exactly once. */
    fun take(): String? {
        val parked = _token.value ?: return null
        clear()
        return parked
    }

    fun clear() {
        prefs.edit().remove(KEY).apply()
        _token.value = null
    }

    private companion object {
        const val FILE = "coaching"
        const val KEY = "pendingInvite"
    }
}
