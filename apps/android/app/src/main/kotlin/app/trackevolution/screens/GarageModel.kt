package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.trackevolution.core.EventDates
import app.trackevolution.core.Garage
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.CatalogCar
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.GarageVehicle
import app.trackevolution.core.model.Vehicle
import app.trackevolution.core.model.VehicleDraft
import app.trackevolution.navigation.GarageBadge
import app.trackevolution.ui.LoadState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.launch

/**
 * The Garage tab's data (NS-37): a tile per car, for every account.
 *
 * The free half is `/vehicles` plus the cached `/events`, reduced per car by
 * `:core`'s [Garage.vehicleLogbook] — no endpoint of its own, so it works
 * offline. The Pro half is `GET /garage`, fetched **alongside** and allowed to
 * fail: a 402 is not an error here, it locks the Pro half ([proLocked]) while
 * the tiles render from the free list — the whole-screen paywall this tab
 * replaces is exactly what NS-37 was written to remove.
 *
 * Adding a car needs a live server: vehicle writes are off the offline queue
 * (a duplicate name is a 409, and the first car is made default server-side).
 */
class GarageModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set

    var vehicles by mutableStateOf<List<Vehicle>>(emptyList())
        private set

    var events by mutableStateOf<List<Event>>(emptyList())
        private set

    /** Null until it arrives, and null when it is locked or failed. */
    var garage by mutableStateOf<List<GarageVehicle>?>(null)
        private set

    /** `/garage` answered 402: the Pro half renders locked, in place. */
    var proLocked by mutableStateOf(false)
        private set

    /** The car catalog, for each tile's catalog label and the add form's picker. */
    var catalog by mutableStateOf<List<CatalogCar>?>(null)
        private set

    var catalogError by mutableStateOf<String?>(null)
        private set

    var addError by mutableStateOf<String?>(null)
        private set

    var adding by mutableStateOf(false)
        private set

    fun load() {
        scope.launch {
            try {
                val vehicleList = async { api.vehicles() }
                val eventList = async { api.events() }
                val garageList = async {
                    try {
                        api.garage()
                    } catch (e: ApiException) {
                        if (e.isPaymentRequired) proLocked = true
                        null
                    }
                }
                vehicles = vehicleList.await()
                events = eventList.await()
                garage = garageList.await()?.also {
                    proLocked = false
                    GarageBadge.note(it)
                }
                state = LoadState.Ready
            } catch (e: ApiException) {
                // A reload over data already on screen keeps it.
                if (state != LoadState.Ready) state = LoadState.Failed(e.message ?: "Couldn't load your garage.")
            }
            if (catalog == null) catalog = runCatching { api.carCatalog() }.getOrNull()
        }
    }

    fun loadCatalog() {
        if (catalog != null) return
        scope.launch {
            catalogError = null
            try {
                catalog = api.carCatalog()
            } catch (e: ApiException) {
                catalogError = e.message ?: "Couldn't load the car catalog."
            }
        }
    }

    /**
     * The offline layer's status: `offline` means the last request failed at
     * the network level, so a vehicle write would too. The cheap signal the add
     * tile reads to disable itself rather than fail on submit.
     */
    val syncStatus get() = api.syncStatus

    /** One car's logbook, reduced from the cached event list. */
    fun logbook(vehicleId: Int): Garage.VehicleLogbook =
        Garage.vehicleLogbook(vehicleId, events, EventDates.todayIso())

    fun garageFor(vehicleId: Int): GarageVehicle? = garage?.firstOrNull { it.id == vehicleId }

    fun catalogRow(vehicle: Vehicle): CatalogCar? =
        vehicle.catalogId?.let { id -> catalog?.firstOrNull { it.id == id } }

    val alerts: List<Garage.Alert>
        get() = Garage.garageAlerts(garage)

    /**
     * Add a car. The pick alone goes with the name: the server pre-fills both
     * numbers from the catalog row. [onCreated] gets the new id, which is where
     * the web goes next too — the car's own page.
     */
    fun addVehicle(
        name: String,
        notes: String,
        isDefault: Boolean,
        catalogId: Int?,
        onCreated: (Int) -> Unit,
    ) {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return
        scope.launch {
            adding = true
            addError = null
            try {
                val created = api.createVehicle(
                    VehicleDraft(
                        name = trimmed,
                        notes = notes.trim().ifEmpty { null },
                        // Only when asked: the server already makes the first car the default.
                        isDefault = if (isDefault) true else null,
                        catalogId = catalogId,
                    ),
                )
                load()
                onCreated(created.id)
            } catch (e: ApiException) {
                addError = e.message ?: "Couldn't add that car."
            } finally {
                adding = false
            }
        }
    }

    fun dismissAddError() {
        addError = null
    }
}
