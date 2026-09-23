import XCTest
import TrackEvolutionKit

@testable import TrackEvolution

/// The navigation semantics the two-pane shell rests on (spec: NS-34 ticket 2).
///
/// The shell itself is layout and is checked by eye and on Android by Robolectric;
/// what is worth pinning here is the *rule*, because the whole design depends on
/// one claim that is easy to state and easy to break: **`open` and `push` are the
/// same operation from the dashboard**, because the dashboard is the stack's root
/// at compact width and appending to an empty path is replacing it. If that ever
/// stops being true, one shell silently gets different navigation from the other.
@MainActor
final class RouterTests: XCTestCase {

    // MARK: - open vs push

    /// From the dashboard — an empty path — the two are indistinguishable, which
    /// is what lets `DashboardScreen` carry no width check for navigation.
    func testOpenAndPushAgreeFromTheDashboard() {
        let pushed = AppRouter()
        pushed.push(.track(7))

        let opened = AppRouter()
        opened.open(.track(7))

        XCTAssertEqual(pushed.path, opened.path)
        XCTAssertEqual(opened.path, [.track(7)])
    }

    /// Deeper in, they differ, and that difference is the point: the list pane
    /// replaces the detail rather than stacking a second track on the first.
    func testOpenReplacesTheDetailWherePushWouldDeepenIt() {
        let router = AppRouter()
        router.show(.event(1))
        router.push(.track(2))
        XCTAssertEqual(router.path, [.event(1), .track(2)])

        router.open(.track(9))
        XCTAssertEqual(router.path, [.track(9)], "the list pane replaces the detail")
    }

    // MARK: - selection

    /// Selection is the detail's *root*, so a push within the detail leaves the
    /// list's highlight where it was — the row you picked is still the one the
    /// detail belongs to.
    func testSelectionIsTheDetailsRoot() {
        let router = AppRouter()
        XCTAssertNil(router.selection, "nothing selected shows the empty state")

        router.open(.event(4))
        XCTAssertEqual(router.selection, .event(4))

        router.push(.track(5))
        XCTAssertEqual(router.selection, .event(4), "a push within the detail keeps the selection")

        router.popToRoot()
        XCTAssertNil(router.selection)
    }

    /// A deep link moves the selection with it, for free — the reason `selection`
    /// is derived from `path` rather than stored beside it.
    func testDeepLinkMovesTheSelection() {
        let router = AppRouter()
        router.open(.track(1))
        XCTAssertTrue(router.open(URL(string: "https://trackevolution.app/share/abc")!, signedIn: true))
        XCTAssertEqual(router.selection, .shared(slug: "abc"))
    }

    // MARK: - tabs (NS-37)

    /// Opening a car — from the garage list, a deep link, the dashboard's hero —
    /// lands on the Garage tab, and the Events stack is left exactly as it was.
    func testShowingACarSwitchesToTheGarageAndKeepsTheEventsStack() {
        let router = AppRouter()
        router.show(.event(1))
        router.push(.track(2))

        router.show(.vehicle(5))
        XCTAssertEqual(router.tab, .garage)
        XCTAssertEqual(router.path, [.vehicle(5)])
        XCTAssertEqual(router.eventsPath, [.event(1), .track(2)], "the other tab keeps its place")

        router.show(.event(9))
        XCTAssertEqual(router.tab, .events)
        XCTAssertEqual(router.garagePath, [.vehicle(5)])
    }

    /// A push stays on the tab you are on: an event page linking to its car keeps
    /// the car on the Events stack, so Back returns to the event.
    func testAPushNeverChangesTab() {
        let router = AppRouter()
        router.show(.event(1))
        router.push(.vehicle(3))
        XCTAssertEqual(router.tab, .events)
        XCTAssertEqual(router.eventsPath, [.event(1), .vehicle(3)])
        XCTAssertTrue(router.garagePath.isEmpty)
    }

    /// Settings belongs to neither tab and opens wherever you are.
    func testSettingsOpensOnTheCurrentTab() {
        let router = AppRouter()
        router.tab = .garage
        router.open(.settings)
        XCTAssertEqual(router.tab, .garage)
        XCTAssertEqual(router.garagePath, [.settings])
    }

    /// A link to the dashboard goes home: the Events tab's root.
    func testTheDashboardLinkReturnsToTheEventsRoot() {
        let router = AppRouter()
        router.show(.vehicle(1))
        XCTAssertTrue(router.open(URL(string: "https://trackevolution.app/#/")!, signedIn: true))
        XCTAssertEqual(router.tab, .events)
        XCTAssertTrue(router.eventsPath.isEmpty)
    }

    /// Temp ids follow their rows on both stacks, not only the one on screen.
    func testTempIdsAreRemappedOnBothTabs() {
        let router = AppRouter()
        router.eventsPath = [.event(-3)]
        router.garagePath = [.vehicle(2), .event(-3)]
        router.remapTempIds { $0 == -3 ? 40 : nil }
        XCTAssertEqual(router.eventsPath, [.event(40)])
        XCTAssertEqual(router.garagePath, [.vehicle(2), .event(40)])
    }

    // MARK: - which routes own the window

    /// The recorder and the importer, and nothing else. A new route added to
    /// `Route` has to make this decision explicitly — the switch is exhaustive,
    /// so it will not compile until it does.
    func testOnlyTheRecorderAndImporterOwnTheWindow() {
        XCTAssertTrue(Route.record(eventId: nil).ownsTheWindow)
        XCTAssertTrue(Route.record(eventId: 3).ownsTheWindow)
        XCTAssertTrue(Route.importVideo(eventId: nil, incoming: nil).ownsTheWindow)
        XCTAssertTrue(Route.importVideo(eventId: nil, incoming: nil, forNewEvent: true).ownsTheWindow)
        XCTAssertTrue(Route.wrapped(year: 2026).ownsTheWindow)

        XCTAssertFalse(Route.event(1).ownsTheWindow)
        XCTAssertFalse(Route.track(1).ownsTheWindow)
        XCTAssertFalse(Route.vehicle(1).ownsTheWindow)
        XCTAssertFalse(Route.settings.ownsTheWindow)
        XCTAssertFalse(Route.shared(slug: "x").ownsTheWindow)
        XCTAssertFalse(Route.eventForm(.new(presetTrack: nil)).ownsTheWindow)
        XCTAssertFalse(Route.eventForm(.edit(2)).ownsTheWindow)
        XCTAssertFalse(Route.lap(eventId: 1, sessionId: 2, lapId: 3).ownsTheWindow)
    }

    /// A lap route carries three ids and any of them can be an offline temp id
    /// (#267); each follows its own row when the queue flushes, and a real id
    /// is left alone.
    func testALapRouteFollowsEachOfItsTempIds() {
        let router = AppRouter()
        router.show(.event(-1))
        router.push(.lap(eventId: -1, sessionId: -2, lapId: 7))

        router.remapTempIds { [-1: 41, -2: 42][$0] }
        XCTAssertEqual(router.path, [.event(41), .lap(eventId: 41, sessionId: 42, lapId: 7)])

        // A temp id the store cannot resolve yet stays as it is.
        router.push(.lap(eventId: 41, sessionId: -3, lapId: -4))
        router.remapTempIds { [-4: 9][$0] }
        XCTAssertEqual(router.path.last, .lap(eventId: 41, sessionId: -3, lapId: 9))
    }

    /// A window-owning route is presented rather than pushed, and — the part that
    /// matters — it does **not** disturb the path underneath it. Dismissing the
    /// recorder puts you back exactly where you were.
    func testFullWindowPresentationLeavesThePathAlone() {
        // Explicit rather than the default, which is the machine the tests run
        // on: as *My Mac (Designed for iPad)* the recorder resolves away.
        let router = AppRouter(runsOnMac: false)
        router.open(.event(2))

        router.presentFullWindow(.record(eventId: 2))
        XCTAssertEqual(router.fullWindow, .record(eventId: 2))
        XCTAssertEqual(router.path, [.event(2)], "presenting must not change where the detail is")

        router.dismissFullWindow()
        XCTAssertNil(router.fullWindow)
        XCTAssertEqual(router.path, [.event(2)])
    }

    // MARK: - the event page's doors (#270)

    /// From a page, the recorder and the importer cover the window at expanded
    /// width and leave the page underneath; below it they are ordinary pushes.
    func testAPageDoorCoversTheWindowOnlyAtExpandedWidth() {
        for door in [Route.record(eventId: 2), .importVideo(eventId: 2, incoming: nil)] {
            let wide = AppRouter(runsOnMac: false)
            wide.open(.event(2))
            wide.push(door, at: .expanded)
            XCTAssertEqual(wide.fullWindow, door)
            XCTAssertEqual(wide.path, [.event(2)], "the page stays under the cover")

            for narrow in [LayoutClass.compact, .medium] {
                let router = AppRouter(runsOnMac: false)
                router.open(.event(2))
                router.push(door, at: narrow)
                XCTAssertNil(router.fullWindow)
                XCTAssertEqual(router.path, [.event(2), door])
            }
        }

        // A route that does not own the window is a push at every width.
        let router = AppRouter(runsOnMac: false)
        router.open(.event(2))
        router.push(.track(1), at: .expanded)
        XCTAssertNil(router.fullWindow)
        XCTAssertEqual(router.path, [.event(2), .track(1)])
    }

    /// The list pane's version: a cover at expanded width, a replaced detail
    /// otherwise — what the dashboard did inline before the rule moved here.
    func testTheListPaneOpensThroughTheSameRule() {
        let wide = AppRouter(runsOnMac: false)
        wide.open(.event(2))
        wide.open(.record(eventId: nil), at: .expanded)
        XCTAssertEqual(wide.fullWindow, .record(eventId: nil))
        XCTAssertEqual(wide.path, [.event(2)])

        let narrow = AppRouter(runsOnMac: false)
        narrow.open(.record(eventId: nil), at: .compact)
        XCTAssertNil(narrow.fullWindow)
        XCTAssertEqual(narrow.path, [.record(eventId: nil)])
    }

    /// Finishing a task in a cover closes the cover and keeps the page it was
    /// started from; in a stack it pops to the dashboard, as it always has.
    func testFinishingAWindowOwningTaskClosesTheCoverAndKeepsThePage() {
        let router = AppRouter(runsOnMac: false)
        router.open(.event(2))
        router.push(.record(eventId: 2), at: .expanded)
        router.finishWindowOwningTask()
        XCTAssertNil(router.fullWindow)
        XCTAssertEqual(router.path, [.event(2)])

        router.push(.record(eventId: 2), at: .compact)
        router.finishWindowOwningTask()
        XCTAssertEqual(router.path, [])
    }

    /// On a Mac a page's Record door lands on the event as a push, never a cover.
    func testOnAMacAPageRecordDoorIsNeverACover() {
        let router = AppRouter(runsOnMac: true)
        router.open(.event(2))
        router.push(.record(eventId: 5), at: .expanded)
        XCTAssertNil(router.fullWindow)
        XCTAssertEqual(router.path, [.event(2), .event(5)])
    }

    // MARK: - the Mac has no recorder

    /// On a Mac (epic #230) no way of asking for the recorder reaches it: a
    /// presentation opens the event instead of covering the window, a push lands
    /// on the event, and one with no event goes to the dashboard. Applied on the
    /// router rather than at each door, so a door the surface rules missed — a
    /// stale path, the banner's sheet — is caught here too.
    func testOnAMacTheRecordRouteLandsOnItsEventOrTheDashboard() {
        let router = AppRouter(runsOnMac: true)
        router.open(.event(2))

        router.presentFullWindow(.record(eventId: 2))
        XCTAssertNil(router.fullWindow, "nothing covers the window")
        XCTAssertEqual(router.path, [.event(2)])

        router.push(.record(eventId: 5))
        XCTAssertEqual(router.path, [.event(2), .event(5)], "a push lands on the event")

        router.show(.record(eventId: 7))
        XCTAssertEqual(router.path, [.event(7)])

        router.push(.record(eventId: nil))
        XCTAssertEqual(router.path, [], "no event means the dashboard")

        // The importer is untouched: Finder is a better import door than a phone.
        router.presentFullWindow(.importVideo(eventId: 1, incoming: nil))
        XCTAssertEqual(router.fullWindow, .importVideo(eventId: 1, incoming: nil))
    }

    /// Off the Mac the router is what it was — the resolution is the identity.
    func testOffTheMacTheRecordRouteIsPushedAsItself() {
        let router = AppRouter(runsOnMac: false)
        router.push(.record(eventId: nil))
        XCTAssertEqual(router.path, [.record(eventId: nil)])
    }

    // MARK: - deep links land the same place at every width

    /// `show(_:)` is what every deep link goes through, and it means the same
    /// thing in both shells: the detail's root. That is the whole reason the two
    /// shells could share one path — there is no width-dependent branch for a
    /// link to fall down.
    func testEveryDeepLinkResolvesToASingleRootedPath() {
        let cases: [(String, Route?)] = [
            ("https://trackevolution.app/", nil),
            ("https://trackevolution.app/share/slug", .shared(slug: "slug")),
            ("trackevolution://event/12", .event(12)),
        ]
        for (url, expected) in cases {
            let router = AppRouter()
            // Somewhere else entirely first, so "replaces" is actually tested.
            router.show(.vehicle(99))
            router.push(.settings)

            XCTAssertTrue(router.open(URL(string: url)!, signedIn: true), "\(url) should be ours")
            XCTAssertEqual(router.path, expected.map { [$0] } ?? [], "\(url)")
        }
    }

    // MARK: - The New Event form's import

    /// An import pushed from the New Event form hands its sessions back through
    /// the router, and the form empties the hand-off when it takes them — so a
    /// second form later never inherits a stale batch.
    func testStagedSessionsAreHandedBackAlongThePath() {
        let router = AppRouter()
        router.push(.eventForm(.new(presetTrack: nil)))
        router.push(.importVideo(eventId: nil, incoming: nil, forNewEvent: true))

        let draft = SessionDraft(label: "PDR 09:15:00", laps: [121_240])
        router.stagedSessions += [draft]
        router.path.removeLast()

        XCTAssertEqual(router.path, [.eventForm(.new(presetTrack: nil))], "back on the form")
        XCTAssertEqual(router.stagedSessions, [draft])
        router.stagedSessions = []
        XCTAssertTrue(router.stagedSessions.isEmpty)
    }

    /// The remap keeps the new-event flag: a form-started import never carries an
    /// event id, but the case is rewritten by the same code path as the others.
    func testRemapKeepsTheNewEventFlag() {
        let router = AppRouter()
        router.path = [.eventForm(.new(presetTrack: nil)), .importVideo(eventId: nil, incoming: nil, forNewEvent: true)]
        router.remapTempIds { _ in 9 }
        XCTAssertEqual(router.path, [.eventForm(.new(presetTrack: nil)), .importVideo(eventId: nil, incoming: nil, forNewEvent: true)])
    }
}
