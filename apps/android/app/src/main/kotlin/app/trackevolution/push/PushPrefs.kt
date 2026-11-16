package app.trackevolution.push

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * This install's two coach-comment notification facts (NS-54): whether the
 * driver turned notifications on here, and whether the in-context ask has been
 * answered — so a *Not now* is never asked again.
 *
 * Per install, not per account (a coach with two phones decides per phone),
 * and kept out of backup and device transfer by both backup XMLs: a restored
 * *on* would claim notifications on a phone that has never registered a token
 * or been asked for the permission.
 */
class PushPrefs(context: Context) {

    private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    private val _enabled = MutableStateFlow(prefs.getBoolean(KEY_ENABLED, false))
    private val _asked = MutableStateFlow(prefs.getBoolean(KEY_ASKED, false))

    val enabled: StateFlow<Boolean> = _enabled.asStateFlow()
    val asked: StateFlow<Boolean> = _asked.asStateFlow()

    fun setEnabled(on: Boolean) {
        prefs.edit().putBoolean(KEY_ENABLED, on).apply()
        _enabled.value = on
    }

    fun setAsked() {
        prefs.edit().putBoolean(KEY_ASKED, true).apply()
        _asked.value = true
    }

    companion object {
        /** The SharedPreferences file — named in both backup XMLs. */
        const val FILE = "push"
        private const val KEY_ENABLED = "commentNotifications"
        private const val KEY_ASKED = "asked"
    }
}
