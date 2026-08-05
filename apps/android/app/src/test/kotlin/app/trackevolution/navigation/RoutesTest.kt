package app.trackevolution.navigation

import app.trackevolution.core.DeepLink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The routing table, one layer above `DeepLinkTest` in `:core`.
 *
 * That suite proves a URL parses into the right `DeepLink`; this proves the
 * `DeepLink` reaches the right screen. The join between them is where a link
 * quietly goes nowhere, which is exactly what NS-26's "no dead links" criterion
 * is about.
 */
class RoutesTest {

    @Test
    fun `sends each link to its screen`() {
        assertEquals(Route.Event(7), routeFor(DeepLink.Event(7)))
        assertEquals(Route.EventForm(editId = 7), routeFor(DeepLink.EditEvent(7)))
        assertEquals(Route.Track(3), routeFor(DeepLink.Track(3)))
        assertEquals(Route.Settings, routeFor(DeepLink.Settings))
        assertEquals(Route.Shared("eric"), routeFor(DeepLink.Shared("eric")))
    }

    @Test
    fun `carries a preset track name into the new-event form`() {
        assertEquals(
            Route.EventForm(presetTrack = "Virginia International Raceway (Full)"),
            routeFor(DeepLink.NewEvent("Virginia International Raceway (Full)")),
        )
    }

    @Test
    fun `sends the dashboard nowhere, because that is where an empty stack is`() {
        // Not Route.Dashboard: pushing it would put a second dashboard on top of
        // the one already there.
        assertNull(routeFor(DeepLink.Dashboard))
    }

    @Test
    fun `sends a vehicle link to the car it names`() {
        // This landed on the dashboard while the garage was deferred on Android;
        // NS-31 built it, so a link shared from a desk browser now opens the same
        // car it would there.
        assertEquals(Route.Vehicle(2), routeFor(DeepLink.Vehicle(2)))
    }

    // ---- temp-id remapping -------------------------------------------------

    @Test
    fun `follows an offline-created event to its real id`() {
        assertEquals(Route.Event(42), Route.Event(-1).remapTempId(from = -1, to = 42))
        assertEquals(
            Route.EventForm(editId = 42),
            Route.EventForm(editId = -1).remapTempId(from = -1, to = 42),
        )
        assertEquals(
            Route.Record(eventId = 42),
            Route.Record(eventId = -1).remapTempId(from = -1, to = 42),
        )
    }

    @Test
    fun `leaves rows it was not about alone`() {
        assertEquals(Route.Event(9), Route.Event(9).remapTempId(from = -1, to = 42))
        assertEquals(Route.Track(-1), Route.Track(-1).remapTempId(from = -1, to = 42))
        assertEquals(Route.Settings, Route.Settings.remapTempId(from = -1, to = 42))
    }

    // ---- the pending handoff ----------------------------------------------

    @Test
    fun `parks a link until something can consume it`() {
        val router = Router()
        assertNull(router.pending.value)

        router.offer(DeepLink.Event(7))
        assertEquals(Route.Event(7), router.pending.value)

        assertEquals(Route.Event(7), router.consume())
        assertNull(router.pending.value)
    }

    @Test
    fun `parks nothing for a link that needs no navigation`() {
        val router = Router()
        router.offer(DeepLink.Dashboard)
        assertNull(router.pending.value)
    }

    @Test
    fun `drops a parked link on sign-out`() {
        val router = Router()
        router.offer(DeepLink.Event(7))
        router.clear()
        assertNull(router.pending.value)
    }
}
