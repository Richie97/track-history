package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.SavedStateHandle
import app.trackevolution.core.EventDates
import app.trackevolution.core.EventFormSessions
import app.trackevolution.navigation.SavedState
import app.trackevolution.core.LapTime
import app.trackevolution.core.Units
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.Conditions
import app.trackevolution.core.model.EventDraft
import app.trackevolution.core.model.EventPatch
import app.trackevolution.core.model.Patch
import app.trackevolution.core.model.SessionDraft
import app.trackevolution.core.model.UnitSystem
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
 *
 * **A new event can carry its laps.** The form's "Add laps" section stages
 * sessions until the event exists: clips the import review handed back
 * ([stage], through `RecordingFlow.staged`) and one session typed by hand
 * ([sessionLabel], [sessionLaps], [sessionNotes]). [save] creates the event,
 * then posts each session [EventFormSessions.sessionsToCreate] returns onto
 * it, in that order. The created event's id is kept in [createdId] so a
 * session post that fails leaves the form up with the error and the next
 * save retries only the sessions still staged, never creating the event twice.
 * The staged drafts are plain state rather than [SavedState]: a clip's channel
 * arrays are far larger than a Bundle transaction allows, so they survive
 * rotation (the model does) but not process death — the same lifetime the
 * review overlay's own state has.
 */
class EventFormModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    /** Null for a new event. */
    val editId: Int? = null,
    presetTrack: String? = null,
    /**
     * The system the temperature is typed in. The draft holds the typed number;
     * `events.temp_f` stays whole °F, so [temp] is converted on the way in
     * ([Units.tempToDisplay]) and back out ([Units.tempToStored]) — exactly as the
     * web form does — and the server never sees a °C.
     */
    private val units: UnitSystem = Units.DEFAULT_UNITS,
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
    /** The temperature as typed, in [units] — not the stored °F. */
    var temp by SavedState(saved, "temp", "")
    var bestTime by SavedState(saved, "bestTime", "")
    var notes by SavedState(saved, "notes", "")

    /** The hand-typed session of the "Add laps" section, new events only. */
    var sessionLabel by SavedState(saved, "sessionLabel", "")
    var sessionLaps by SavedState(saved, "sessionLaps", "")
    var sessionNotes by SavedState(saved, "sessionNotes", "")

    /** Sessions the import review staged for this event, in posting order. */
    var stagedSessions by mutableStateOf<List<SessionDraft>>(emptyList())
        private set

    /**
     * The event [save] already created, when a session post after it failed.
     * Null until then; the next save skips `POST /events` and posts the
     * sessions still staged.
     */
    var createdId by SavedState<Int?>(saved, "createdId", null)
        private set

    fun stage(drafts: List<SessionDraft>) {
        stagedSessions = stagedSessions + drafts
    }

    fun removeStaged(index: Int) {
        stagedSessions = stagedSessions.filterIndexed { i, _ -> i != index }
    }

    /** Everything the "Add laps" section would post, in posting order. */
    val pendingSessions: List<SessionDraft>
        get() = EventFormSessions.sessionsToCreate(stagedSessions, sessionLabel, sessionLaps, sessionNotes)

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
                    temp = Units.tempToDisplay(existing.tempF, units)?.toString().orEmpty()
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
                    val id = createdId ?: api.createEvent(
                        EventDraft(
                            startDate = startDate,
                            trackName = name,
                            days = days.toDoubleOrNull(),
                            club = club.blankToNull(),
                            runGroup = runGroup.blankToNull(),
                            car = car.blankToNull(),
                            notes = notes.blankToNull(),
                            conditions = conditions,
                            tempF = Units.tempToStored(temp.trim().toDoubleOrNull(), units),
                            bestTimeMs = bestMs,
                            trackHours = trackHours.toDoubleOrNull(),
                        ),
                    ).also { createdId = it }
                    // Then the laps, onto the event that now exists: the staged
                    // imports first, then the hand-typed session. Each is posted
                    // once — a posted one leaves the staging (or empties the typed
                    // laps) before the next, so a failure leaves exactly the rest.
                    for (draft in pendingSessions) {
                        api.createSession(id, draft)
                        if (stagedSessions.firstOrNull() == draft) stagedSessions = stagedSessions.drop(1) else sessionLaps = ""
                    }
                    id
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
                            tempF = Patch.Set(Units.tempToStored(temp.trim().toDoubleOrNull(), units)),
                            bestTimeMs = Patch.Set(bestMs),
                            trackHours = Patch.Set(trackHours.toDoubleOrNull()),
                        ),
                    )
                    editId
                }
            } catch (e: ApiException) {
                error = if (createdId != null) {
                    "The event was created, but a session couldn't be added: ${e.message}"
                } else {
                    e.message
                }
            }
            saving = false
        }
    }
}

private fun String.blankToNull(): String? = trim().takeIf { it.isNotEmpty() }

/** "2" rather than "2.0", but "1.5" stays "1.5". */
private fun Double.trimmedNumber(): String =
    if (this == toInt().toDouble()) toInt().toString() else toString()
