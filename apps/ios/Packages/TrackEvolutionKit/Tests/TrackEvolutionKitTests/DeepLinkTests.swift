import Foundation
import Testing

@testable import TrackEvolutionKit

/// The routing table, tested as data rather than tapped through.
struct DeepLinkTests {
    private func parse(_ string: String) -> DeepLink? {
        DeepLink.parse(URL(string: string)!)
    }

    @Test
    func shareLinksResolveToTheirLogbook() {
        #expect(parse("https://trackevolution.app/share/eric") == .shared(slug: "eric"))
        #expect(parse("https://trackevolution.app/share/eric/") == .shared(slug: "eric"))
        // The web app's own hash route rides along inside a share URL; the logbook
        // root is the honest answer, since the shared page's tracks are one tap in.
        #expect(parse("https://trackevolution.app/share/eric#/track/7") == .shared(slug: "eric"))
    }

    @Test
    func sharedItemLinksResolveAheadOfTheSlugRule() {
        // NS-48: one event or one session. Before this rule `/share/e/<token>`
        // parsed as the logbook with slug "e".
        let token = "k3Jx9_AbCdEfGhIjKlMn-o"
        #expect(parse("https://trackevolution.app/share/e/\(token)") == .sharedItem(kind: .event, token: token))
        #expect(parse("https://trackevolution.app/share/s/\(token)") == .sharedItem(kind: .session, token: token))
        #expect(parse("https://trackevolution.app/share/s/\(token)/") == .sharedItem(kind: .session, token: token))
        // A one-letter segment is never a slug (three characters minimum), so a
        // malformed token — short, long, a stray character, or none — is nobody's
        // link rather than someone's logbook.
        #expect(parse("https://trackevolution.app/share/e") == .dashboard)
        #expect(parse("https://trackevolution.app/share/e/short") == .dashboard)
        #expect(parse("https://trackevolution.app/share/e/\(token)x") == .dashboard)
        #expect(parse("https://trackevolution.app/share/e/k3Jx9.AbCdEfGhIjKlMn-o") == .dashboard)
        #expect(parse("https://trackevolution.app/share/s/\(token)/more") == .dashboard)
        // Another letter is a slug as it always was; so is a slug starting with one.
        #expect(parse("https://trackevolution.app/share/eric") == .shared(slug: "eric"))
        #expect(parse("https://trackevolution.app/share/sam/\(token)") == .shared(slug: "sam"))
    }

    @Test
    func coachInvitesResolveToTheirToken() {
        // NS-38: the link a driver sends their coach, advertised in the
        // association file beside /share/*.
        #expect(parse("https://trackevolution.app/coach/Ab_9-xY") == .coachInvite(token: "Ab_9-xY"))
        #expect(parse("https://trackevolution.app/coach/Ab_9-xY/") == .coachInvite(token: "Ab_9-xY"))
        // Nothing to accept, or something deeper than a token: not an invite, and
        // a mangled token must never reach a single-use endpoint.
        #expect(parse("https://trackevolution.app/coach") == .dashboard)
        #expect(parse("https://trackevolution.app/coach/a/b") == .dashboard)
    }

    @Test
    func appHashRoutesResolve() {
        #expect(parse("https://trackevolution.app/#/event/5") == .event(5))
        #expect(parse("https://trackevolution.app/#/event/5/edit") == .editEvent(5))
        #expect(parse("https://trackevolution.app/#/track/7") == .track(7))
        // A garage page. The web dashboard's maintenance chips link here, so a
        // link shared from a desk browser has to land on the same car.
        #expect(parse("https://trackevolution.app/#/vehicle/3") == .vehicle(3))
        // An unparseable id falls back to the dashboard rather than a blank screen.
        #expect(parse("https://trackevolution.app/#/vehicle/notanid") == .dashboard)
        #expect(parse("https://trackevolution.app/#/settings") == .settings)
        #expect(parse("https://trackevolution.app/") == .dashboard)
        #expect(parse("https://trackevolution.app/#/") == .dashboard)
    }

    @Test
    func newEventCarriesItsPresetTrack() {
        // The track page's "+ Add event at …" link, percent-encoded — and the layout
        // suffix has to survive intact or the event lands at the wrong circuit.
        #expect(
            parse("https://trackevolution.app/#/new?track=Virginia%20International%20Raceway%20(Full)")
                == .newEvent(presetTrack: "Virginia International Raceway (Full)")
        )
        #expect(parse("https://trackevolution.app/#/new") == .newEvent(presetTrack: nil))
    }

    @Test
    func theRecordScreenIsNotLinkable() {
        // Reachable from inside the app only: an outside link that armed the GPS
        // recorder would be a genuine surprise.
        #expect(parse("https://trackevolution.app/#/event/5/record") == .event(5))
    }

    @Test
    func theAuthRedirectIsNeverARoute() {
        // ASWebAuthenticationSession consumes this; treating it as navigation would
        // race the sign-in flow for the one-time code.
        #expect(parse("trackevolution://auth?code=abc123") == nil)
    }

    @Test
    func theCustomSchemeStillResolves() {
        #expect(parse("trackevolution://event/5") == .event(5))
        #expect(parse("trackevolution://track/7") == .track(7))
    }

    @Test
    func foreignAndMalformedLinksAreRejected() {
        #expect(parse("mailto:eric@example.com") == nil)
        // Which hosts may open the app is the association file's business, not this
        // parser's — it never sees a link the OS didn't already match.
        #expect(parse("https://example.com/share/eric") == .shared(slug: "eric"))
        // Anything on our own domain that isn't a route opens the app rather than
        // doing nothing: a garbled link should still land somewhere.
        #expect(parse("https://trackevolution.app/share/") == .dashboard)
        #expect(parse("https://trackevolution.app/#/event/notanid") == .dashboard)
        #expect(parse("https://trackevolution.app/#/nonsense") == .dashboard)
    }
}
