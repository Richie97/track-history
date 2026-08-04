package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.SavedStateHandle
import app.trackevolution.core.EventDates
import app.trackevolution.navigation.SavedState
import app.trackevolution.core.LapTime
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.Conditions
import app.trackevolution.core.model.EventDraft
import app.trackevolution.core.model.EventPatch
import app.trackevolution.core.model.Patch
import app.trackevolution.ui.LoadState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.launch

/**
 * The new/edit event form (NS-26).
 *
 * **The track name is trimmed of whitespace and otherwise left exactly as
 * typed.** No case normalisation, no punctuation tidying, no title-casing. The
 * name carries the layout — "Virginia International Raceway (Full)" against
 * "(Patriot)" — and the server matches `COLLATE NOCASE` to find or create the
 * track. Normalising here merges two layouts' personal bests into one, silently,
 * with no undo. This is the single most destructive thing this screen could do,
 * which is why it does nothing.
 */
class EventFormModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    /** Null for a new event. */
    val editId: Int? = null,
    presetTrack: String? = null,
    /**
     * Where the draft is kept so it survives the system killing the app in the
     * background. Null in tests, which is the only place it isn't wanted: every
     * field below then behaves as a plain Compose state.
     */
    private val saved: SavedStateHandle? = null,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set

    var trackName by SavedState(saved, "trackName", presetTrack.orEmpty())
    var startDate by SavedState(saved, "startDate", EventDates.todayIso())
    var days by SavedState(saved, "days", "2")
    var trackHours by SavedState(saved, "trackHours", "")
    var club by SavedState(saved, "club", "")
    var runGroup by SavedState(saved, "runGroup", "")
    var car by SavedState(saved, "car", "")
    var tempF by SavedState(saved, "tempF", "")
    var bestTime by SavedState(saved, "bestTime", "")
    var notes by SavedState(saved, "notes", "")

    /**
     * Stored as the string it is spelled with on the wire, because [Conditions]
     * is a value class and a `SavedStateHandle` holds Bundle values.
     */
    private var conditionsRaw by SavedState<String?>(saved, "conditions", null)

    var conditions: Conditions?
        get() = conditionsRaw?.let { Conditions(it) }
        set(value) {
            conditionsRaw = value?.rawValue
        }

    /**
     * Whether the form has already been filled in once.
     *
     * **Load-bearing on the edit path.** [load] runs again after process death,
     * and without this it would overwrite a restored draft with the server's copy
     * — silently discarding the changes the restore existed to preserve.
     */
    private var hydrated by SavedState(saved, "hydrated", false)

    /** Own track names first, then catalog names not already among them. */
    var trackOptions by mutableStateOf<List<String>>(emptyList())
        private set

    var carOptions by mutableStateOf<List<String>>(emptyList())
        private set

    var error by mutableStateOf<String?>(null)
        private set

    var saving by mutableStateOf(false)
        private set

    /** Set to the event's id once a save succeeds, so the screen can navigate. */
    var savedId by mutableStateOf<Int?>(null)
        private set

    fun load() {
        scope.launch {
            try {
                val tracksJob = async { api.tracks() }
                val catalogJob = async { runCatching { api.catalog() }.getOrDefault(emptyList()) }
                val vehiclesJob = async { runCatching { api.vehicles() }.getOrDefault(emptyList()) }
                val editJob = editId?.let { id -> async { api.event(id) } }

                val own = tracksJob.await().map { it.name }
                val seen = own.map { it.lowercase() }.toSet()
                trackOptions = own + catalogJob.await().map { it.name }.filter { it.lowercase() !in seen }

                val vehicles = vehiclesJob.await()
                carOptions = vehicles.map { it.name }

                val existing = editJob?.await()?.event
                if (hydrated) {
                    // A restored draft wins over the server's copy: it is what
                    // the user was in the middle of typing.
                    state = LoadState.Ready
                    return@launch
                }
                if (existing != null) {
                    trackName = existing.trackName
                    startDate = existing.startDate
                    days = existing.days.trimmedNumber()
                    trackHours = existing.trackHours?.trimmedNumber().orEmpty()
                    club = existing.club.orEmpty()
                    runGroup = existing.runGroup.orEmpty()
                    car = existing.car.orEmpty()
                    conditions = existing.conditions
                    tempF = existing.tempF?.toString().orEmpty()
                    bestTime = existing.bestTimeMs?.let { LapTime.fmtMs(it) }.orEmpty()
                    notes = existing.notes.orEmpty()
                } else if (car.isBlank()) {
                    // A new event starts on the default car, which is the whole
                    // point of marking one.
                    car = vehicles.firstOrNull { it.isDefault }?.name.orEmpty()
                }
                hydrated = true
                state = LoadState.Ready
            } catch (e: ApiException) {
                state = LoadState.Failed(e.message ?: "Couldn't load the form.")
            }
        }
    }

    fun save() {
        val name = trackName.trim()
        if (name.isEmpty()) {
            error = "A track name is required."
            return
        }
        val bestMs = bestTime.trim().takeIf { it.isNotEmpty() }?.let { LapTime.parseTime(it) }
        if (bestTime.isNotBlank() && bestMs == null) {
            error = "Couldn't parse best time \"${bestTime.trim()}\" — use 2:01.24 format."
            return
        }

        error = null
        saving = true
        scope.launch {
            try {
                savedId = if (editId == null) {
                    api.createEvent(
                        EventDraft(
                            startDate = startDate,
                            trackName = name,
                            days = days.toDoubleOrNull(),
                            club = club.blankToNull(),
                            runGroup = runGroup.blankToNull(),
                            car = car.blankToNull(),
                            notes = notes.blankToNull(),
                            conditions = conditions,
                            tempF = tempF.toIntOrNull(),
                            bestTimeMs = bestMs,
                            trackHours = trackHours.toDoubleOrNull(),
                        ),
                    )
                } else {
                    api.updateEvent(
                        editId,
                        EventPatch(
                            // Always sent: this is how an event moves between
                            // two layouts of the same circuit.
                            trackName = Patch.Set(name),
                            startDate = Patch.Set(startDate),
                            days = Patch.Set(days.toDoubleOrNull()),
                            club = Patch.Set(club.blankToNull()),
                            runGroup = Patch.Set(runGroup.blankToNull()),
                            car = Patch.Set(car.blankToNull()),
                            notes = Patch.Set(notes.blankToNull()),
                            conditions = Patch.Set(conditions),
                            tempF = Patch.Set(tempF.toIntOrNull()),
                            bestTimeMs = Patch.Set(bestMs),
                            trackHours = Patch.Set(trackHours.toDoubleOrNull()),
                        ),
                    )
                    editId
                }
            } catch (e: ApiException) {
                error = e.message
            }
            saving = false
        }
    }
}

private fun String.blankToNull(): String? = trim().takeIf { it.isNotEmpty() }

/** "2" rather than "2.0", but "1.5" stays "1.5". */
private fun Double.trimmedNumber(): String =
    if (this == toInt().toDouble()) toInt().toString() else toString()
