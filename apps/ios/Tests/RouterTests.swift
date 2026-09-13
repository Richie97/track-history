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

    // MARK: - which routes own the window

    /// The recorder and the importer, and nothing else. A new route added to
    /// `Route` has to make this decision explicitly — the switch is exhaustive,
    /// so it will not compile until it does.
    func testOnlyTheRecorderAndImporterOwnTheWindow() {
        XCTAssertTrue(Route.record(eventId: nil).ownsTheWindow)
        XCTAssertTrue(Route.record(eventId: 3).ownsTheWindow)
        XCTAssertTrue(Route.importVideo(eventId: nil, incoming: nil).ownsTheWindow)
        XCTAssertTrue(Route.importVideo(eventId: nil, incoming: nil, forNewEvent: true).ownsTheWindow)

        XCTAssertFalse(Route.event(1).ownsTheWindow)
        XCTAssertFalse(Route.track(1).ownsTheWindow)
        XCTAssertFalse(Route.vehicle(1).ownsTheWindow)
        XCTAssertFalse(Route.settings.ownsTheWindow)
        XCTAssertFalse(Route.shared(slug: "x").ownsTheWindow)
        XCTAssertFalse(Route.eventForm(.new(presetTrack: nil)).ownsTheWindow)
        XCTAssertFalse(Route.eventForm(.edit(2)).ownsTheWindow)
    }

    /// A window-owning route is presented rather than pushed, and — the part that
    /// matters — it does **not** disturb the path underneath it. Dismissing the
    /// recorder puts you back exactly where you were.
    func testFullWindowPresentationLeavesThePathAlone() {
        let router = AppRouter()
        router.open(.event(2))

        router.presentFullWindow(.record(eventId: 2))
        XCTAssertEqual(router.fullWindow, .record(eventId: 2))
        XCTAssertEqual(router.path, [.event(2)], "presenting must not change where the detail is")

        router.dismissFullWindow()
        XCTAssertNil(router.fullWindow)
        XCTAssertEqual(router.path, [.event(2)])
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
