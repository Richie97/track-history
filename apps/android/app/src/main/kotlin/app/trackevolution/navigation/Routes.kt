package app.trackevolution.navigation

import app.trackevolution.core.DeepLink
import kotlinx.serialization.Serializable

/**
 * The logbook's routes (NS-26).
 *
 * Type-safe rather than string templates: a route is a `@Serializable` class,
 * so its arguments are checked by the compiler and a renamed field breaks the
 * build instead of a tap. The set mirrors iOS's `Route` enum, which is what
 * keeps `DeepLink` — the shared, unit-tested routing table in `:core` — able to
 * feed both clients.
 */
public sealed interface Route {

    @Serializable
    public data object Dashboard : Route

    @Serializable
    public data class Event(val id: Int) : Route

    /**
     * One route for both "new" and "edit", as iOS does with `EventFormTarget`.
     * [editId] null means a new event; [presetTrack] is the track page's
     * "+ Add event at <track>" carrying its name across.
     */
    @Serializable
    public data class EventForm(val editId: Int? = null, val presetTrack: String? = null) : Route

    @Serializable
    public data class Track(val id: Int) : Route

    /** Compare any two laps with telemetry at one track (#165). */
    @Serializable
    public data class CompareLaps(val trackId: Int) : Route

    /**
     * A track's leaderboard, behind the track page's button. Keyed by the
     * viewer's own track, because that is what the server keys the board on.
     * Not a `DeepLink` case: the web reaches it as `#/track/:id/leaderboard`,
     * a hash the share page never advertises.
     */
    @Serializable
    public data class Leaderboard(val trackId: Int) : Route

    /**
     * One leaderboard row, opened (NS-35). [trackId] is the viewer's own track,
     * because a shared lap is only reachable from a track the viewer has — the
     * server checks that, so this is not merely how the screen finds its way
     * back.
     *
     * Deliberately **not** a `DeepLink` case: a lap id is only meaningful next
     * to the leaderboard it came from, and a link to one would go stale the
     * moment its owner set a faster lap or turned sharing off.
     */
    @Serializable
    public data class LeaderboardLap(val trackId: Int, val lapId: Int) : Route

    @Serializable
    public data object Settings : Route

    /**
     * A car's page: its logbook for every account, and for Pro its consumables
     * and wear (NS-37). Lives in the Garage tab's graph.
     */
    @Serializable
    public data class Vehicle(val id: Int) : Route

    /** The Garage tab's root: a tile per car and **+ Add car** (NS-37). */
    @Serializable
    public data object Garage : Route

    /** The recorder. Null [eventId] is a recording with no event yet (NS-18). */
    @Serializable
    public data class Record(val eventId: Int? = null) : Route

    /**
     * Video telemetry import: the chooser half. [eventId] is the event whose
     * page it was opened from, pre-selected in the review that follows; null
     * for a clip handed in by the share sheet.
     *
     * [forNewEvent] is the New Event form's door: there is no event to save
     * onto yet, so the review hands its session drafts back to the form
     * ([RecordingFlow.staged]) instead of posting them, and the form posts
     * them itself once the event exists. Same chooser, same review — only
     * where the sessions go differs.
     */
    @Serializable
    public data class Import(val eventId: Int? = null, val forNewEvent: Boolean = false) : Route

    @Serializable
    public data class Shared(val slug: String) : Route

    /**
     * One lap of one session, from its row on the event page (#268). Carries
     * the event id because the screen reads the event detail — the same cached
     * read the page made — and finds the session and lap in it. Not a
     * `DeepLink` case: a lap id means nothing away from the page it came from.
     */
    @Serializable
    public data class Lap(val eventId: Int, val sessionId: Int, val lapId: Int) : Route

    /**
     * A session's multi-lap channel overlay as a destination of its own (#268)
     * — the panel the session card used to inline. [lapId] is the lap to light
     * first, beside the session's best; null lights the best alone.
     */
    @Serializable
    public data class SessionCompare(val eventId: Int, val sessionId: Int, val lapId: Int? = null) : Route

    /**
     * Season Wrapped (NS-36): one calendar year as a story of cards, opened from
     * the dashboard's November banner. It **owns the window** — the scaffold
     * drops to one pane for it, as for the recorder — and it is not a
     * `DeepLink` case: the web's `#/wrapped/:year` is a web route, and the app's
     * door is the banner.
     */
    @Serializable
    public data class Wrapped(val year: Int) : Route
}

/**
 * Where a parsed deep link lands.
 *
 * Null means the dashboard — an empty back stack rather than a screen pushed on
 * top of one, which is why it is not simply [Route.Dashboard].
 *
 * `DeepLink.Vehicle` sent people to the dashboard while the garage was deferred
 * on Android; NS-31 built it, so it now lands on the car. An id that doesn't
 * parse never becomes a `DeepLink.Vehicle` in the first place, so nothing here
 * has to defend against one.
 */
public fun routeFor(link: DeepLink): Route? = when (link) {
    is DeepLink.Dashboard -> null
    is DeepLink.Event -> Route.Event(link.id)
    is DeepLink.EditEvent -> Route.EventForm(editId = link.id)
    is DeepLink.NewEvent -> Route.EventForm(presetTrack = link.presetTrack)
    is DeepLink.Track -> Route.Track(link.id)
    is DeepLink.Settings -> Route.Settings
    is DeepLink.Shared -> Route.Shared(link.slug)
    is DeepLink.Vehicle -> Route.Vehicle(link.id)
}

/**
 * The signed-in shell's two tabs (NS-37): the logbook and the garage.
 *
 * Settings is not a third tab — it stays behind the dashboard's top bar, and so
 * lives in the Events graph.
 */
public enum class AppTab { Events, Garage }

/** The Events tab's nested graph; its start destination is [Route.Dashboard]. */
@Serializable
public data object EventsGraph

/** The Garage tab's nested graph; its start destination is [Route.Garage]. */
@Serializable
public data object GarageGraph

/**
 * Which tab a route lives in — iOS's `Route.tab`. Deep links and cross-tab
 * navigation read it to switch the tab *before* navigating, which is what makes
 * `/vehicle/:id` land in the Garage at every width. Everything but the car and
 * the garage itself belongs to the logbook.
 */
public val Route.tab: AppTab
    get() = when (this) {
        is Route.Vehicle, Route.Garage -> AppTab.Garage
        else -> AppTab.Events
    }

/** The start destination of a tab's graph — what `popUpTo` resets it to. */
public val AppTab.root: Route
    get() = when (this) {
        AppTab.Events -> Route.Dashboard
        AppTab.Garage -> Route.Garage
    }
