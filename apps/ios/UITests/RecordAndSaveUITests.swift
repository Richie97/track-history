import XCTest

/// The recorder end to end: record a drive, pick the start/finish line, save the
/// session. Everything between the fix stream and a row in the logbook.
///
/// Needs a dev server *and* a simulated drive, so it skips unless both are set up:
///
///     npm run dev
///     xcrun simctl location <device> start --speed=25 --interval=0.5 <waypoints…>
///     xcodebuild test -project apps/ios/TrackEvolution.xcodeproj -scheme TrackEvolution \
///       -destination 'platform=iOS Simulator,name=iPhone 17' \
///       -only-testing:TrackEvolutionUITests/RecordAndSaveUITests
///
/// The recording has to run for over a minute of *driving*, because `toParsed`
/// refuses anything shorter — so this test is slow by nature, not by accident.
final class RecordAndSaveUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testRecordsPicksALineAndSavesASession() throws {
        let app = try launchSignedIn()

        // The recorder's entry point is an event page (NS-25): the recording is saved
        // as one of that event's sessions, so this is where it's started from.
        let event = app.buttons["recentEventCard"].firstMatch
        XCTAssertTrue(event.waitForExistence(timeout: 20), "the seeded logbook should have an event")
        event.tap()

        let entry = app.buttons["recordEntry"]
        XCTAssertTrue(entry.waitForExistence(timeout: 15), "the event page carries the recorder entry point")
        entry.tap()

        let start = app.buttons["Start recording"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()

        let stop = app.buttons["Stop recording"]
        XCTAssertTrue(stop.waitForExistence(timeout: 10), "the button should flip to Stop")

        // `toParsed` needs 30+ fixes and 60+ seconds after idle-trimming, so let the
        // simulated drive run past both.
        let fixesArrived = expectation(description: "fixes accumulate")
        DispatchQueue.main.asyncAfter(deadline: .now() + 80) { fixesArrived.fulfill() }
        wait(for: [fixesArrived], timeout: 120)

        stop.tap()

        // Review: pick a line, and the laps appear.
        let review = app.buttons["Review & save"]
        if !review.waitForExistence(timeout: 10) {
            let buttons = app.buttons.allElementsBoundByIndex.map { $0.label }
            let texts = app.staticTexts.allElementsBoundByIndex.map { $0.label }
            XCTFail("no \"Review & save\" after stopping. buttons: \(buttons) texts: \(texts)")
        }
        review.tap()

        // Matched by identifier, not by text: the card's heading uses the eyebrow
        // style, which uppercases it.
        let map = app.buttons["linePickerMap"]
        XCTAssertTrue(map.waitForExistence(timeout: 10), "the review screen should show the line picker")

        // The picker takes the nearest trace point to wherever you tap, so anywhere
        // on the map yields a pick.
        map.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()

        XCTAssertTrue(
            app.staticTexts["Lap 1"].waitForExistence(timeout: 10),
            "picking a line on a multi-lap trace should time at least one lap"
        )

        // Kept on success too: the trace and gate are drawn in a Canvas, so a
        // render that goes wrong wouldn't fail an assertion — this is the only
        // artifact that shows it. Export with:
        //   xcrun xcresulttool export attachments --path <result>.xcresult --output-path <dir>
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "review-with-laps"
        shot.lifetime = .keepAlways
        add(shot)

        // Save.
        let save = app.buttons["Save session"]
        XCTAssertTrue(save.waitForExistence(timeout: 5))
        save.tap()

        // Back on the recording screen, with nothing left to review — the recording
        // is only forgotten once the server has it.
        XCTAssertTrue(
            app.buttons["Start recording"].waitForExistence(timeout: 20),
            "a saved recording should clear, leaving the recorder ready again"
        )
        XCTAssertFalse(app.buttons["Review & save"].exists)
    }

}
