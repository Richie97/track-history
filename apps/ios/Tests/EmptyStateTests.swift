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

    func testACompactEmptyStateIsMarkedAndTheDefaultIsNot() {
        XCTAssertFalse(TEEmpty("No sessions recorded yet.").compact)
        let compact = TEEmpty(title: nil, "The chart starts once two events here have a lap time.", compact: true)
        XCTAssertTrue(compact.compact)
        XCTAssertNil(compact.title)
        XCTAssertNil(compact.action)
    }

    /// First run (#344): the welcome card names the recorder on track — an iPad
    /// reads it too — and the iPhone on a Mac, which has none (epic #230). The
    /// words are the web's and Android's.
    func testTheWelcomeCardPointsAMacAtThePhone() {
        XCTAssertEqual(
            DashboardScreen.welcomeText(runsOnMac: false),
            "Your logbook starts with an event: the track, the date and the car. Then add its sessions — record them on track, import a video or a logger file, or type your lap times in — and your bests and progress build from there."
        )
        XCTAssertTrue(DashboardScreen.welcomeText(runsOnMac: true).contains("record them with the app on your iPhone"))
        XCTAssertFalse(DashboardScreen.welcomeText(runsOnMac: false).contains("this phone"))
        XCTAssertFalse(DashboardScreen.welcomeText(runsOnMac: true).contains("this phone"))
    }

    /// A finished season with no track days won't get one; only the running
    /// year (or a later one) is "— yet".
    func testAnEmptyWrappedYearIsOnlyYetWhileItCanStillHappen() {
        XCTAssertEqual(WrappedScreen.emptyTitle(2025, currentYear: 2026), "No track days in 2025")
        XCTAssertEqual(WrappedScreen.emptyTitle(2026, currentYear: 2026), "No track days in 2026 — yet")
        XCTAssertEqual(WrappedScreen.emptyTitle(2027, currentYear: 2026), "No track days in 2027 — yet")
    }

    /// The Garage tile's status in the web's and Android's words.
    func testTheGarageTileStatusCountsAlertsElseSaysWhatIsFitted() {
        XCTAssertEqual(GarageScreen.statusLine(alerts: 1, activeParts: 4), "● 1 item due soon")
        XCTAssertEqual(GarageScreen.statusLine(alerts: 3, activeParts: 4), "● 3 items due soon")
        XCTAssertEqual(GarageScreen.statusLine(alerts: 0, activeParts: 2), "● consumables OK")
        XCTAssertEqual(GarageScreen.statusLine(alerts: 0, activeParts: 0), "No consumables tracked yet")
    }
}
