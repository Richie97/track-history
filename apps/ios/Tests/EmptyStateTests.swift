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
}
