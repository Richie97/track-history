import XCTest

@testable import TrackEvolution

/// What Google Analytics is told about a screen (`AppAnalytics`): its shape, in
/// the web's own paths, and never a record id, a share slug or an invite token.
/// Android's `AnalyticsPathTest` carries the same table.
@MainActor
final class AnalyticsPathTests: XCTestCase {

    private let table: [(Route, String)] = [
        (.event(12), "/event/:id"),
        (.eventForm(.new(presetTrack: nil)), "/new"),
        (.eventForm(.new(presetTrack: "Road Atlanta")), "/new"),
        (.eventForm(.edit(12)), "/event/:id/edit"),
        (.track(3), "/track/:id"),
        (.leaderboard(trackId: 3), "/track/:id/leaderboard"),
        (.vehicle(4), "/vehicle/:id"),
        (.settings, "/settings"),
        (.record(eventId: nil), "/record"),
        (.record(eventId: 12), "/record"),
        (.importVideo(eventId: 12, incoming: nil), "/import"),
        (.importVideo(eventId: nil, incoming: URL(fileURLWithPath: "/tmp/clip-2026.mp4")), "/import"),
        (.shared(slug: "eric-r"), "/share/:slug"),
        (.lap(eventId: 12, sessionId: 40, lapId: 991), "/event/:id/lap/:id"),
        (.wrapped(year: 2026), "/wrapped/2026"),
        (.coaching, "/coaching"),
        (.profile, "/profile"),
        (.coachInvite(token: "s3cr3t-t0k3n"), "/coach"),
        (.student(id: 8, page: .home), "/student/:id"),
        (.student(id: 8, page: .event(12)), "/student/:id/event/:id"),
        (.student(id: 8, page: .track(3)), "/student/:id/track/:id"),
        (.student(id: 8, page: .lap(eventId: 12, sessionId: 40, lapId: 991)), "/student/:id/event/:id/lap/:id"),
        (.student(id: 8, page: .vehicle(4)), "/student/:id/vehicle/:id"),
    ]

    func testReportsEachScreenByTheWebsPathShape() {
        for (route, path) in table {
            XCTAssertEqual(route.analyticsPath, path, "\(route)")
        }
    }

    func testNeverReportsAnIdASlugOrAToken() {
        for (route, _) in table {
            let path = route.analyticsPath
            // Wrapped's year is the one value kept, as on the web.
            if case .wrapped = route {} else {
                XCTAssertFalse(path.contains(where: \.isNumber), path)
            }
            XCTAssertFalse(path.contains("eric") || path.contains("s3cr3t"), path)
        }
    }

    /// The router reports what is on top: a window-owning route, else the top of
    /// the visible tab's stack, else that tab's root.
    func testTheRouterReportsTheScreenOnTop() {
        let router = AppRouter(runsOnMac: false)
        XCTAssertEqual(router.analyticsPath, "/")
        router.tab = .garage
        XCTAssertEqual(router.analyticsPath, "/garage")
        router.push(.vehicle(4))
        XCTAssertEqual(router.analyticsPath, "/vehicle/:id")
        router.tab = .events
        router.push(.event(12))
        router.push(.lap(eventId: 12, sessionId: 40, lapId: 991))
        XCTAssertEqual(router.analyticsPath, "/event/:id/lap/:id")
        router.fullWindow = .record(eventId: 12)
        XCTAssertEqual(router.analyticsPath, "/record")
    }
}
