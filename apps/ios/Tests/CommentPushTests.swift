import TrackEvolutionKit
import XCTest

@testable import TrackEvolution

/// Coach-comment notifications (NS-54) in the app: where a tapped one lands,
/// that it waits for a sign-in, and the in-context card's words. The data
/// table itself is the Kit's `PushTests`.
@MainActor
final class CommentPushTests: XCTestCase {

    func testALapCommentOpensTheLapInYourOwnLogbook() {
        let target = CommentPushTarget(studentId: nil, eventId: 30, sessionId: 40, lapId: 50)
        XCTAssertEqual(AppRouter.commentRoute(target), .lap(eventId: 30, sessionId: 40, lapId: 50))
    }

    func testASessionCommentOpensTheEvent() {
        let target = CommentPushTarget(studentId: nil, eventId: 30, sessionId: 40, lapId: nil)
        XCTAssertEqual(AppRouter.commentRoute(target), .event(30))
    }

    func testACoachLandsInTheStudentsLogbook() {
        XCTAssertEqual(
            AppRouter.commentRoute(.init(studentId: 7, eventId: 30, sessionId: 40, lapId: 50)),
            .student(id: 7, page: .lap(eventId: 30, sessionId: 40, lapId: 50))
        )
        XCTAssertEqual(
            AppRouter.commentRoute(.init(studentId: 7, eventId: 30, sessionId: 40, lapId: nil)),
            .student(id: 7, page: .event(30))
        )
    }

    func testATapWhileSignedOutWaitsForTheSignIn() {
        let router = AppRouter()
        let link = DeepLink.comment(.init(studentId: nil, eventId: 30, sessionId: 40, lapId: 50))
        router.open(link, signedIn: false)
        XCTAssertTrue(router.eventsPath.isEmpty)
        router.applyPending()
        XCTAssertEqual(router.eventsPath, [.lap(eventId: 30, sessionId: 40, lapId: 50)])
    }

    func testATapWhileSignedInOpensAtOnceOnTheEventsTab() {
        let router = AppRouter()
        router.tab = .garage
        router.open(DeepLink.comment(.init(studentId: 7, eventId: 30, sessionId: 40, lapId: nil)), signedIn: true)
        XCTAssertEqual(router.tab, .events)
        XCTAssertEqual(router.eventsPath, [.student(id: 7, page: .event(30))])
    }

    func testTheCardNamesTheOtherPerson() {
        XCTAssertEqual(PushAskCard.title("Sam Lee"), "Get notified when Sam Lee replies")
        XCTAssertEqual(PushAskCard.title("  "), "Get notified of new comments")
        XCTAssertEqual(PushAskCard.title(nil), "Get notified of new comments")
    }

    func testOnlyAStringPayloadIsRead() {
        let data = PushController.data([
            "kind": "comment", "event_id": "30", "aps": ["badge": 2], "gcm.message_id": "x", 5: "y",
        ])
        XCTAssertEqual(data, ["kind": "comment", "event_id": "30", "gcm.message_id": "x"])
    }
}
