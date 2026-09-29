import XCTest
import TrackEvolutionKit

@testable import TrackEvolution

/// Share with a coach (NS-38): where an invite link lands, where a student's
/// logbook opens, and how its pages link — the app-side decisions, pure enough to
/// pin without a screen. The Kit's `CoachingTests` / `CoachingAPITests` pin the
/// rest (the ported wording, the prefix, the read-only refusal and whose tier the
/// channel panel reads).
@MainActor
final class CoachingRoutesTests: XCTestCase {
    private let invite = URL(string: "https://trackevolution.app/coach/Ab_9-xY")!
    private let student = LogbookOwner.student(id: 7, name: "Alex", pro: true)

    /// Opened signed out, the link is parked rather than dropped — the way any
    /// link is held across the sign-in — and opens the accept screen after it.
    func testAnInviteOpenedSignedOutIsParkedUntilSignIn() {
        let router = AppRouter()
        XCTAssertTrue(router.open(invite, signedIn: false))
        XCTAssertEqual(router.path, [], "nothing to show before there is an account")

        router.applyPending()
        XCTAssertEqual(router.tab, .events)
        XCTAssertEqual(router.path, [.coachInvite(token: "Ab_9-xY")])
    }

    func testAnInviteOpenedSignedInReplacesWhereverYouWere() {
        let router = AppRouter()
        router.show(.vehicle(3))
        XCTAssertTrue(router.open(invite, signedIn: true))
        XCTAssertEqual(router.tab, .events)
        XCTAssertEqual(router.path, [.coachInvite(token: "Ab_9-xY")])
    }

    /// A student is a pushed destination on the **Events** tab, never a tab of
    /// their own — even when Settings (and so Coaching) was opened from the Garage.
    func testAStudentOpensOnTheEventsStack() {
        let router = AppRouter()
        router.push(.settings)
        router.push(.coaching)
        router.openStudent(7)
        XCTAssertEqual(router.eventsPath, [.settings, .coaching, .student(id: 7, page: .home)])

        let fromGarage = AppRouter()
        fromGarage.tab = .garage
        fromGarage.push(.settings)
        fromGarage.push(.coaching)
        fromGarage.openStudent(7)
        XCTAssertEqual(fromGarage.tab, .events)
        XCTAssertEqual(fromGarage.eventsPath, [.student(id: 7, page: .home)])
        XCTAssertEqual(fromGarage.garagePath, [.settings, .coaching], "the garage keeps its place")
        XCTAssertEqual(Route.student(id: 7, page: .vehicle(2)).tab, .events, "their car is theirs, not your garage's")
    }

    /// `L()`: a student's pages link inside their logbook, and anything that
    /// writes lands on their dashboard instead of the coach's own logbook.
    func testAStudentsLinksStayInsideTheirLogbook() {
        XCTAssertEqual(student.link(.event(5)), .student(id: 7, page: .event(5)))
        XCTAssertEqual(student.link(.track(2)), .student(id: 7, page: .track(2)))
        XCTAssertEqual(student.link(.vehicle(4)), .student(id: 7, page: .vehicle(4)))
        XCTAssertEqual(
            student.link(.lap(eventId: 5, sessionId: 6, lapId: 8)),
            .student(id: 7, page: .lap(eventId: 5, sessionId: 6, lapId: 8))
        )
        for door: Route in [
            .eventForm(.new(presetTrack: nil)), .eventForm(.edit(5)), .leaderboard(trackId: 2),
            .record(eventId: 5), .importVideo(eventId: 5, incoming: nil), .wrapped(year: 2026)
        ] {
            XCTAssertEqual(student.link(door), .student(id: 7, page: .home), "\(door)")
        }
        // Your own logbook's links are themselves.
        XCTAssertEqual(LogbookOwner.me.link(.event(5)), .event(5))
        XCTAssertEqual(LogbookOwner.me.link(.leaderboard(trackId: 2)), .leaderboard(trackId: 2))
    }

    /// A revoked grant takes every page of that student off the stacks, and only
    /// theirs.
    func testDroppingAStudentPopsOnlyTheirPages() {
        let router = AppRouter()
        router.eventsPath = [
            .settings, .coaching, .student(id: 7, page: .home), .student(id: 7, page: .event(5)),
            .student(id: 7, page: .lap(eventId: 5, sessionId: 6, lapId: 8))
        ]
        router.dropStudent(7)
        XCTAssertEqual(router.eventsPath, [.settings, .coaching])

        router.eventsPath = [.coaching, .student(id: 9, page: .home)]
        router.dropStudent(7)
        XCTAssertEqual(router.eventsPath, [.coaching, .student(id: 9, page: .home)])
    }

    /// None of the coaching routes owns the window, and a student's ids are
    /// never remapped: a coach cannot write, so nothing in their view is temp.
    func testCoachingRoutesArePanesAndNeverRemapped() {
        let routes: [Route] = [
            .coaching, .profile, .coachInvite(token: "t"), .student(id: 7, page: .event(-3))
        ]
        for route in routes {
            XCTAssertFalse(route.ownsTheWindow, "\(route)")
        }
        let router = AppRouter()
        router.eventsPath = routes
        router.remapTempIds { _ in 42 }
        XCTAssertEqual(router.eventsPath, routes)
    }

    /// Whose tier the channel panel opens by, as the screens ask it: a free
    /// coach reading a Pro student's session sees the Grip tab and the rest of
    /// the Pro half, because the student paid for it.
    func testAFreeCoachOfAProStudentGetsTheFullPanel() {
        let freeCoach: Entitlement? = .free
        XCTAssertTrue(student.canViewChannels(viewer: freeCoach))
        XCTAssertFalse(LogbookOwner.me.canViewChannels(viewer: freeCoach))
        XCTAssertFalse(
            LogbookOwner.student(id: 7, name: nil, pro: false).canViewChannels(viewer: Entitlement(tier: .pro))
        )
    }
}
