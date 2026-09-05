import XCTest

/// The recorder end to end: record a drive, pick the start/finish line, save the
/// session. Everything between the fix stream and a row in the logbook.
///
/// Needs a dev server *and* a simulated drive. It skips without the server; with the
/// server but no drive it *fails*, because nothing probes for movement — see the loop
/// sizing below before suspecting the lap maths.
///
///     npm run dev
///     xcrun simctl location <device> start --speed=25 --interval=0.5 <waypoints…>
///     xcodebuild test -project apps/ios/TrackEvolution.xcodeproj -scheme TrackEvolution \
///       -destination 'platform=iOS Simulator,name=iPhone 17' \
///       -only-testing:TrackEvolutionUITests/RecordAndSaveUITests
///
/// The recording has to run for over a minute of *driving*, because `toParsed`
/// refuses anything shorter — so this test is slow by nature, not by accident.
///
/// ## The loop has to be the right size
///
/// Not any closed circuit will do, and getting this wrong looks exactly like a broken
/// lap-timing bug. Two constraints pull against each other:
///
/// - `lapsFromCrossings` discards anything under **`minLapS = 30`** (`geo.js`), so a
///   small loop produces laps that are all correctly thrown away — you tap the line and
///   get "No laps cross the picked line".
/// - The recording only drives for ~78 s, and one lap needs **two** crossings, so a
///   large loop never completes two.
///
/// That leaves roughly a 30–35 s lap. At `--speed=25` that's an 800 m circuit — a
/// circle of radius ~128 m (0.00115° of latitude), which is what this was verified
/// with. A 90 m circle gives 22 s laps and finds nothing; a 167 m one gives 42 s laps
/// and only completes 1.9 of them.
final class RecordAndSaveUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testRecordsPicksALineAndSavesASession() throws {
        let app = try launchSignedIn(tier: .pro)

        // The recorder's entry point is an event page (NS-25): the recording is saved
        // as one of that event's sessions, so this is where it's started from.
        XCTAssertTrue(openADrivenEvent(app), "the seeded logbook should have a driven event")

        let entry = app.buttons["recordEntry"]
        XCTAssertTrue(scrollTo(entry, in: app), "the event page carries the recorder entry point")
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

    /// Discarding leaves the recorder entirely.
    ///
    /// It used to pop one step, back onto a Start button — you discarded the recording
    /// because you didn't want it, and the app immediately offered to record the same
    /// nothing again. Fast, because it needs no *timeable* recording: a few seconds of
    /// fixes is enough to reach review, where the discard button lives whether or not
    /// the trace yielded any laps.
    func testDiscardingARecordingReturnsToTheDashboard() throws {
        let app = try launchSignedIn(tier: .pro)

        XCTAssertTrue(openADrivenEvent(app))
        XCTAssertTrue(
            app.staticTexts["Best time"].waitForExistence(timeout: 20),
            "should have navigated to the event page"
        )

        let entry = app.buttons["recordEntry"]
        XCTAssertTrue(scrollTo(entry, in: app), "the recorder entry point is on the event page")
        entry.tap()

        let start = app.buttons["Start recording"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()

        let stop = app.buttons["Stop recording"]
        XCTAssertTrue(stop.waitForExistence(timeout: 10), "the button should flip to Stop")
        // A few seconds of fixes is enough to reach review — no timeable lap needed.
        let recorded = expectation(description: "a few fixes")
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { recorded.fulfill() }
        wait(for: [recorded], timeout: 20)
        stop.tap()

        let review = app.buttons["Review & save"]
        XCTAssertTrue(review.waitForExistence(timeout: 10))
        review.tap()

        let discard = app.buttons["Discard recording"]
        XCTAssertTrue(discard.waitForExistence(timeout: 10))
        discard.tap()
        app.buttons["Discard"].tap()  // the confirmation

        XCTAssertTrue(
            app.buttons["+ Add event"].waitForExistence(timeout: 15),
            "discarding should land on the dashboard, not back on the recorder"
        )
        XCTAssertFalse(app.buttons["Start recording"].exists, "and not on a Start button")
    }
}
