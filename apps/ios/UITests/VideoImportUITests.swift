import XCTest

/// Video telemetry import (NS-30) end to end: a clip goes in, a session with laps,
/// a racing line and channel data comes out of the dev logbook.
///
/// The clip is one of the committed contract fixtures, handed to the app by
/// `-importFixture` — the system Files and Photos pickers are other processes and
/// automating them would make this suite flaky about the wrong thing. Everything
/// after the pick is the production path: the `FileHandle` byte source, the PDR
/// decoder, the review screen, and the save.
///
/// Needs `npm run dev`; skips otherwise, so CI stays green. The event it seeds is
/// deleted again in `tearDown` — the dev logbook is shared between tests, and a
/// leftover event rewrites the dashboard's totals.
final class VideoImportUITests: XCTestCase {
    private static let track = "Video Import Test Circuit (UITest)"

    private var seededEventId: Int?

    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        if let id = seededEventId {
            _ = try? api("DELETE", "/api/events/\(id)")
            seededEventId = nil
        }
    }

    /// A PDR clip with beacons: exact laps, and the line picker never appears.
    func testImportsABeaconTimedClipAndSavesItAsASession() throws {
        try XCTSkipUnless(devServerIsRunning(), "needs `npm run dev` on :8787")
        let eventId = try seedEvent()

        let app = try launchSignedIn(importing: "pdr-delta.mp4", into: eventId)

        XCTAssertTrue(
            app.staticTexts["pdr-delta.mp4"].waitForExistence(timeout: 30),
            "the review should name the clip it parsed"
        )
        // Beacon-timed laps arrive exact, so there is nothing to pick — that is the
        // difference between this and a GoPro clip, and it should be visible.
        XCTAssertFalse(
            app.buttons["linePickerMap"].exists,
            "a beacon-timed PDR clip should skip the start/finish line picker"
        )
        XCTAssertTrue(app.staticTexts["Lap 1"].exists, "the fixture has two beacon-timed laps")
        XCTAssertTrue(app.staticTexts["Lap 2"].exists)
        // 47.124 s laps, exact rather than derived, so no `~`.
        XCTAssertTrue(
            app.staticTexts["47.124"].exists || app.staticTexts["0:47.124"].exists,
            "beacon-timed laps render without the estimated marker"
        )
        attach(app, named: "import-review")

        let save = app.buttons["Save session"]
        XCTAssertTrue(save.waitForExistence(timeout: 10))
        save.tap()

        // The session is only real once the server has it, so that is what's checked.
        let detail = try waitForSession(eventId: eventId)
        let session = try XCTUnwrap((detail["sessions"] as? [[String: Any]])?.first)
        let laps = try XCTUnwrap(session["laps"] as? [[String: Any]])
        XCTAssertEqual(laps.count, 2, "both beacon-timed laps should be saved")
        XCTAssertEqual(laps.map { $0["time_ms"] as? Int }, [47124, 47124])

        // The two things a phone import used to be unable to produce: the racing
        // line, and the per-lap channels the NS-23 lap overlay draws.
        XCTAssertNotNil(session["trace"], "the best lap's polyline should be stored")
        let channels = try XCTUnwrap(session["channels"] as? [String: Any], "channels should be stored")
        let channelLaps = try XCTUnwrap(channels["laps"] as? [[String: Any]])
        XCTAssertEqual(channelLaps.count, 2)
        XCTAssertFalse((channelLaps[0]["speed"] as? [Double] ?? []).isEmpty, "speed is always stored")
        XCTAssertFalse((channelLaps[0]["rpm"] as? [Double] ?? []).isEmpty, "PDR carries RPM too")

        // Notes record where the session came from, as the web importer's do.
        let notes = session["notes"] as? String ?? ""
        XCTAssertTrue(notes.contains("Imported from pdr-delta.mp4"), "got: \(notes)")

        // And the channels are drawable: the lap overlay (NS-23) used to be
        // reachable only for sessions the *web* importer made.
        openTheLapOverlay(app)
    }

    /// Walk from the dashboard to the imported session and open its channel graphs.
    private func openTheLapOverlay(_ app: XCUIApplication) {
        let card = app.buttons.matching(
            NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "trackCard", "Video Import Test")
        ).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20), "the imported session should give its track a card")
        scrollTo(card, in: app)
        card.tap()

        let event = app.buttons["trackEventCard"].firstMatch
        XCTAssertTrue(event.waitForExistence(timeout: 15), "the track page should list the seeded event")
        event.tap()

        let entry = app.buttons["channelGraphs"]
        XCTAssertTrue(scrollTo(entry, in: app), "an imported session offers the lap overlay")

        // `scrollTo` stops the moment the row is hittable, which can leave it tucked
        // just under the navigation bar — where the tap lands on the bar instead and
        // nothing happens, silently. Nudge it into the middle of the screen, and
        // retry: the `List` is still laying out around the tap.
        let speed = app.descendants(matching: .any)["Speed by driven distance, per lap"]
        var opened = false
        for _ in 0..<4 {
            if entry.exists, entry.frame.midY < 200 { app.collectionViews.firstMatch.swipeDown() }
            if entry.exists, entry.isHittable {
                entry.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            }
            if speed.waitForExistence(timeout: 8) {
                opened = true
                break
            }
        }
        XCTAssertTrue(opened, "the overlay draws from channels this phone wrote")
        attach(app, named: "import-lap-overlay")
    }

    /// A GoPro clip has GPS and no lap markers, so it goes through the picker — the
    /// same one a phone recording uses.
    func testAGoProClipAsksForTheStartFinishLine() throws {
        try XCTSkipUnless(devServerIsRunning(), "needs `npm run dev` on :8787")
        let eventId = try seedEvent()

        let app = try launchSignedIn(importing: "gopro.mp4", into: eventId)

        let map = app.buttons["linePickerMap"]
        XCTAssertTrue(map.waitForExistence(timeout: 30), "a GoPro clip needs a picked line")
        XCTAssertFalse(app.staticTexts["Lap 1"].exists, "…and has no laps until one is picked")

        map.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
        XCTAssertTrue(
            app.staticTexts["Lap 1"].waitForExistence(timeout: 10),
            "picking a line on a three-lap trace should time laps"
        )
        attach(app, named: "import-gopro-picked")
    }

    // MARK: - Helpers

    private func launchSignedIn(importing fixture: String, into eventId: Int) throws -> XCUIApplication {
        // Import itself is free on every client, but this test walks through to the
        // saved session's channel overlay, which is not — so the account is Pro for
        // the same reason the shared `launchSignedIn` makes tier explicit.
        try setDevTier(.pro)
        // `launchSignedIn` builds its own arguments, so the fixture goes on through
        // the environment the same way: UserDefaults reads launch arguments.
        let app = XCUIApplication()
        app.launchArguments = [
            "-server.url", Self.devServerURL, "-resetAuth", "-resetRecording",
            "-importFixture", fixture,
            "-importFixtureEvent", String(eventId)
        ]
        app.launch()

        let google = app.buttons["Continue with Google"]
        XCTAssertTrue(google.waitForExistence(timeout: 15), "the sign-in screen should offer Google")
        google.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let consent = springboard.buttons["Continue"]
        if consent.waitForExistence(timeout: 15) { consent.tap() }
        return app
    }

    private func seedEvent() throws -> Int {
        let event = try api(
            "POST", "/api/events",
            body: [
                "track_name": Self.track,
                // Fixed and in the past, so this never lands in the dashboard's hero
                // slot and never changes which event another test finds there.
                "start_date": "2024-04-20",
                "days": 1,
                "club": "UITest",
                "car": "Test car"
            ]
        )
        let id = try XCTUnwrap(event["id"] as? Int, "the dev server should return the created event")
        seededEventId = id
        return id
    }

    /// Poll the event until its session shows up. The save is a network round trip
    /// the UI doesn't announce the end of, and an offline queue may hold it briefly.
    private func waitForSession(eventId: Int, timeout: TimeInterval = 30) throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        var latest: [String: Any] = [:]
        while Date() < deadline {
            latest = try api("GET", "/api/events/\(eventId)")
            if let sessions = latest["sessions"] as? [[String: Any]], !sessions.isEmpty { return latest }
            Thread.sleep(forTimeInterval: 1)
        }
        XCTFail("the saved session never reached the server")
        return latest
    }
}
