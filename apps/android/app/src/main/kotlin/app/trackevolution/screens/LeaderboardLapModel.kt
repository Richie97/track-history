package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.trackevolution.core.CompareLaps
import app.trackevolution.core.EventDates
import app.trackevolution.core.LapTime
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.Lap
import app.trackevolution.core.model.LeaderboardLap
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.ui.LoadState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * One leaderboard row, opened (NS-35). `viewLeaderboardLap` in `public/app.js`
 * is the reference, and [CompareLapsModel] is the sibling this borrows its
 * flattening and pair-building from.
 *
 * The published lap is the screen; the viewer's own best at the same track is
 * the comparison laid beside it. **Their lap is always side A**, so it keeps its
 * colour whether or not there is anything to put beside it, and a viewer with no
 * telemetry here still gets the lap they tapped.
 */
class LeaderboardLapModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    val trackId: Int,
    val lapId: Int,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set

    var lap by mutableStateOf<LeaderboardLap?>(null)
        private set

    /**
     * The viewer's own laps with telemetry here — the same flattening the
     * two-lap compare does, so the pick list reads identically.
     */
    var rows by mutableStateOf<List<CompareLaps.Row>>(emptyList())
        private set

    private var channelsBySession: Map<Int, SessionChannels> = emptyMap()

    /**
     * Index into [rows], defaulted to the viewer's own fastest: the comparison
     * anyone opening a leaderboard row wants is "my best against theirs".
     */
    var selectedMine by mutableStateOf<Int?>(null)
        private set

    fun pickMine(index: Int) {
        selectedMine = index
    }

    fun load() {
        scope.launch {
            try {
                lap = api.leaderboardLap(trackId = trackId, lapId = lapId)
                loadMine()
                state = LoadState.Ready
            } catch (e: ApiException) {
                state = LoadState.Failed(e.message ?: "Couldn't open this lap.")
            }
        }
    }

    /**
     * A failure here costs the comparison, never the screen: their lap still
     * renders, which is what the viewer tapped for.
     */
    private suspend fun loadMine() {
        if (lap?.entry == null) return
        try {
            val events = api.events(trackId = trackId)
            val details = events.filter { it.lapCount > 0 }.map { api.event(it.id) }
            rows = CompareLaps.comparableLaps(details.map { CompareLaps.EventLaps(it) })
            channelsBySession = details
                .flatMap { it.sessions }
                .mapNotNull { session -> session.channels?.let { session.id to it } }
                .toMap()
            selectedMine = rows.indices.minByOrNull { rows[it].timeMs }
        } catch (_: ApiException) {
            rows = emptyList()
            channelsBySession = emptyMap()
            selectedMine = null
        }
    }

    /** "May 3, 2026 · Sat AM · Lap 2 — 1:30.480", trimmed to what the row has. */
    fun pickLabel(index: Int): String {
        val row = rows.getOrNull(index) ?: return "—"
        val parts = listOfNotNull(EventDates.fmtDate(row.date), row.sessionLabel, "Lap ${row.lapNum}")
        return "${parts.joinToString(" · ")} — ${LapTime.fmtMs(row.timeMs)}"
    }

    /** Everything the screen draws, with the leaderboard lap always at index 0. */
    data class Panel(
        val aligned: SessionChannels,
        /**
         * Synthetic lap rows for the chart's chips, so `matchLapsToChannels`
         * pairs them by time the way it does for a real session.
         */
        val laps: List<Lap>,
        val theirMetrics: CompareLaps.Metrics,
        val myMetrics: CompareLaps.Metrics?,
        val mine: CompareLaps.Row?,
        val mismatch: Double,
    )

    val panel: Panel?
        get() {
            val current = lap ?: return null
            val theirs = current.entry ?: return null
            val step = current.channels?.dStepM ?: return null
            val theirLap = Lap(id = 0, sessionId = 0, lapNum = theirs.n, timeMs = theirs.timeMs)
            val alone = Panel(
                aligned = SessionChannels(v = 1, dStepM = step, laps = listOf(theirs)),
                laps = listOf(theirLap),
                theirMetrics = CompareLaps.lapMetrics(theirs),
                myMetrics = null,
                mine = null,
                mismatch = 0.0,
            )
            val row = selectedMine?.let { rows.getOrNull(it) } ?: return alone
            val channels = channelsBySession[row.sessionId] ?: return alone
            val mine = channels.laps.getOrNull(row.chIdx) ?: return alone
            return Panel(
                aligned = CompareLaps.alignLapPair(theirs, step, mine, channels.dStepM),
                laps = listOf(
                    theirLap,
                    Lap(id = 1, sessionId = row.sessionId, lapNum = row.lapNum, timeMs = mine.timeMs),
                ),
                theirMetrics = CompareLaps.lapMetrics(theirs),
                myMetrics = CompareLaps.lapMetrics(mine),
                mine = row,
                mismatch = CompareLaps.lengthMismatchRatio(theirs, step, mine, channels.dStepM),
            )
        }
}
