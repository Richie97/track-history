package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.trackevolution.auth.ChecklistTemplateStore
import app.trackevolution.auth.UnitsStore
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.Garage
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.Patch
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.model.User
import app.trackevolution.ui.LoadState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Settings' data: who you are, the public share link, the prep-checklist
 * template and the rest of the account (NS-26). The cars moved to the Garage tab
 * (NS-37).
 *
 * One thing here is deliberately **not** on the offline queue, and so surface
 * the server's own message rather than succeeding locally:
 *
 *  - **The share slug** is claimed against every other user's, so only the
 *    server can say whether it is yours.
 */
class SettingsModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    /**
     * The account's checklist template, so the list written here and the one the
     * event page reads are one value rather than two copies that drift.
     */
    private val template: ChecklistTemplateStore,
    /**
     * The account's unit system, for the same reason: the toggle here and every
     * chart reading `LocalUnitSystem` are one value.
     */
    private val unitsStore: UnitsStore,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set

    var user by mutableStateOf<User?>(null)
        private set

    var slug by mutableStateOf<String?>(null)
        private set

    var slugDraft by mutableStateOf("")

    var shareError by mutableStateOf<String?>(null)
        private set

    var checklistError by mutableStateOf<String?>(null)
        private set

    var unitsError by mutableStateOf<String?>(null)
        private set

    /** The per-track leaderboard opt-in, mirrored from `/me`. */
    var leaderboardOptIn by mutableStateOf(false)

    /** The lap-sharing consent stacked on it (NS-35), mirrored from `/me`. */
    var leaderboardShareLaps by mutableStateOf(false)
        private set

    var leaderboardError by mutableStateOf<String?>(null)
        private set

    var newChecklistItem by mutableStateOf("")

    /** Writes still waiting to reach the server — signing out discards them. */
    var pendingWrites by mutableStateOf(0)
        private set

    fun load() {
        scope.launch {
            try {
                val me = api.me()
                user = me.user
                slug = me.user.shareSlug
                slugDraft = me.user.shareSlug.orEmpty()
                leaderboardOptIn = me.user.leaderboardOptIn
                leaderboardShareLaps = me.user.leaderboardShareLaps
                pendingWrites = api.syncStatus.value.pending
                state = LoadState.Ready
            } catch (e: ApiException) {
                if (user == null) state = LoadState.Failed(e.message ?: "Couldn't load your account.")
                return@launch
            }
        }
    }

    // ---- Leaderboards --------------------------------------------------------

    /**
     * Join or leave the per-track leaderboards. A live write on purpose — never
     * queued offline: publishing your name shouldn't replay silently later. On
     * failure the toggle snaps back rather than lying about the state.
     */
    // Not `setLeaderboardOptIn`: that JVM signature already belongs to the
    // property's generated setter, and the clash fails the build.
    fun updateLeaderboardOptIn(optIn: Boolean) {
        scope.launch {
            leaderboardError = null
            val previous = leaderboardOptIn
            val previousShare = leaderboardShareLaps
            leaderboardOptIn = optIn
            // Leaving the board clears lap sharing server-side, so the second
            // toggle follows rather than showing a consent no longer stored.
            if (!optIn) leaderboardShareLaps = false
            try {
                api.setLeaderboardOptIn(optIn, shareLaps = optIn && leaderboardShareLaps)
            } catch (e: ApiException) {
                leaderboardOptIn = previous
                leaderboardShareLaps = previousShare
                leaderboardError = e.message
            }
        }
    }

    /**
     * Publish the ranked lap itself, or stop (NS-35). A second consent, never
     * implied by the opt-in, and a live write for the same reason: publishing
     * your telemetry should not replay silently later.
     */
    fun updateLeaderboardShareLaps(share: Boolean) {
        scope.launch {
            leaderboardError = null
            val previous = leaderboardShareLaps
            leaderboardShareLaps = share
            try {
                api.setLeaderboardOptIn(true, shareLaps = share)
            } catch (e: ApiException) {
                leaderboardShareLaps = previous
                leaderboardError = e.message
            }
        }
    }

    // ---- The prep-checklist template ---------------------------------------

    fun addChecklistItem() {
        val text = newChecklistItem.trim()
        if (text.isEmpty()) return
        writeChecklist(template.items + text) { newChecklistItem = "" }
    }

    fun removeChecklistItem(index: Int) {
        val next = template.items.toMutableList()
        if (index !in next.indices) return
        next.removeAt(index)
        writeChecklist(next)
    }

    fun moveChecklistItem(index: Int, offset: Int) {
        val next = template.items.toMutableList()
        val target = index + offset
        if (index !in next.indices || target !in next.indices) return
        val moved = next[index]
        next[index] = next[target]
        next[target] = moved
        writeChecklist(next)
    }

    /**
     * Back to the app's built-in list. Sending an empty list is what clears the
     * stored one — see `sanitizeChecklistTemplate`.
     */
    fun resetChecklistTemplate() = writeChecklist(emptyList())

    private fun writeChecklist(items: List<String>, onSuccess: () -> Unit = {}) {
        scope.launch {
            checklistError = null
            try {
                template.set(items)
                onSuccess()
            } catch (e: ApiException) {
                checklistError = e.message
            }
        }
    }

    // ---- Units ---------------------------------------------------------------

    /** The system the logbook is shown in, as the toggle reads it. */
    val units: UnitSystem get() = unitsStore.units

    /**
     * Choose imperial or metric. A live write, like the template: a preference
     * the server refused is shown with its reason, never queued. Nothing already
     * logged changes — the same numbers are converted at the edges.
     */
    fun updateUnits(units: UnitSystem) {
        if (units == unitsStore.units) return
        scope.launch {
            unitsError = null
            try {
                unitsStore.set(units)
            } catch (e: ApiException) {
                unitsError = e.message
            }
        }
    }

    // ---- The public share link ---------------------------------------------

    fun saveSlug() {
        scope.launch {
            shareError = null
            try {
                val saved = api.shareSlug(slugDraft.trim())
                slug = saved
                slugDraft = saved
            } catch (e: ApiException) {
                shareError = e.message
            }
        }
    }

    fun disableShare() {
        scope.launch {
            shareError = null
            try {
                api.clearShare()
                slug = null
                slugDraft = ""
            } catch (e: ApiException) {
                shareError = e.message
            }
        }
    }

    fun shareUrl(serverUrl: String): String? =
        slug?.let { "${serverUrl.trimEnd('/')}/share/$it" }
}
