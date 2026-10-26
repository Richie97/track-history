import XCTest

/// Best-lap video clips (NS-45) end to end: import a clip with *Save best-lap
/// video* on, let the clip cut and upload behind the save, and play it on the
/// best lap's page.
///
/// The committed fixtures carry telemetry and no picture, so `-syntheticClipVideo`
/// has the cutter work on a small generated H.264 file of the same length —
/// everything else is the production path: the review row, `ClipCutter`, the
/// Kit's queue driven by `ClipUploader` (create → part over the background
/// session → complete) against the dev server's local R2, the signed URL and the
/// player. Needs `npm run dev` with a `CLIP_URL_SECRET` in `.dev.vars`; skips
/// without the server.
final class LapClipUITests: XCTestCase {
    private static let track = "Lap Clip Test Circuit (UITest)"

    private var seededEventId: Int?

    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        if let id = seededEventId {
            // Deleting the event tombstones its clip; the cron drains the object.
            deleteEventBestEffort(id)
            seededEventId = nil
        }
    }

    func testASavedImportUploadsItsBestLapAndTheLapPagePlaysIt() throws {
        try XCTSkipUnless(devServerIsRunning(), "needs `npm run dev` on :8787")
        try setDevTier(.pro)
        let eventId = try seedEvent()

        var app = XCUIApplication()
        app.launchArguments = [
            "-server.url", Self.devServerURL, "-resetAuth", "-resetRecording", "-authToken", try devSessionToken(),
            "-importFixture", "pdr-delta.mp4", "-importFixtureEvent", String(eventId),
            "-syntheticClipVideo", "YES",
        ]
        app.launch()

        XCTAssertTrue(app.staticTexts["pdr-delta.mp4"].waitForExistence(timeout: 30), "the review should open on the clip")
        let row = app.switches["reviewSaveVideo"]
        XCTAssertTrue(scrollTo(row, in: app), "a Pro video import offers Save best-lap video")
        XCTAssertEqual(row.value as? String, "1", "the switch starts on, every review")
        attach(app, named: "clip-review-row")

        let save = app.buttons["Save session"]
        XCTAssertTrue(scrollTo(save, in: app))
        save.tap()

        // The session saves first; the clip follows it, cut and uploaded behind
        // the save, so the server is what says it arrived.
        let clip = try waitForClip(eventId: eventId)
        XCTAssertEqual(clip["lap_offset_ms"] as? Int, 3000, "the lap starts three seconds in (PRE_ROLL_S)")

        // Back in on the event, and onto the lap with the video.
        app.terminate()
        app = XCUIApplication()
        app.launchArguments = [
            "-server.url", Self.devServerURL, "-resetAuth", "-resetRecording", "-authToken", try devSessionToken(),
            "-openLink", "trackevolution://event/\(eventId)",
        ]
        app.launch()

        XCTAssertTrue(
            app.navigationBars[Self.track].waitForExistence(timeout: 20), "the link should open the event"
        )
        // The session's lap rows sit below the fold, and a `List` builds rows lazily.
        let lapRow = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "has video")).firstMatch
        XCTAssertTrue(scrollTo(lapRow, in: app), "the event page marks the lap that has a video")
        lapRow.tap()

        // An imported lap carries channels, so since NS-51 its video plays on
        // the lap stage rather than in the old player card.
        let player = app.descendants(matching: .any)["stageVideoA"]
        XCTAssertTrue(player.waitForExistence(timeout: 20), "the lap page shows the video on its stage")
        // "ready" once the signed URL has loaded and the player has sought to the
        // lap's first frame.
        let deadline = Date().addingTimeInterval(30)
        while player.value as? String != "ready", Date() < deadline {
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertEqual(player.value as? String, "ready", "the clip should load and seek to the lap")
        XCTAssertTrue(app.buttons["lapVideoMenu"].exists, "the owner gets Download and Delete")
        attach(app, named: "clip-lap-page")
    }

    // MARK: - Helpers

    private func seedEvent() throws -> Int {
        let event = try api(
            "POST", "/api/events",
            body: ["track_name": Self.track, "start_date": "2024-04-21", "days": 1, "club": "UITest", "car": "Test car"]
        )
        let id = try XCTUnwrap(event["id"] as? Int)
        seededEventId = id
        return id
    }

    /// Poll the event until one of its laps carries a ready clip.
    private func waitForClip(eventId: Int, timeout: TimeInterval = 90) throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let detail = try api("GET", "/api/events/\(eventId)")
            let laps = (detail["sessions"] as? [[String: Any]] ?? []).flatMap { $0["laps"] as? [[String: Any]] ?? [] }
            if let clip = laps.compactMap({ $0["clip"] as? [String: Any] }).first { return clip }
            Thread.sleep(forTimeInterval: 2)
        }
        XCTFail("the clip never finished uploading")
        return [:]
    }
}
