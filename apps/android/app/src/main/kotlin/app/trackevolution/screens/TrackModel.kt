package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.trackevolution.core.EventDates
import app.trackevolution.core.LapTime
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.Conditions
import app.trackevolution.core.model.Event
import app.trackevolution.core.model.Patch
import app.trackevolution.core.model.Track
import app.trackevolution.core.model.TrackLeaderboard
import app.trackevolution.core.model.TrackPatch
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.charts.ProgressPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.launch

/**
 * One circuit over time (NS-26): the progress chart, the goal you're chasing, the
 * course notes, and every event you've run here.
 *
 * `viewTrack` in `public/app.js` is the reference. The **setup-vs-lap-times
 * table** and the **two-event lap overlay** (`viewCompare`) stay web-only per the
 * product split, and are absent rather than stubbed. The two-lap telemetry
 * compare (`viewLapCompare`, #165) *is* here — see [CompareLapsModel].
 */
class TrackModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    val trackId: Int,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set

    var track by mutableStateOf<Track?>(null)
        private set

    var allEvents by mutableStateOf<List<Event>>(emptyList())
        private set

    var writeError by mutableStateOf<String?>(null)
        private set

    /**
     * Hides events *known* to be damp, wet or mixed. Unlabelled history stays:
     * "no conditions recorded" is not the same claim as "not dry", and dropping
     * it would quietly rewrite a personal best.
     */
    var dryOnly by mutableStateOf(false)

    var goalText by mutableStateOf("")
    private var savedGoalText = ""

    var notes by mutableStateOf("")
    private var savedNotes = ""

    var savingNotes by mutableStateOf(false)
        private set

    var notesSaved by mutableStateOf(false)
        private set

    /**
     * Whether the two-lap compare is worth offering: any event here has laps.
     * Channel data can't be known from the event list — the compare screen's
     * empty state covers a track whose laps carry none, same as the web.
     */
    val hasComparableLaps: Boolean
        get() = allEvents.any { it.lapCount > 0 }

    /**
     * The share slug, read separately from the page's own load: a missing or
     * failing `/me` must not cost the user their track page, and there is nothing
     * to share until a slug exists.
     */
    var shareSlug by mutableStateOf<String?>(null)
        private set

    fun load() {
        scope.launch {
            try {
                val tracksJob = async { api.tracks() }
                val eventsJob = async { api.events(trackId = trackId) }
                val found = tracksJob.await().firstOrNull { it.id == trackId }
                val loaded = eventsJob.await()
                if (found == null) {
                    state = LoadState.Failed("That track isn't in your logbook any more.")
                    return@launch
                }
                // Both at once: publishing the track before its events would let
                // a recomposition in between draw a circuit with no history.
                track = found
                allEvents = loaded
                // A re-load must not overwrite something half-typed. Every write
                // on this screen ends in one, so "saved the goal" would otherwise
                // discard unsaved course notes sitting in the field above it.
                val serverGoal = found.goalMs?.let { LapTime.fmtMs(it) }.orEmpty()
                if (goalText == savedGoalText) goalText = serverGoal
                savedGoalText = serverGoal
                val edited = notesChanged
                savedNotes = found.notes.orEmpty()
                if (!edited) notes = savedNotes
                state = LoadState.Ready
            } catch (e: ApiException) {
                if (track == null) state = LoadState.Failed(e.message ?: "Couldn't load this track.")
                return@launch
            }
            shareSlug = runCatching { api.me() }.getOrNull()?.user?.shareSlug
            // Non-fatal on purpose: an older server or a failed fetch costs the
            // leaderboard section, never the track page.
            leaderboard = runCatching { api.trackLeaderboard(trackId) }.getOrNull()
        }
    }

    // ---- Leaderboard ---------------------------------------------------------

    /**
     * The per-track community leaderboard, or null when it couldn't be loaded
     * (older server, offline) — the section simply doesn't render then.
     */
    var leaderboard by mutableStateOf<TrackLeaderboard?>(null)
        private set

    var leaderboardError by mutableStateOf<String?>(null)
        private set

    /**
     * Join or leave the leaderboards. A live write on purpose — never queued
     * offline: publishing your name shouldn't replay silently later.
     */
    fun setLeaderboardOptIn(optIn: Boolean) {
        scope.launch {
            leaderboardError = null
            try {
                api.setLeaderboardOptIn(optIn)
                leaderboard = runCatching { api.trackLeaderboard(trackId) }.getOrNull() ?: leaderboard
            } catch (e: ApiException) {
                leaderboardError = e.message
            }
        }
    }

    /** Newest first, as the server returns them. */
    val events: List<Event>
        get() = if (dryOnly) {
            allEvents.filter { it.conditions == null || it.conditions == Conditions.DRY }
        } else {
            allEvents
        }

    /** Only offered once something here was logged as anything but dry. */
    val hasWetData: Boolean
        get() = allEvents.any { it.conditions != null && it.conditions != Conditions.DRY }

    val personalBest: Int?
        get() = events.mapNotNull { it.bestMs }.minOrNull()

    /**
     * The logbook's best at this track regardless of the dry-only filter,
     * manual bests included — what the leaderboard note compares against,
     * since the leaderboard ignores that filter too.
     */
    val logbookBest: Int?
        get() = allEvents.mapNotNull { it.bestMs }.minOrNull()

    /** Chronological, and only events that actually set a time. */
    val chartPoints: List<ProgressPoint>
        get() = events
            .filter { it.bestMs != null }
            .sortedBy { it.startDate }
            .mapNotNull { event ->
                val best = event.bestMs ?: return@mapNotNull null
                val x = EventDates.epochDay(event.startDate) ?: return@mapNotNull null
                ProgressPoint(x = x, label = EventDates.fmtDate(event.startDate), ms = best)
            }

    /** How the personal best stands against the goal, in the web app's words. */
    val goalStatus: GoalStatus?
        get() {
            val goal = track?.goalMs ?: return null
            val pb = personalBest ?: return GoalStatus("Not yet beaten", met = false)
            if (pb <= goal) {
                val by = LapTime.fmtDelta(goal - pb).removePrefix("+")
                return GoalStatus("Goal beaten by $by ✓", met = true)
            }
            return GoalStatus("${LapTime.fmtDelta(pb - goal)} to goal", met = false)
        }

    data class GoalStatus(val text: String, val met: Boolean)

    val notesChanged: Boolean
        get() = notes != savedNotes

    // ---- Writes ------------------------------------------------------------

    fun saveGoal() {
        val raw = goalText.trim()
        if (raw.isEmpty()) {
            clearGoal()
            return
        }
        val ms = LapTime.parseTime(raw)
        if (ms == null || ms <= 0) {
            writeError = "Couldn't parse \"$raw\" — use 1:59.0"
            return
        }
        write(TrackPatch(goalMs = Patch.Set(ms)))
    }

    fun clearGoal() {
        goalText = ""
        write(TrackPatch(goalMs = Patch.Set(null)))
    }

    fun saveNotes() {
        savingNotes = true
        notesSaved = false
        // Captured before the request: `notes` is a text field the user can keep
        // typing into, and marking what they have now as saved would be a lie.
        val submitted = notes
        write(TrackPatch(notes = Patch.Set(submitted.ifBlank { null }))) {
            savingNotes = false
            if (writeError == null) {
                savedNotes = submitted
                notesSaved = true
            }
        }
    }

    fun dismissWriteError() {
        writeError = null
    }

    /**
     * A failed write never blanks the screen — the content behind it is still
     * valid, and losing a track page because a goal was rejected would be the
     * wrong trade.
     */
    private fun write(patch: TrackPatch, onDone: () -> Unit = {}) {
        scope.launch {
            writeError = null
            try {
                api.updateTrack(trackId, patch)
            } catch (e: ApiException) {
                writeError = e.message
            }
            onDone()
            if (writeError == null) load()
        }
    }

    /**
     * The public link to this track, when a slug exists. Null otherwise: offering
     * a share button that produces a 404 is worse than offering none.
     */
    fun shareUrl(serverUrl: String): String? =
        shareSlug?.let { "${serverUrl.trimEnd('/')}/share/$it#/track/$trackId" }
}
