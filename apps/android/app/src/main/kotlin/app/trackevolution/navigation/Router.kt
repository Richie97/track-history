package app.trackevolution.navigation

import androidx.navigation.NavHostController
import app.trackevolution.core.DeepLink
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Holds the deep link that arrived before there was anywhere to send it.
 *
 * Cold start hands the launching intent to `MainActivity.onCreate` long before
 * the nav graph exists, and often before sign-in has settled — `AuthController`
 * has to ask `/api/me` first. Until NS-26 nothing read `pendingLink` back, so a
 * tapped share link opened the app on a blank dashboard. This is the other half
 * of that: park the route, and apply it once there is a graph and a session.
 *
 * The counterpart of iOS's `AppRouter.pending` / `applyPending()`.
 */
public class Router {

    private val _pending = MutableStateFlow<Route?>(null)

    /** A route waiting for a signed-in nav host to consume it. */
    public val pending: StateFlow<Route?> = _pending.asStateFlow()

    /**
     * Park a parsed link. A link to the dashboard parks nothing — the dashboard
     * is where an empty back stack already is, and pushing it would put a second
     * copy on the stack.
     */
    public fun offer(link: DeepLink) {
        _pending.value = routeFor(link)
    }

    /** Drop anything parked — sign-out, or after it has been navigated to. */
    public fun clear() {
        _pending.value = null
    }

    public fun consume(): Route? = _pending.value.also { _pending.value = null }
}

/**
 * Send a deep link to its screen, replacing whatever was on the stack.
 *
 * A link is an arrival, not a step deeper into where you already were, so the
 * back stack is reset to the dashboard beneath the target: back from a shared
 * link opens the logbook rather than retracing a stack the user never walked.
 */
public fun NavHostController.showDeepLink(route: Route) {
    popBackStack(Route.Dashboard, inclusive = false)
    if (route != Route.Dashboard) navigate(route)
}

/**
 * Follow a row that was created offline once its real id arrives.
 *
 * An offline create hands back a negative temp id (NS-22) and the screen
 * navigates to it immediately. When the queue flushes, that id stops existing —
 * so a screen parked on it would 404 against the server the moment it refreshed.
 * iOS calls this `remapTempIds`.
 */
public fun Route.remapTempId(from: Int, to: Int): Route = when (this) {
    is Route.Event -> if (id == from) Route.Event(to) else this
    is Route.EventForm -> if (editId == from) copy(editId = to) else this
    is Route.Record -> if (eventId == from) copy(eventId = to) else this
    // Tracks are never created offline — an event's track is found-or-created
    // server-side by name — and slugs and settings carry no id at all.
    else -> this
}
