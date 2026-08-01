package app.trackevolution.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * The routing table, tested rather than tapped through. Ported case for case
 * from the iOS `DeepLinkTests`, so a divergence between the two clients' link
 * handling shows up as a failing test on one of them.
 */
class DeepLinkTest {

    @Test
    fun `share links resolve to the public logbook`() {
        assertEquals(
            DeepLink.Shared("eric"),
            DeepLink.parse("https://trackevolution.app/share/eric"),
        )
        // The web app's hash routes live in the fragment, so a deeper share URL
        // still lands on that logbook's root rather than nowhere.
        assertEquals(
            DeepLink.Shared("eric"),
            DeepLink.parse("https://trackevolution.app/share/eric#/track/7"),
        )
    }

    @Test
    fun `the auth redirect is deliberately not a route`() {
        // Parsing it as navigation would race the sign-in flow for a code that
        // is burned on first use.
        assertNull(DeepLink.parse("trackevolution://auth?code=abc123"))
        assertNull(DeepLink.parse("trackevolution://auth"))
    }

    @Test
    fun `hash routes resolve`() {
        assertEquals(DeepLink.Event(5), DeepLink.parse("https://trackevolution.app/#/event/5"))
        assertEquals(DeepLink.EditEvent(5), DeepLink.parse("https://trackevolution.app/#/event/5/edit"))
        assertEquals(DeepLink.Track(7), DeepLink.parse("https://trackevolution.app/#/track/7"))
        assertEquals(DeepLink.Vehicle(3), DeepLink.parse("https://trackevolution.app/#/vehicle/3"))
        assertEquals(DeepLink.Settings, DeepLink.parse("https://trackevolution.app/#/settings"))
    }

    @Test
    fun `a recording route is not reachable from outside`() {
        // Starting a GPS recording from a link would be a surprise; it falls back
        // to the event itself.
        assertEquals(DeepLink.Event(5), DeepLink.parse("https://trackevolution.app/#/event/5/record"))
    }

    @Test
    fun `a preset track name survives percent-encoding`() {
        assertEquals(
            DeepLink.NewEvent("VIR (Full)"),
            DeepLink.parse("https://trackevolution.app/#/new?track=VIR%20(Full)"),
        )
        assertEquals(DeepLink.NewEvent(null), DeepLink.parse("https://trackevolution.app/#/new"))
    }

    @Test
    fun `a plus in a query value is a space, in a path it is not`() {
        assertEquals(
            DeepLink.NewEvent("Road Atlanta"),
            DeepLink.parse("https://trackevolution.app/#/new?track=Road+Atlanta"),
        )
        assertEquals(DeepLink.Shared("a+b"), DeepLink.parse("https://trackevolution.app/share/a+b"))
    }

    @Test
    fun `the bare site opens the dashboard`() {
        assertEquals(DeepLink.Dashboard, DeepLink.parse("https://trackevolution.app/"))
        assertEquals(DeepLink.Dashboard, DeepLink.parse("https://trackevolution.app"))
    }

    @Test
    fun `custom-scheme routes resolve, and unknown ones fall back`() {
        assertEquals(DeepLink.Event(5), DeepLink.parse("trackevolution://event/5"))
        assertEquals(DeepLink.Dashboard, DeepLink.parse("trackevolution://nonsense"))
    }

    @Test
    fun `foreign schemes and garbage are refused`() {
        assertNull(DeepLink.parse("mailto:eric@example.com"))
        assertNull(DeepLink.parse("not a url at all"))
        assertNull(DeepLink.parse(""))
    }

    @Test
    fun `a share link with no slug is not a share link`() {
        assertEquals(DeepLink.Dashboard, DeepLink.parse("https://trackevolution.app/share/"))
    }
}
