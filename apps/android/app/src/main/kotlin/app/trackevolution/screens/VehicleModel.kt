package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.trackevolution.core.EventDates
import app.trackevolution.core.Garage
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.GarageVehicle
import app.trackevolution.core.model.MeasurementDraft
import app.trackevolution.core.model.Part
import app.trackevolution.core.model.PartDraft
import app.trackevolution.core.model.PartPatch
import app.trackevolution.core.model.PartRefreshDraft
import app.trackevolution.core.model.Patch
import app.trackevolution.ui.LoadState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.launch

/**
 * One car's garage page (NS-31): what is fitted, how much life is left in it,
 * and the events that wore it out.
 *
 * **Nothing here computes wear.** `GET /api/garage` returns every part with its
 * estimate already computed by `src/lib/wear.ts`; this model fetches, and
 * `Garage` in `:core` decides how to phrase what arrived.
 *
 * **Every write here needs a live server.** Garage writes are deliberately off
 * the offline queue (`QUEUEABLE`) and must stay off it: retiring a part rewrites
 * the wear of every other part on the car, a new part's expected life is
 * defaulted server-side from retired lifecycles, and a refresh is a
 * retire-plus-create whose successor id the client cannot invent. So the garage
 * reads offline — through the cache, like everything else — and does not write.
 */
class VehicleModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    val vehicleId: Int,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set

    var vehicle by mutableStateOf<GarageVehicle?>(null)
        private set

    /** This car's past events — the track-hours ledger. */
    var events by mutableStateOf<List<Event>>(emptyList())
        private set

    var writeError by mutableStateOf<String?>(null)
        private set

    fun load() {
        scope.launch {
            try {
                val garageJob = async { api.garage() }
                val eventsJob = async { runCatching { api.events() }.getOrDefault(events) }
                val found = garageJob.await().firstOrNull { it.id == vehicleId }
                val allEvents = eventsJob.await()
                if (found == null) {
                    state = LoadState.Failed("That car isn't in your garage any more.")
                    return@launch
                }
                vehicle = found
                // Upcoming events have not been driven, so their hours have not
                // been accrued — the server's wear window excludes them too.
                events = allEvents.filter {
                    it.vehicleId == vehicleId && !EventDates.isUpcoming(it.startDate)
                }
                state = LoadState.Ready
            } catch (e: ApiException) {
                if (vehicle == null) state = LoadState.Failed(e.message ?: "Couldn't load this car.")
            }
        }
    }

    fun dismissWriteError() {
        writeError = null
    }

    // ---- Derived ------------------------------------------------------------

    val activeParts: List<Part>
        get() = vehicle?.parts.orEmpty().filter { it.retiredOn == null }

    val retiredParts: List<Part>
        get() = vehicle?.parts.orEmpty().filter { it.retiredOn != null }

    /** Everything ever fitted, retired included — what the car has cost you. */
    val spendCents: Int
        get() = vehicle?.parts.orEmpty().sumOf { it.costCents ?: 0 }

    val alerts: List<Garage.Alert>
        get() = Garage.garageAlerts(vehicle?.let { listOf(it) })

    // ---- Writes -------------------------------------------------------------

    fun addPart(draft: PartDraft) = write { api.createPart(vehicleId, draft) }

    fun updatePart(id: Int, patch: PartPatch) = write { api.updatePart(id, patch) }

    fun deletePart(id: Int) = write { api.deletePart(id) }

    /**
     * Retire as of today. Kept apart from the edit form because it is the one
     * lifecycle change with a single obvious date, and making the user open a
     * form to type today's date is the kind of friction that stops it happening
     * at all.
     */
    fun retirePart(id: Int, on: String = EventDates.todayIso()) =
        write { api.updatePart(id, PartPatch(retiredOn = Patch.Set(on))) }

    /**
     * One-tap replacement: the server retires this part as of the swap date and
     * inserts a same-spec successor. The successor's id is the server's to
     * invent, which is one of the reasons this cannot be queued offline.
     */
    fun refreshPart(id: Int, on: String = EventDates.todayIso()) =
        write { api.refreshPart(id, PartRefreshDraft(installedOn = on)) }

    fun addMeasurement(partId: Int, draft: MeasurementDraft) =
        write { api.addMeasurement(partId, draft) }

    fun deleteMeasurement(partId: Int, id: Int) = write { api.deleteMeasurement(partId, id) }

    /**
     * A failed write never blanks the page — the car behind it is still there,
     * and a rejected measurement should not cost you the parts list. The
     * server's own message is what gets shown.
     */
    private fun write(block: suspend () -> Unit) {
        scope.launch {
            writeError = null
            try {
                block()
            } catch (e: ApiException) {
                writeError = e.message
            }
            load()
        }
    }
}
