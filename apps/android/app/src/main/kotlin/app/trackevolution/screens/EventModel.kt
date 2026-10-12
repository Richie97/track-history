package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.trackevolution.core.Balance
import app.trackevolution.core.Gears
import app.trackevolution.core.Health
import app.trackevolution.core.LapStats
import app.trackevolution.core.LapTime
import app.trackevolution.core.Limits
import app.trackevolution.core.Units
import app.trackevolution.core.Sectors
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.ChecklistItem
import app.trackevolution.core.model.EventDetail
import app.trackevolution.core.model.EventPatch
import app.trackevolution.core.model.GarageVehicle
import app.trackevolution.core.model.Patch
import app.trackevolution.core.model.Session
import app.trackevolution.core.model.SessionDraft
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.model.SessionPatch
import app.trackevolution.core.model.SetupSheet
import app.trackevolution.core.model.Track
import app.trackevolution.ui.LoadState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/**
 * One event: its sessions, laps and checklist (NS-26).
 *
 * Every write goes through [write], which captures the server's own message into
 * [writeError] and re-reads afterwards. Two properties of that matter:
 *
 *  - **A failed write does not clear the screen.** If the re-read also fails,
 *    the current content stays — the user is looking at an event, and losing it
 *    because a lap failed to save would be the wrong trade.
 *  - **Every one of these mutations is on the offline whitelist** (NS-22), so
 *    they work in a paddock and replay in order. There is no separate offline
 *    path, because `ApiClient` *is* the offline layer.
 */
class EventModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    eventId: Int,
) {
    /**
     * Mutable: an event created offline carries a temp id, and when the queue
     * flushes it becomes a real one. A screen parked on the old id would 404 on
     * its next refresh.
     */
    var eventId: Int = eventId
        private set

    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set

    var detail by mutableStateOf<EventDetail?>(null)
        private set

    var track by mutableStateOf<Track?>(null)
        private set

    var writeError by mutableStateOf<String?>(null)
        private set

    var isDeleted by mutableStateOf(false)
        private set

    /**
     * The garage, for the setup notebook (NS-40): the event's car's parts name
     * the sheet's part references, and its target hot pressure closes the
     * pressure loop. Read only when the notebook is shown, and its failure is
     * swallowed — a sheet reads fine without part names.
     */
    var garage by mutableStateOf<List<GarageVehicle>?>(null)
        private set

    fun load() {
        scope.launch {
            try {
                // A scope of its own, so a failed fetch reaches the catch below
                // rather than failing the launch — an uncaught failure there
                // crashes the app.
                coroutineScope {
                    val eventJob = async { api.event(eventId) }
                    val tracksJob = async { api.tracks() }
                    val loaded = eventJob.await()
                    detail = loaded
                    track = tracksJob.await().firstOrNull { it.id == loaded.event.trackId }
                    state = LoadState.Ready
                }
            } catch (e: ApiException) {
                // Only blank the screen if there is nothing to show; a refresh
                // that fails over real content leaves the content.
                if (detail == null) state = LoadState.Failed(e.message ?: "Couldn't load this event.")
            }
        }
    }

    /** Follow an offline-created event to its real id once the queue flushes. */
    fun adoptResolvedId() {
        scope.launch {
            val resolved = api.resolveTempId(eventId) ?: return@launch
            eventId = resolved
            load()
        }
    }

    fun dismissWriteError() {
        writeError = null
    }

    // ---- Sessions and laps -------------------------------------------------

    fun addSession(label: String?, notes: String?, laps: List<Int>) = write {
        api.createSession(
            eventId,
            SessionDraft(
                label = label?.takeIf { it.isNotBlank() },
                notes = notes?.takeIf { it.isNotBlank() },
                laps = laps,
            ),
        )
    }

    /**
     * The edit sheet sends both fields as they now read — `Patch.Set(null)` for
     * an emptied one, which clears it. The server writes only the keys present
     * (NS-40), so a caller that passes [Patch.Unchanged] leaves that column alone.
     */
    fun updateSession(id: Int, label: String?, notes: String?) = write {
        api.updateSession(
            id,
            SessionPatch(
                label = Patch.Set(label?.trim()?.takeIf { it.isNotEmpty() }),
                notes = Patch.Set(notes?.trim()?.takeIf { it.isNotEmpty() }),
            ),
        )
    }

    fun deleteSession(id: Int) = write { api.deleteSession(id) }

    fun appendLaps(sessionId: Int, laps: List<Int>) = write { api.appendLaps(sessionId, laps) }

    fun deleteLap(id: Int) = write { api.deleteLap(id) }

    // ---- Setup notebook (NS-40) ---------------------------------------------

    fun loadGarage() {
        scope.launch {
            try {
                garage = api.garage()
            } catch (_: ApiException) {
                // Offline with nothing cached, or a lapsed tier: the notebook
                // shows the sheets without part names or a target.
            }
        }
    }

    /**
     * A day's sheet, written whole — the loop's *Record hot pressures*. Queueable,
     * so it saves in the paddock with no signal and replays.
     */
    fun saveSetup(day: Int, sheet: SetupSheet) = write { api.putSetup(eventId, day, sheet) }

    // ---- Checklist ---------------------------------------------------------

    /**
     * The checklist is written whole, as the web app does — the API takes the
     * array, not a diff. An empty list is sent as null, which is how the server
     * spells "no checklist" rather than "an empty one".
     */
    fun setChecklist(items: List<ChecklistItem>) = write {
        api.updateEvent(eventId, EventPatch(checklist = Patch.Set(items.ifEmpty { null })))
    }

    fun deleteEvent() {
        scope.launch {
            try {
                api.deleteEvent(eventId)
                isDeleted = true
            } catch (e: ApiException) {
                writeError = e.message
            }
        }
    }

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

/** The lap times of a session, in running order — what `LapStats` expects. */
val Session.lapTimesMs: List<Int> get() = laps.map { it.timeMs }

val Session.bestLapMs: Int? get() = laps.minOfOrNull { it.timeMs }

/**
 * The one-line pace summary under a session header, plus — for a session with
 * channel data — the theoretical best lap from its sector splits (`Sectors`,
 * #146), when stringing the best sectors together would beat the best lap.
 * The splits themselves are in the channel panel below.
 */
fun Session.statsSummary(units: UnitSystem): String? {
    val sec = channels?.let { Sectors.sessionSectors(it) }
    val theoretical = sec?.takeIf { it.laps.size >= 2 && it.gapMs > 0 }
        ?.let { "theoretical best ${LapTime.fmtMs(it.theoreticalBestMs)}" }
    // The typical upshift rpm across the session (`Gears`, #187); the
    // per-gear breakdown sits in the channel panel's Inputs tab.
    val upshifts = channels?.let { Gears.shiftPoints(it) }
        ?.let { "upshifts ≈ ${Gears.fmtRpm(it.medianRpm.toDouble())} rpm" }
    // Where the car hit its limit (`Limits`, #188), counted as places on
    // track across the session. The marks themselves are on the best-lap
    // trace and shaded on the pedal traces.
    val limits = channels?.let { Limits.limitSummary(it) }
    // The corners whose rotation sits off this car's typical response
    // (`Balance`, #189), pooled across the session; the per-corner table and
    // the scatter are on the channel panel's Grip tab.
    val balance = channels?.let { Balance.balanceSummary(it) }
    // What the car was doing (`Health`, #190): any figure past its line and
    // the fuel outlook; the cards themselves are on the panel's Car tab.
    val health = channels?.let { Health.healthSummary(it, Units.healthUnits(units)) }
    return listOfNotNull(LapStats.summary(lapTimesMs), theoretical, upshifts, limits, balance, health)
        .takeIf { it.isNotEmpty() }
        ?.joinToString(" · ")
}
