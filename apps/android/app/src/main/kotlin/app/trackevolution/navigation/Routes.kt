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

    @Serializable
    public data object Settings : Route

    /** A car's garage page: consumables, wear and the track-hours ledger. */
    @Serializable
    public data class Vehicle(val id: Int) : Route

    /** The recorder. Null [eventId] is a recording with no event yet (NS-18). */
    @Serializable
    public data class Record(val eventId: Int? = null) : Route

    /**
     * Video telemetry import: the chooser half. [eventId] is the event whose
     * page it was opened from, pre-selected in the review that follows; null
     * for a clip handed in by the share sheet.
     */
    @Serializable
    public data class Import(val eventId: Int? = null) : Route

    @Serializable
    public data class Shared(val slug: String) : Route
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
