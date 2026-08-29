package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.trackevolution.auth.ChecklistTemplateStore
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.Patch
import app.trackevolution.core.model.User
import app.trackevolution.core.model.Vehicle
import app.trackevolution.core.model.VehicleDraft
import app.trackevolution.core.model.VehiclePatch
import app.trackevolution.ui.LoadState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Settings' data: who you are, the public share link, the prep-checklist
 * template, and the garage's vehicle list (NS-26).
 *
 * Two things here are deliberately **not** on the offline queue, and so surface
 * the server's own message rather than succeeding locally:
 *
 *  - **The share slug** is claimed against every other user's, so only the
 *    server can say whether it is yours.
 *  - **Vehicle writes** are off the queue by the same rule the garage follows
 *    (NS-31): a duplicate name is a 409, and the first car in an empty garage is
 *    made default server-side.
 */
class SettingsModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    /**
     * The account's checklist template, so the list written here and the one the
     * event page reads are one value rather than two copies that drift.
     */
    private val template: ChecklistTemplateStore,
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

    var vehicles by mutableStateOf<List<Vehicle>>(emptyList())
        private set

    var newVehicleName by mutableStateOf("")

    /**
     * Kept apart from [shareError] on purpose: a rejected slug and a duplicate
     * vehicle name are half a screen apart, and one message overwriting the
     * other would point at the wrong field.
     */
    var vehicleError by mutableStateOf<String?>(null)
        private set

    var checklistError by mutableStateOf<String?>(null)
        private set

    /** The per-track leaderboard opt-in, mirrored from `/me`. */
    var leaderboardOptIn by mutableStateOf(false)
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
                pendingWrites = api.syncStatus.value.pending
                state = LoadState.Ready
            } catch (e: ApiException) {
                if (user == null) state = LoadState.Failed(e.message ?: "Couldn't load your account.")
                return@launch
            }
            // A section, not the screen: an empty or failing garage must not take
            // the account and the legal links down with it.
            vehicles = runCatching { api.vehicles() }.getOrDefault(vehicles)
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
            leaderboardOptIn = optIn
            try {
                api.setLeaderboardOptIn(optIn)
            } catch (e: ApiException) {
                leaderboardOptIn = previous
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

    // ---- Vehicles ----------------------------------------------------------

    /** The first car in an empty garage becomes the default server-side. */
    fun addVehicle() {
        val name = newVehicleName.trim()
        if (name.isEmpty()) return
        vehicleWrite {
            api.createVehicle(VehicleDraft(name = name))
            newVehicleName = ""
        }
    }

    fun makeDefault(id: Int) = vehicleWrite {
        api.updateVehicle(id, VehiclePatch(isDefault = Patch.Set(true)))
    }

    /**
     * Rename a car, or change its notes. Both are always sent: the edit form
     * shows what is stored, so a cleared field means cleared.
     *
     * Renaming matters more than it looks — `events.car` is free text matched to
     * a vehicle **by name** server-side, so a car renamed away from what past
     * events say stops accruing their hours. The form says so.
     */
    fun updateVehicle(id: Int, name: String, notes: String) = vehicleWrite {
        api.updateVehicle(
            id,
            VehiclePatch(
                name = Patch.Set(name.trim()),
                notes = Patch.Set(notes.trim().ifEmpty { null }),
            ),
        )
    }

    /**
     * Cascades to the car's parts and measurements. Events keep the free-text car
     * name they were logged with and simply stop being linked.
     */
    fun deleteVehicle(id: Int) = vehicleWrite { api.deleteVehicle(id) }

    private fun vehicleWrite(block: suspend () -> Unit) {
        scope.launch {
            vehicleError = null
            try {
                block()
                vehicles = runCatching { api.vehicles() }.getOrDefault(vehicles)
            } catch (e: ApiException) {
                vehicleError = e.message
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
