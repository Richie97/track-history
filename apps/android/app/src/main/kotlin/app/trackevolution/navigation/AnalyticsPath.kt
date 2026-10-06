package app.trackevolution.navigation

import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.toRoute

/**
 * The screen as Google Analytics sees it: the route's **shape** (`AppAnalytics`).
 *
 * Spelled as the web app's own path for the same page — `analyticsPath` in
 * `public/js/analytics.js` reports `#/event/12` as `"/event/:id"` — so one GA
 * report counts a screen across the web, iOS (`Route.analyticsPath`, under the
 * same name) and here. Every id becomes `:id`, a share page is `/share/:slug`
 * and an invite is `/coach`, never its token; the one value kept is Wrapped's
 * year, as on the web. The screens the web doesn't have — the recorder, the
 * importer, a lap, a session's overlay — get paths in the same idiom.
 *
 * An exhaustive `when`, so a new route fails to compile until it is named here.
 */
public val Route.analyticsPath: String
    get() = when (this) {
        Route.Dashboard -> "/"
        is Route.Event -> student(student) + "/event/:id"
        is Route.EventForm -> if (editId == null) "/new" else "/event/:id/edit"
        is Route.Track -> student(student) + "/track/:id"
        is Route.CompareLaps -> student(student) + "/track/:id/lap-compare"
        is Route.Leaderboard -> "/track/:id/leaderboard"
        is Route.LeaderboardLap -> "/track/:id/leaderboard/:id"
        Route.Settings -> "/settings"
        is Route.Vehicle -> "/vehicle/:id"
        Route.Garage -> "/garage"
        is Route.Record -> "/record"
        is Route.Import -> "/import"
        is Route.Shared -> "/share/:slug"
        is Route.Lap -> student(student) + "/event/:id/lap/:id"
        is Route.SessionCompare -> student(student) + "/event/:id/session/:id/compare"
        is Route.Wrapped -> "/wrapped/$year"
        Route.Coaching -> "/coaching"
        Route.Profile -> "/profile"
        is Route.CoachInvite -> "/coach"
        is Route.Student -> "/student/:id"
        is Route.StudentVehicle -> "/student/:id/vehicle/:id"
        // A docs-site page, not a web-app route; named in the same idiom.
        Route.TrackDaysGuide -> "/guide/track-days"
    }

/** The web's `#/student/:id/…` prefix for a page read through a coach's grant. */
private fun student(id: Int?): String = if (id == null) "" else "/student/:id"

/** The sign-in screen, which is not a nav destination. */
public const val SIGN_IN_ANALYTICS_PATH: String = "/signin"

/**
 * The route a back stack entry is showing, for [analyticsPath] — every
 * destination in `AppNavHost`, where `routeOrNull` there recognises only the
 * ones carrying ids. Null for the two graph roots, which are never shown.
 */
internal fun NavBackStackEntry.analyticsRoute(): Route? {
    val d = destination
    return when {
        d.hasRoute(Route.Dashboard::class) -> Route.Dashboard
        d.hasRoute(Route.Event::class) -> toRoute<Route.Event>()
        d.hasRoute(Route.EventForm::class) -> toRoute<Route.EventForm>()
        d.hasRoute(Route.Track::class) -> toRoute<Route.Track>()
        d.hasRoute(Route.CompareLaps::class) -> toRoute<Route.CompareLaps>()
        d.hasRoute(Route.Leaderboard::class) -> toRoute<Route.Leaderboard>()
        d.hasRoute(Route.LeaderboardLap::class) -> toRoute<Route.LeaderboardLap>()
        d.hasRoute(Route.Settings::class) -> Route.Settings
        d.hasRoute(Route.Vehicle::class) -> toRoute<Route.Vehicle>()
        d.hasRoute(Route.Garage::class) -> Route.Garage
        d.hasRoute(Route.Record::class) -> toRoute<Route.Record>()
        d.hasRoute(Route.Import::class) -> toRoute<Route.Import>()
        d.hasRoute(Route.Shared::class) -> toRoute<Route.Shared>()
        d.hasRoute(Route.Lap::class) -> toRoute<Route.Lap>()
        d.hasRoute(Route.SessionCompare::class) -> toRoute<Route.SessionCompare>()
        d.hasRoute(Route.Wrapped::class) -> toRoute<Route.Wrapped>()
        d.hasRoute(Route.Coaching::class) -> Route.Coaching
        d.hasRoute(Route.Profile::class) -> Route.Profile
        d.hasRoute(Route.CoachInvite::class) -> toRoute<Route.CoachInvite>()
        d.hasRoute(Route.Student::class) -> toRoute<Route.Student>()
        d.hasRoute(Route.StudentVehicle::class) -> toRoute<Route.StudentVehicle>()
        d.hasRoute(Route.TrackDaysGuide::class) -> Route.TrackDaysGuide
        else -> null
    }
}
