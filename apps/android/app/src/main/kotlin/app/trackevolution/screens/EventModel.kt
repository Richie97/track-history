package app.trackevolution.screens

import app.trackevolution.core.AICoach

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.trackevolution.core.Balance
import app.trackevolution.core.CompareLaps
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

    /**
     * Keeps an AI Coach reply (#320): appended, labelled, to the session's
     * notes for a debrief ([sessionId]) or the event's otherwise — through the
     * same free, queueable writes the edit forms use. Throws the write's
     * [ApiException], which the sheet says beside its button.
     */
    suspend fun keepCoachReply(sessionId: Int?, reply: String) {
        val current = detail ?: api.event(eventId)
        val today = java.time.LocalDate.now()
        if (sessionId != null) {
            val existing = current.sessions.firstOrNull { it.id == sessionId }?.notes
            api.updateSession(sessionId, SessionPatch(notes = Patch.Set(AICoach.appendCoachNote(existing, reply, today))))
        } else {
            api.updateEvent(eventId, EventPatch(notes = Patch.Set(AICoach.appendCoachNote(current.event.notes, reply, today))))
        }
        load()
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

    // ---- Share one event or session (NS-48) ----------------------------------
    //
    // Live, never queued: the link is the server's answer. The dialog words a
    // Transport failure as "Sharing needs a connection." (`ItemShareText`).

    val sharing = ItemShareState.over(scope, api)

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
 * One cell of a session's stats strip: a small label over a figure — or, with
 * [text], over a short sentence ("ABS in 3 places").
 */
data class SessionStat(
    val key: String,
    val label: String,
    val value: String,
    val note: String? = null,
    val tone: Tone? = null,
    val text: Boolean = false,
) {
    enum class Tone { Warn, Good }

    val spoken: String get() = listOfNotNull(label, value, note).joinToString(", ")
}

/**
 * The stats strip under a session header — `lapStatItems` in
 * `public/js/session-stats.js` plus what the channel data adds, the same items
 * under the same labels as the web's and iOS's. It used to be one " · "-joined
 * sentence.
 */
fun Session.statItems(units: UnitSystem): List<SessionStat> {
    val laps = lapTimesMs
    val items = mutableListOf<SessionStat>()
    LapStats.bestNAvg(laps, 3)?.let { items += SessionStat("best3", "Best 3 avg", LapTime.fmtMs(it)) }
    LapStats.warmupLapCount(laps)?.let { items += SessionStat("warmup", "Up to speed", "Lap $it") }
    channels?.let { ch ->
        // What stringing the session's best sectors together would have been
        // worth (`Sectors`, #146); the splits themselves are in the panel.
        Sectors.sessionSectors(ch)?.takeIf { it.laps.size >= 2 && it.gapMs > 0 }
            ?.let { items += SessionStat("theoretical", "Theoretical best", LapTime.fmtMs(it.theoreticalBestMs)) }
        // The session's top speed and peak cornering G — `peakStatItems` on the
        // web: the highest of each lap's `CompareLaps.lapMetrics`.
        val metrics = ch.laps.map(CompareLaps::lapMetrics)
        metrics.mapNotNull { it.topSpeedKph }.maxOrNull()
            ?.let { items += SessionStat("topSpeed", "Top speed", Units.fmtSpeedKph(it, units)) }
        metrics.mapNotNull { it.maxLatG }.maxOrNull()
            ?.let { items += SessionStat("maxG", "Max G", String.format("%.2f G", it)) }
        // Which way the car leaned, and in which corners (`Balance`, #189).
        Balance.balanceTendency(ch)?.let { items += SessionStat("balance", "Balance", it.value, it.note) }
        // Where the car hit its limit (`Limits`, #188), as a short sentence.
        Limits.limitSummary(ch)?.let { items += SessionStat("limits", "Limits", it, text = true) }
    }
    return items
}
