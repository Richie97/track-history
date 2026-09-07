package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.TrackLeaderboard
import app.trackevolution.ui.LoadState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.launch

/**
 * One track's leaderboard, behind the track page's button. `viewLeaderboard`
 * in `public/app.js` is the reference.
 *
 * It used to be a section of [TrackModel]'s page; it moved out because that
 * page is the driver's own history and a board they may not care about was
 * costing it a screen of space — and because a driver who *does* care wants to
 * read it before they are on it, when the section had nothing of theirs to sit
 * beside. The opt-in write lives here, where the driver is looking at exactly
 * what joining publishes.
 */
class LeaderboardModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    val trackId: Int,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set

    var trackName by mutableStateOf("")
        private set

    var leaderboard by mutableStateOf<TrackLeaderboard?>(null)
        private set

    var leaderboardError by mutableStateOf<String?>(null)
        private set

    /**
     * The logbook's best at this track, manual bests included — what
     * `Leaderboard.note` compares the viewer's row against. The dry-only filter
     * has no say here, because the board ignores it too.
     */
    var logbookBest by mutableStateOf<Int?>(null)
        private set

    fun load() {
        scope.launch {
            try {
                val tracksJob = async { api.tracks() }
                val eventsJob = async { api.events(trackId = trackId) }
                val boardJob = async { api.trackLeaderboard(trackId) }
                val found = tracksJob.await().firstOrNull { it.id == trackId }
                val events = eventsJob.await()
                val board = boardJob.await()
                if (found == null) {
                    state = LoadState.Failed("That track isn't in your logbook any more.")
                    return@launch
                }
                trackName = found.name
                logbookBest = events.mapNotNull { it.bestMs }.minOrNull()
                leaderboard = board
                state = LoadState.Ready
            } catch (e: ApiException) {
                if (leaderboard == null) state = LoadState.Failed(e.message ?: "Couldn't load the leaderboard.")
            }
        }
    }

    /**
     * Join or leave the leaderboards. A live write on purpose — never queued
     * offline: publishing your name shouldn't replay silently later.
     */
    fun setLeaderboardOptIn(optIn: Boolean, shareLaps: Boolean? = null) {
        scope.launch {
            leaderboardError = null
            try {
                api.setLeaderboardOptIn(optIn, shareLaps)
                leaderboard = runCatching { api.trackLeaderboard(trackId) }.getOrNull() ?: leaderboard
            } catch (e: ApiException) {
                leaderboardError = e.message
            }
        }
    }
}
