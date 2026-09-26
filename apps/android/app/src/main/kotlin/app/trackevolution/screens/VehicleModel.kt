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
import app.trackevolution.core.model.PartMountDraft
import app.trackevolution.core.model.PartPatch
import app.trackevolution.core.model.PartRefreshDraft
import app.trackevolution.core.model.Patch
import app.trackevolution.core.model.VehiclePatch
import app.trackevolution.ui.LoadState
import kotlinx.coroutines.CancellationException
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

    /**
     * The edit form's save (migration 0030): the part's own fields, then — when
     * the form moved when it went on the car, or where in that day — the mount
     * edit, which also moves whatever came off at the old point and, for a part
     * fitted the day it was installed, the install date. Two writes in order,
     * so the mount moves against the part's saved dates.
     */
    fun editPart(id: Int, patch: PartPatch, mount: PartMountDraft?) = write {
        api.updatePart(id, patch)
        if (mount != null) api.editPartMount(id, mount)
    }

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
     * One-tap replacement, sent with no fields: the server retires this part now
     * and inserts a same-spec successor — at the track, after the last session
     * logged so far (migration 0030); the new part's edit form corrects that. The successor's id is the server's to
     * invent, which is one of the reasons this cannot be queued offline.
     */
    fun refreshPart(id: Int) = write { api.refreshPart(id) }

    /**
     * "Buy another set of those": a fresh copy of a *retired* part's spec,
     * installed on [on] — nothing is retired. On the car by default, taking off
     * whatever shares its place (`swap`); `equipped = false` puts it on the
     * shelf instead.
     */
    fun refreshRetiredPart(id: Int, on: String, equipped: Boolean) =
        write { api.refreshPart(id, PartRefreshDraft(installedOn = on, equipped = equipped, swap = equipped)) }

    /**
     * The Equipped switch turning on (migration 0029): one tap, no fields — today,
     * at the server's point in the day (migration 0030) — taking off whatever
     * shares its place. The server decides what that is.
     */
    fun equip(part: Part) = write { api.equipPart(part.id) }

    /**
     * The Equipped switch turning off, confirmed: to the shelf as of [on], at
     * [afterSessionId] — [Patch.Unchanged] when the date is not a track day (the
     * server's rule), `Set(null)` for the event's start, `Set(id)` after that
     * session.
     */
    fun takeOff(part: Part, on: String, afterSessionId: Patch<Int> = Patch.Unchanged) =
        write { api.unequipPart(part.id, PartEquipDraft(on = on, afterSessionId = afterSessionId)) }

    /** The "When in the day" picker's rows, and the one the server would pick unasked. */
    data class SwapOptions(val choices: List<Garage.SwapSessionChoice>, val defaultId: Int?)

    /**
     * The picker for a swap on [date] (migration 0030): this car's event
     * covering the date — [Garage.swapSessionEvent] over the cached events —
     * and that event's sessions, read from its detail, as
     * [Garage.swapSessionChoices] (the start, then after each session) with
     * [Garage.defaultSwapChoice]. Null when no event covers the date or its
     * detail can't be read: the picker is hidden and the request leaves
     * `after_session_id` out, as the web page's `bindSwapSessions` does.
     */
    suspend fun swapOptions(date: String): SwapOptions? {
        val day = date.trim().takeIf { it.length == 10 && EventDates.epochDay(it) != null } ?: return null
        val event = Garage.swapSessionEvent(vehicleId, day, events) ?: return null
        val detail = try {
            api.event(event.id)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return null
        }
        return SwapOptions(Garage.swapSessionChoices(detail.sessions), Garage.defaultSwapChoice(detail.sessions))
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
