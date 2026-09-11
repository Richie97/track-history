package app.trackevolution.core

import app.trackevolution.core.model.TrackLeaderboard

/**
 * The track page's per-track leaderboard copy that depends on data — the
 * port of `leaderboardHtml`'s note in `public/app.js`.
 *
 * Only device-timed laps rank (NS-33), and the server decides that; the
 * client's job is to explain a row that is slower than the logbook's own
 * headline at the track, or a missing row. Pure, so it is unit-tested.
 */
public object Leaderboard {
    /**
     * Why the viewer's row differs from the logbook, or null when there is
     * nothing to explain. [logbookBest] is the viewer's best at the track with
     * manual bests included and the dry-only filter ignored — the leaderboard
     * ignores it too. Same wording as the web and iOS.
     */
    public fun note(logbookBest: Int?, leaderboard: TrackLeaderboard): String? {
        logbookBest ?: return null
        val you = leaderboard.entries.firstOrNull { it.you }
        return when {
            leaderboard.optedIn && you == null ->
                "None of your laps here were timed by a device, so you aren't ranked yet. " +
                    "Record with the app or import telemetry to appear."
            you != null && logbookBest < you.bestMs ->
                "Your best here (${LapTime.fmtMs(logbookBest)}) was entered by hand and isn't ranked."
            else -> null
        }
    }
}
