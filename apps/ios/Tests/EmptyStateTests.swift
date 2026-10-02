import XCTest

@testable import TrackEvolution

/// The empty-state component (#342): the one-argument form every screen used
/// before is still the sentence alone, and the action is what it was given.
@MainActor
final class EmptyStateTests: XCTestCase {

    func testTheOneArgumentFormIsTheSentenceAlone() {
        let empty = TEEmpty("No sessions recorded yet.")
        XCTAssertNil(empty.title)
        XCTAssertNil(empty.action)
        XCTAssertEqual(empty.text, "No sessions recorded yet.")
    }

    func testTheTitleAndActionAreCarriedAndTheActionRuns() {
        var ran = 0
        let empty = TEEmpty(
            title: "No events yet",
            "Add an event and its laps, bests and progress start here.",
            action: TEEmpty.Action("Add your first event") { ran += 1 }
        )
        XCTAssertEqual(empty.title, "No events yet")
        XCTAssertEqual(empty.action?.label, "Add your first event")
        empty.action?.perform()
        XCTAssertEqual(ran, 1)
    }

    /// First run (#344): the welcome card names the recorder on a phone and the
    /// iPhone on a Mac, which has none (epic #230).
    func testTheWelcomeCardPointsAMacAtThePhone() {
        XCTAssertTrue(DashboardScreen.welcomeText(runsOnMac: false).contains("record them with this phone"))
        XCTAssertTrue(DashboardScreen.welcomeText(runsOnMac: true).contains("record them with the app on your iPhone"))
        XCTAssertFalse(DashboardScreen.welcomeText(runsOnMac: true).contains("this phone"))
    }
}
