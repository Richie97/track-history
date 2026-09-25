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
import app.trackevolution.core.model.Vehicle
import app.trackevolution.navigation.GarageBadge
import app.trackevolution.core.model.SteeringFit
import app.trackevolution.core.model.GarageVehicle
import app.trackevolution.core.model.MeasurementDraft
import app.trackevolution.core.model.Part
import app.trackevolution.core.model.PartDraft
import app.trackevolution.core.model.PartEquipDraft
import app.trackevolution.core.model.PartPatch
import app.trackevolution.core.model.PartRefreshDraft
import app.trackevolution.core.model.Patch
import app.trackevolution.core.model.VehiclePatch
import app.trackevolution.ui.LoadState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.launch

/**
 * One car's page (NS-31, NS-37): what it has done — for every account — and for
 * Pro what is fitted, and how much life is left in it.
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

    /**
     * The car itself, from the free `GET /vehicles` (NS-37): what every account
     * sees, and what the *Edit car* form edits.
     */
    var vehicle by mutableStateOf<Vehicle?>(null)
        private set

    /**
     * The same car from `GET /garage` — hours, parts, wear and spend. Null for a
     * free account, which sees the Pro half locked ([proLocked]) rather than the
     * whole page as a paywall.
     */
    var garage by mutableStateOf<GarageVehicle?>(null)
        private set

    /** `/garage` answered 402: the Pro half renders locked, in place. */
    var proLocked by mutableStateOf(false)
        private set

    /** The logbook's events, cached — the free half is reduced from them. */
    var events by mutableStateOf<List<Event>>(emptyList())
        private set

    /** The car was deleted; the screen leaves. */
    var deleted by mutableStateOf(false)
        private set

    var writeError by mutableStateOf<String?>(null)
        private set

    /**
     * The car catalog (#222), fetched once the *Edit car* form asks for it: the
     * picker's rows, and how the form resolves [GarageVehicle.catalogId] to the
     * row the car's numbers came from. A cached GET, so it works offline.
     */
    var catalog by mutableStateOf<List<CatalogCar>?>(null)
        private set

    var catalogError by mutableStateOf<String?>(null)
        private set

    /**
     * The car's per-session steering fits (#223), fetched with the catalog when
     * the *Edit car* form opens. Null until they arrive and null when the read
     * fails — the measured line is then absent, never an error.
     */
    var steeringFits by mutableStateOf<List<SteeringFit>?>(null)
        private set

    /**
     * The free half first, the Pro half alongside (NS-37). `/vehicles` and the
     * cached `/events` decide whether there is a page at all; `/garage` only
     * decides what the Pro sections show, and a 402 from it locks them rather
     * than turning the whole car into a paywall — which is what this used to do,
     * and why a free account's car had no page.
     */
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
                val found = vehicleList.await().firstOrNull { it.id == vehicleId }
                events = eventList.await()
                val pro = garageList.await()
                if (found == null) {
                    state = LoadState.Failed("That car isn't in your garage any more.")
                    return@launch
                }
                vehicle = found
                if (pro != null) {
                    proLocked = false
                    garage = pro.firstOrNull { it.id == vehicleId }
                    GarageBadge.note(pro)
                }
                state = LoadState.Ready
            } catch (e: ApiException) {
                if (vehicle != null) return@launch
                state = LoadState.Failed(e.message ?: "Couldn't load this car.")
            }
        }
    }

    /** One car's logbook (NS-37), reduced from the cached event list. */
    val logbook: Garage.VehicleLogbook
        get() = Garage.vehicleLogbook(vehicleId, events, EventDates.todayIso())

    /**
     * Cascades to the car's parts and measurements. Events keep the free-text
     * car name they were logged with and simply stop being linked. Moved here
     * from Settings (NS-37): delete lives on the car it deletes.
     */
    fun deleteVehicle() {
        scope.launch {
            writeError = null
            try {
                api.deleteVehicle(vehicleId)
                deleted = true
            } catch (e: ApiException) {
                writeError = e.message
            }
        }
    }

    fun dismissWriteError() {
        writeError = null
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

    fun loadSteeringFits() {
        if (steeringFits != null) return
        scope.launch {
            try {
                steeringFits = api.steeringFits(vehicleId).fits
            } catch (_: ApiException) {
                // Nothing to measure from is the same as nothing measured.
            }
        }
    }

    // ---- Derived ------------------------------------------------------------

    /**
     * On the car right now, in the car's own order (pads, tires, rotors,
     * fluids) — `onCarParts` in `public/app.js`. A spare on the shelf isn't
     * wearing, so it is neither here nor in [alerts] until it goes back on.
     */
    val activeParts: List<Part>
        get() = Garage.sortedByKind(garage?.parts.orEmpty().filter(Garage::isOnCar))

    /** Off the car but not retired (migration 0029) — a second set of wheels, the street pads. */
    val spareParts: List<Part>
        get() = Garage.sortedByKind(garage?.parts.orEmpty().filter(Garage::isSpare))

    /** Every part the car has, for the Equipped switch's "this takes off …". */
    val allParts: List<Part>
        get() = garage?.parts.orEmpty()

    val retiredParts: List<Part>
        get() = garage?.parts.orEmpty().filter { it.retiredOn != null }

    /** Everything ever fitted, retired included — what the car has cost you. */
    val spendCents: Int
        get() = garage?.parts.orEmpty().sumOf { it.costCents ?: 0 }

    val alerts: List<Garage.Alert>
        get() = Garage.garageAlerts(garage?.let { listOf(it) })

    // ---- Writes -------------------------------------------------------------

    /**
     * The car itself. Every field the form shows is sent, so a cleared one means
     * cleared — except the default flag, which goes only when it changed: a
     * `false` sent for a default left alone would silently unset it.
     *
     * Renaming matters more than it looks: `events.car` is free text matched to
     * a vehicle **by name** server-side, so a car renamed away from what past
     * events say stops accruing their hours. The form says so.
     */
    fun updateVehicle(
        name: String,
        notes: String,
        targetHotPsi: Double?,
        isDefault: Boolean,
        catalogId: Int? = null,
        wheelbaseMm: Int? = null,
        steeringRatio: Double? = null,
    ) = write {
        val current = vehicle
        api.updateVehicle(
            vehicleId,
            VehiclePatch(
                name = Patch.Set(name.trim()),
                notes = Patch.Set(notes.trim().ifEmpty { null }),
                targetHotPsi = Patch.Set(targetHotPsi),
                isDefault = if (current != null && isDefault != current.isDefault) Patch.Set(isDefault) else Patch.Unchanged,
                // The pick and both numbers together (#222): the server pre-fills
                // only the numbers a body leaves out, and the form never leaves
                // one out, so what is on screen is what gets saved — the pick is
                // recorded as identity.
                catalogId = Patch.Set(catalogId),
                wheelbaseMm = Patch.Set(wheelbaseMm),
                steeringRatio = Patch.Set(steeringRatio),
            ),
        )
    }

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

    /**
     * "Buy another set of those": a fresh copy of a *retired* part's spec,
     * installed on [on] — nothing is retired. On the car by default, taking off
     * whatever shares its place (`swap`); `equipped = false` puts it on the
     * shelf instead.
     */
    fun refreshRetiredPart(id: Int, on: String, equipped: Boolean) =
        write { api.refreshPart(id, PartRefreshDraft(installedOn = on, equipped = equipped, swap = equipped)) }

    /**
     * The Equipped switch (migration 0029), confirmed: on the car → the shelf,
     * or back on, taking off whatever shares its place as of the same day. The
     * server decides what that is; [Garage.equipNote] only said so first.
     */
    fun setEquipped(part: Part, equipped: Boolean, on: String) = write {
        val draft = PartEquipDraft(on = on)
        if (equipped) api.equipPart(part.id, draft) else api.unequipPart(part.id, draft)
    }

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
