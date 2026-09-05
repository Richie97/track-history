import XCTest

/// The lap overlay, end to end against the local dev logbook.
///
/// Channel data comes from the *web* telemetry importer and nothing else — the native
/// app reads `sessions.channels` and can't produce it — so unlike the other screen
/// tests this one can't create what it asserts on through the UI. It seeds a session
/// over the dev API instead (the `DEV_MODE` bypass is the same door
/// `DevServerSignIn` uses), walks to it, and deletes the event again: the dev logbook
/// is shared between tests, and a leftover event rewrites the dashboard's totals.
///
/// The screenshot is the point as much as the assertions are. Charts fail *visually*
/// — a collapsed axis, a lap drawn flat, the dim envelope painted over the
/// highlighted lap — and none of that trips an assertion.
///
/// Needs `npm run dev`; skips otherwise, so CI stays green.
final class ChannelGraphsUITests: XCTestCase {
    /// Distinctive enough that no seed or other test owns it — this test navigates by
    /// track name, since every card carries the same accessibility identifier.
    private static let track = "Channel Graph Test Circuit (UITest)"

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

    func testChannelGraphsOverlayLapsForAnImportedSession() throws {
        try XCTSkipUnless(devServerIsRunning(), "needs `npm run dev` on :8787")
        try seedImportedSession()

        let app = try launchSignedIn(tier: .pro)

        // By name, not by identifier: every track card shares one identifier, and the
        // point of this test is to reach *our* track.
        let card = app.buttons.matching(
            NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "trackCard", "Channel Graph Test")
        ).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20), "the seeded track should have a dashboard card")
        scrollTo(card, in: app)
        card.tap()

        let event = app.buttons["trackEventCard"].firstMatch
        XCTAssertTrue(event.waitForExistence(timeout: 15), "the track page should list the seeded event")
        event.tap()

        let entry = app.buttons["channelGraphs"]
        XCTAssertTrue(entry.waitForExistence(timeout: 20), "an imported session offers the lap overlay")
        scrollTo(entry, in: app)
        // The row says which channels the session actually stored.
        XCTAssertTrue(
            app.staticTexts["Speed · RPM · Lateral G vs distance"].exists,
            "the row should name the channels it has"
        )
        entry.tap()

        // A sheet of its own, not an expanding panel — see `LapChannelChart`.
        let speed = app.descendants(matching: .any)["Speed by driven distance, per lap"]
        XCTAssertTrue(speed.waitForExistence(timeout: 20), "the sheet draws the speed overlay")
        XCTAssertTrue(
            app.descendants(matching: .any)["Lateral G by driven distance, per lap"].exists,
            "and one chart per stored channel"
        )
        // The chips are the legend — a lap is never identified by color alone. Lap 2
        // is the fastest of the three seeded laps, so it starts highlighted.
        let chip = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Lap 1,'")).firstMatch
        XCTAssertTrue(chip.exists, "each lap with channel data gets a chip")
        attach(app, named: "channel-graphs")

        // Adding a second lap to the comparison is the whole feature: it takes the
        // next slot color rather than replacing the lap already up.
        chip.tap()
        attach(app, named: "channel-graphs-two-laps")

        // Tapping a chart parks the read-out — "1.2 km · L2 84 · L1 81".
        speed.tap()
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "· L")).firstMatch
                .waitForExistence(timeout: 10),
            "tapping a chart should read values off it for every highlighted lap"
        )
        attach(app, named: "channel-graphs-readout")

        app.buttons["Done"].tap()
        deleteEventFromMenu(app)
    }

    // MARK: - Seeding

    /// An event with one session carrying three laps of channel data, shaped like a
    /// telemetry import: 120 points per lap on a 20 m grid, all three channels.
    private func seedImportedSession() throws {
        let event = try api(
            "POST", "/api/events",
            body: [
                "track_name": Self.track,
                // Fixed and in the past, so this event never lands in the dashboard's
                // hero slot and never changes which event another test finds there.
                "start_date": "2024-03-15",
                "days": 1,
                "club": "UITest",
                "car": "Test car"
            ]
        )
        let id = try XCTUnwrap(event["id"] as? Int, "the dev server should return the created event")
        seededEventId = id

        let times = [118_400, 116_900, 117_600]
        _ = try api(
            "POST", "/api/events/\(id)/sessions",
            body: [
                "label": "Imported session",
                "laps": times,
                "channels": [
                    "v": 1,
                    "dStepM": 20,
                    "laps": times.enumerated().map { index, ms in
                        [
                            "n": index + 1,
                            "timeMs": ms,
                            // A lap of a circuit: speed rising and falling through
                            // corners, RPM tracking it, lateral G peaking between.
                            "speed": (0..<120).map { k in
                                90 + 60 * sin(Double(k) / 9 + Double(index) * 0.15)
                            },
                            "rpm": (0..<120).map { k in
                                3000 + 3500 * (1 + sin(Double(k) / 9 + Double(index) * 0.15)) / 2
                            },
                            "latG": (0..<120).map { k in
                                abs(cos(Double(k) / 9 + Double(index) * 0.15)) * 1.2
                            }
                        ] as [String: Any]
                    }
                ]
            ]
        )
    }

    // MARK: - Helpers

    private func deleteEventFromMenu(_ app: XCUIApplication) {
        guard app.buttons["eventMenu"].exists else { return }
        app.buttons["eventMenu"].tap()
        app.buttons["Delete event"].tap()
        app.buttons["Delete event"].tap()
    }

}
