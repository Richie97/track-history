package app.trackevolution.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * What Google Analytics is told about a screen (`AppAnalytics`): its shape, in
 * the web's own paths, and never a record id, a share slug or an invite token.
 * iOS's `AnalyticsPathTests` carries the same table.
 */
class AnalyticsPathTest {

    private val table: List<Pair<Route, String>> = listOf(
        Route.Dashboard to "/",
        Route.Event(12) to "/event/:id",
        Route.EventForm() to "/new",
        Route.EventForm(presetTrack = "Road Atlanta") to "/new",
        Route.EventForm(editId = 12) to "/event/:id/edit",
        Route.Track(3) to "/track/:id",
        Route.CompareLaps(3) to "/track/:id/lap-compare",
        Route.Leaderboard(3) to "/track/:id/leaderboard",
        Route.LeaderboardLap(3, 991) to "/track/:id/leaderboard/:id",
        Route.Settings to "/settings",
        Route.Vehicle(4) to "/vehicle/:id",
        Route.Garage to "/garage",
        Route.Record() to "/record",
        Route.Record(12) to "/record",
        Route.Import(12) to "/import",
        Route.Import(forNewEvent = true) to "/import",
        Route.Shared("eric-r") to "/share/:slug",
        Route.Lap(12, 40, 991) to "/event/:id/lap/:id",
        Route.SessionCompare(12, 40) to "/event/:id/session/:id/compare",
        Route.Wrapped(2026) to "/wrapped/2026",
        Route.Coaching to "/coaching",
        Route.Profile to "/profile",
        Route.CoachInvite("s3cr3t-t0k3n") to "/coach",
        Route.Student(8) to "/student/:id",
        Route.StudentVehicle(8, 4) to "/student/:id/vehicle/:id",
        Route.Event(12, student = 8) to "/student/:id/event/:id",
        Route.Track(3, student = 8) to "/student/:id/track/:id",
        Route.CompareLaps(3, student = 8) to "/student/:id/track/:id/lap-compare",
        Route.Lap(12, 40, 991, student = 8) to "/student/:id/event/:id/lap/:id",
        Route.SessionCompare(12, 40, 991, student = 8) to "/student/:id/event/:id/session/:id/compare",
        Route.TrackDaysGuide to "/guide/track-days",
    )

    @Test
    fun `reports each screen by the web's path shape`() {
        for ((route, path) in table) assertEquals(route.toString(), path, route.analyticsPath)
    }

    @Test
    fun `never reports an id, a slug or a token`() {
        for ((route, _) in table) {
            val path = route.analyticsPath
            // Wrapped's year is the one value kept, as on the web.
            if (route !is Route.Wrapped) assertFalse(path, path.any(Char::isDigit))
            assertFalse(path, "eric" in path || "s3cr3t" in path)
        }
    }

    @Test
    fun `an offline-created temp id is an id like any other`() {
        assertEquals("/event/:id", Route.Event(-3).analyticsPath)
    }
}
