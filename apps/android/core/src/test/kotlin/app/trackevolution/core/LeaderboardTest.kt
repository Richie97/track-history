package app.trackevolution.core

import app.trackevolution.core.model.LeaderboardEntry
import app.trackevolution.core.model.TrackLeaderboard
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The leaderboard note — the port of `leaderboardHtml`'s viewer hint in
 * `public/app.js` (NS-33). Only device-timed laps rank, so the client has to
 * explain a row slower than the logbook's own best, or a missing row.
 */
class LeaderboardTest {
    private fun board(optedIn: Boolean, vararg entries: LeaderboardEntry) =
        TrackLeaderboard(catalogId = 1, optedIn = optedIn, entries = entries.toList())

    private fun row(bestMs: Int, you: Boolean) =
        LeaderboardEntry(name = "Driver", bestMs = bestMs, date = "2026-04-10", you = you)

    @Test
    fun `nothing to explain without a logbook best`() {
        assertNull(Leaderboard.note(null, board(optedIn = true)))
        assertNull(Leaderboard.note(null, board(optedIn = true, row(91_000, you = false))))
    }

    @Test
    fun `opted in with laps here but no row means nothing was device-timed`() {
        assertEquals(
            "None of your laps here were timed by a device, so you aren't ranked yet. " +
                "Record with the app or import telemetry to appear.",
            Leaderboard.note(93_211, board(optedIn = true, row(91_000, you = false))),
        )
    }

    @Test
    fun `not opted in says nothing — the join copy covers it`() {
        assertNull(Leaderboard.note(93_211, board(optedIn = false, row(91_000, you = false))))
    }

    @Test
    fun `a hand-entered best faster than the ranked row is explained`() {
        assertEquals(
            "Your best here (1:29.500) was entered by hand and isn't ranked.",
            Leaderboard.note(89_500, board(optedIn = true, row(88_000, you = false), row(93_211, you = true))),
        )
    }

    @Test
    fun `a ranked row that is the logbook best needs no note`() {
        assertNull(Leaderboard.note(93_211, board(optedIn = true, row(93_211, you = true))))
        // The logbook can't be slower than its own ranked lap, but a stale
        // cache could say so; that is not a hand-entry story either.
        assertNull(Leaderboard.note(95_000, board(optedIn = true, row(93_211, you = true))))
    }
}
