import XCTest

/// The lap stage (NS-51) end to end: a lap with a clip opens video-first, play
/// moves the playhead, a tap on a chart pauses the video and seeks it there, and
/// *Compare laps* opens the two-sided stage whose mode toggles.
///
/// The clip comes the way `LapClipUITests`' does — a committed fixture imported
/// with `-syntheticClipVideo`, cut and uploaded to the dev server's local R2 —
/// because the stage plays a real signed URL. Needs `npm run dev` with a
/// `CLIP_URL_SECRET` in `.dev.vars`; skips without the server.
final class LapStageUITests: XCTestCase {
    private static let track = "Lap Stage Test Circuit (UITest)"

    private var seededEventId: Int?

    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        if let id = seededEventId {
            deleteEventBestEffort(id)
            seededEventId = nil
        }
    }

    func testTheLapStagePlaysSeeksFromAChartAndComparesInBothModes() throws {
        try XCTSkipUnless(devServerIsRunning(), "needs `npm run dev` on :8787")
        try setDevTier(.pro)
        let eventId = try seedEvent()

        // Import with a clip, and wait for the server to hold it.
        var app = XCUIApplication()
        app.launchArguments = [
            "-server.url", Self.devServerURL, "-resetAuth", "-resetRecording", "-authToken", try devSessionToken(),
            "-importFixture", "pdr-delta.mp4", "-importFixtureEvent", String(eventId),
            "-syntheticClipVideo", "YES",
        ]
        app.launch()
        XCTAssertTrue(app.staticTexts["pdr-delta.mp4"].waitForExistence(timeout: 30))
        let save = app.buttons["Save session"]
        XCTAssertTrue(scrollTo(save, in: app))
        save.tap()
        try waitForClip(eventId: eventId)

        // Onto the lap with the video. `-syncMode place` pins the first mode.
        app.terminate()
        app = XCUIApplication()
        app.launchArguments = [
            "-server.url", Self.devServerURL, "-resetAuth", "-resetRecording", "-authToken", try devSessionToken(),
            "-openLink", "trackevolution://event/\(eventId)", "-syncMode", "place",
        ]
        app.launch()
        XCTAssertTrue(app.navigationBars[Self.track].waitForExistence(timeout: 20))
        let lapRow = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "has video")).firstMatch
        XCTAssertTrue(scrollTo(lapRow, in: app))
        lapRow.tap()

        let video = app.descendants(matching: .any)["stageVideoA"]
        XCTAssertTrue(video.waitForExistence(timeout: 20), "the lap opens video-first")
        XCTAssertTrue(wait(video, 30) { $0 == "ready" }, "the clip should load")
        let scrubber = app.descendants(matching: .any)["stageScrubber"]
        let play = app.buttons["stagePlay"]
        let before = value(scrubber)
        attach(app, named: "lap-stage-paused")

        // Play: the scrubber's spoken value advances with the clock.
        play.tap()
        XCTAssertTrue(wait(play, 5) { $0 == "playing" })
        XCTAssertTrue(wait(scrubber, 10) { $0 != before }, "playing should move the playhead")
        attach(app, named: "lap-stage-playing")

        // A tap on the speed chart pauses and seeks there — the value then names
        // a distance on the lap, not the run-up.
        let speed = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Speed by driven distance")).firstMatch
        XCTAssertTrue(scrollTo(speed, in: app), "the panel sits under the stage")
        speed.tap()
        XCTAssertTrue(wait(play, 5) { $0 == "paused" }, "a tap on a chart pauses the video")
        XCTAssertTrue(
            wait(scrubber, 5) { $0.contains(" ft") || $0.contains(" mi") || $0.contains(" m,") || $0.contains(" km") },
            "and the playhead names that distance: \(value(scrubber))"
        )
        attach(app, named: "lap-stage-seeked")

        // Compare laps: the two-sided stage, and its mode. The button sits just
        // under the stage, which the page has scrolled past by now — the mini
        // bar's thumbnail is the way back up.
        backToTheStage(app)
        let compare = app.buttons["compareLaps"]
        XCTAssertTrue(scrollTo(compare, in: app))
        compare.tap()
        let mode = app.segmentedControls["stageMode"]
        XCTAssertTrue(mode.waitForExistence(timeout: 20), "a compare offers Same place / Same time")
        XCTAssertTrue(mode.buttons["Same place"].isSelected, "Same place is the remembered first mode here")
        mode.buttons["Same time"].tap()
        XCTAssertTrue(mode.buttons["Same time"].isSelected)
        attach(app, named: "lap-stage-compare-time")
        // Put it back, so the remembered mode doesn't leak into the next run.
        mode.buttons["Same place"].tap()
    }

    // MARK: - Helpers

    private func value(_ element: XCUIElement) -> String {
        element.value as? String ?? ""
    }

    private func wait(_ element: XCUIElement, _ seconds: TimeInterval, until matches: (String) -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if matches(value(element)) { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return false
    }

    private func seedEvent() throws -> Int {
        let event = try api(
            "POST", "/api/events",
            body: ["track_name": Self.track, "start_date": "2024-04-21", "days": 1, "club": "UITest", "car": "Test car"]
        )
        let id = try XCTUnwrap(event["id"] as? Int)
        seededEventId = id
        return id
    }

    private func waitForClip(eventId: Int, timeout: TimeInterval = 90) throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let detail = try api("GET", "/api/events/\(eventId)")
            let laps = (detail["sessions"] as? [[String: Any]] ?? []).flatMap { $0["laps"] as? [[String: Any]] ?? [] }
            if laps.contains(where: { $0["clip"] is [String: Any] }) { return }
            Thread.sleep(forTimeInterval: 2)
        }
        XCTFail("the clip never finished uploading")
    }
}
