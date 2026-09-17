import XCTest

@testable import TrackEvolution

/// The recorder's doors on a Mac (epic #230).
///
/// `Platform.runsOnMac` is a fact about the process, so like the layout
/// breakpoints it lives in the app target and not the Kit, and like them the
/// decisions built on it are pure and pinned here for both values — the surface
/// they gate can only be seen by running the app as *My Mac (Designed for iPad)*,
/// which no CI job does.
final class PlatformTests: XCTestCase {

    /// The dashboard's button needs an idle recorder *and* a machine with a GPS.
    /// The idle rule is the one the dashboard always had; the Mac rule is new,
    /// and the two are one function so neither can be forgotten by the other.
    func testDashboardOffersTheRecorderOnlyOffTheMacWithAnIdleRecorder() {
        XCTAssertTrue(Platform.dashboardOffersRecorder(runsOnMac: false, recorderIdle: true))
        XCTAssertFalse(Platform.dashboardOffersRecorder(runsOnMac: false, recorderIdle: false), "a live or unsaved recording has its own control")
        XCTAssertFalse(Platform.dashboardOffersRecorder(runsOnMac: true, recorderIdle: true))
        XCTAssertFalse(Platform.dashboardOffersRecorder(runsOnMac: true, recorderIdle: false))
    }

    /// The event page's card offers the recorder everywhere but the Mac, where the
    /// slot says to record on the phone.
    func testEventPageOffersTheRecorderEverywhereButTheMac() {
        XCTAssertTrue(Platform.eventPageOffersRecorder(runsOnMac: false))
        XCTAssertFalse(Platform.eventPageOffersRecorder(runsOnMac: true))
    }

    /// On a Mac the record route never reaches `RecordingScreen`: it lands on the
    /// event it was for, or on the dashboard (nil) when it had none. Everywhere
    /// else it is itself.
    func testTheRecordRouteResolvesAwayFromTheRecorderOnAMac() {
        XCTAssertEqual(Route.record(eventId: 4).resolved(runsOnMac: true), .event(4))
        XCTAssertNil(Route.record(eventId: nil).resolved(runsOnMac: true))

        XCTAssertEqual(Route.record(eventId: 4).resolved(runsOnMac: false), .record(eventId: 4))
        XCTAssertEqual(Route.record(eventId: nil).resolved(runsOnMac: false), .record(eventId: nil))
    }

    /// Every other route is untouched on a Mac — the importer included, since
    /// Finder is a better import door than a phone.
    func testEveryOtherRouteIsItselfOnAMac() {
        let routes: [Route] = [
            .event(1),
            .eventForm(.new(presetTrack: nil)),
            .eventForm(.edit(2)),
            .track(3),
            .leaderboard(trackId: 3),
            .vehicle(5),
            .settings,
            .importVideo(eventId: 1, incoming: nil),
            .importVideo(eventId: nil, incoming: nil, forNewEvent: true),
            .shared(slug: "abc"),
            .lap(eventId: 1, sessionId: 2, lapId: 3),
        ]
        for route in routes {
            XCTAssertEqual(route.resolved(runsOnMac: true), route, "\(route)")
        }
    }
}
