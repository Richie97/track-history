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
import app.trackevolution.core.model.SessionChannels
import app.trackevolution.ui.LoadState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The compare-two-laps screen's data (#165): every event detail at the track
 * with channel data, flattened to pickable laps, and the selected pair.
 *
 * `viewLapCompare` in `public/app.js` is the reference; the maths is
 * `CompareLaps` in `:core`, pinned by `contracts/logic/compare-laps.json`.
 */
class CompareLapsModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    val trackId: Int,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set

    var rows by mutableStateOf<List<CompareLaps.Row>>(emptyList())
        private set

    /** `sessions.channels` by session id, so a picked row finds its entry. */
    private var channelsBySession: Map<Int, SessionChannels> = emptyMap()

    /** Indexes into [rows] — seeded by [CompareLaps.defaultComparePicks]. */
    var selA by mutableStateOf(0)
        private set
    var selB by mutableStateOf(0)
        private set

    fun load() {
        scope.launch {
            try {
                // Channel data lives on event details; the reads go through the
                // offline cache, so a comparison viewed once works in the paddock.
                val events = api.events(trackId = trackId)
                val details = events.filter { it.lapCount > 0 }.map { api.event(it.id) }
                rows = CompareLaps.comparableLaps(details.map { CompareLaps.EventLaps(it) })
                channelsBySession = details
                    .flatMap { it.sessions }
                    .mapNotNull { session -> session.channels?.let { session.id to it } }
                    .toMap()
                CompareLaps.defaultComparePicks(rows)?.let {
                    selA = it.a
                    selB = it.b
                }
                state = LoadState.Ready
            } catch (e: ApiException) {
                state = LoadState.Failed(e.message ?: "Couldn't load laps to compare.")
            }
        }
    }

    /**
     * Picking the lap the other side already shows swaps the two instead of
     * comparing a lap to itself — the web view's rule.
     */
    fun pickA(index: Int) {
        if (index == selB) selB = selA
        selA = index
    }

    fun pickB(index: Int) {
        if (index == selA) selA = selB
        selB = index
    }

    /** "May 3, 2026 · Sat AM · Lap 2 — 1:30.480", trimmed to what the row has. */
    fun pickLabel(index: Int): String {
        val row = rows.getOrNull(index) ?: return "—"
        val parts = listOfNotNull(EventDates.fmtDate(row.date), row.sessionLabel, "Lap ${row.lapNum}")
        return "${parts.joinToString(" · ")} — ${LapTime.fmtMs(row.timeMs)}"
    }

    /**
     * Everything the screen needs for the current pair, or null when fewer than
     * two laps at this track carry channel data.
     */
    data class LapPair(
        val aligned: SessionChannels,
        /**
         * Synthetic lap rows for the chart's chips: ids 0 and 1, the rows' own
         * lap numbers, and the entries' times so `matchLapsToChannels` pairs
         * them.
         */
        val laps: List<Lap>,
        val metricsA: CompareLaps.Metrics,
        val metricsB: CompareLaps.Metrics,
        val mismatch: Double,
    )

    val pair: LapPair?
        get() {
            if (rows.size < 2 || selA == selB) return null
            val rowA = rows.getOrNull(selA) ?: return null
            val rowB = rows.getOrNull(selB) ?: return null
            val chanA = channelsBySession[rowA.sessionId] ?: return null
            val chanB = channelsBySession[rowB.sessionId] ?: return null
            val entryA = chanA.laps.getOrNull(rowA.chIdx) ?: return null
            val entryB = chanB.laps.getOrNull(rowB.chIdx) ?: return null
            return LapPair(
                aligned = CompareLaps.alignLapPair(entryA, chanA.dStepM, entryB, chanB.dStepM),
                laps = listOf(
                    Lap(id = 0, sessionId = rowA.sessionId, lapNum = rowA.lapNum, timeMs = entryA.timeMs),
                    Lap(id = 1, sessionId = rowB.sessionId, lapNum = rowB.lapNum, timeMs = entryB.timeMs),
                ),
                metricsA = CompareLaps.lapMetrics(entryA),
                metricsB = CompareLaps.lapMetrics(entryB),
                mismatch = CompareLaps.lengthMismatchRatio(entryA, chanA.dStepM, entryB, chanB.dStepM),
            )
        }
}
