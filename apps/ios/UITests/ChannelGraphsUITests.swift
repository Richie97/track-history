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
        // A safety net for a test that failed before it got to the in-app delete,
        // so it must not assert: on the happy path the event is already gone and
        // this 404s. `api` records a failure on any non-2xx, which is right for a
        // seed and wrong for a best-effort cleanup.
        if let id = seededEventId {
            deleteEventBestEffort(id)
            seededEventId = nil
        }
    }

    func testChannelGraphsOverlayLapsForAnImportedSession() throws {
        try XCTSkipUnless(devServerIsRunning(), "needs `npm run dev` on :8787")
        seededEventId = try seedImportedSession(track: Self.track)

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

        // The best lap's trace comes first on the page, carrying the limit marks
        // and the legend that names them (#188).
        let map = app.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@", "marked where")
        ).firstMatch
        XCTAssertTrue(
            scrollTo(map, in: app),
            "the track map should say which systems fired on the best lap"
        )
        attach(app, named: "trace-limit-marks")

        let entry = app.buttons["channelGraphs"]
        XCTAssertTrue(scrollTo(entry, in: app), "an imported session offers the lap overlay")
        // The row says which channels the session actually stored, in the order
        // `CHANNEL_DEFS` fixes.
        XCTAssertTrue(
            app.staticTexts["Speed · Throttle · Brake · Steering · RPM · Lateral G · Yaw rate vs distance"].exists,
            "the row should name the channels it has"
        )
        entry.tap()

        // A sheet of its own, not an expanding panel — see `LapChannelChart`.
        let speed = app.descendants(matching: .any)["Speed by driven distance, per lap"]
        XCTAssertTrue(speed.waitForExistence(timeout: 20), "the sheet draws the speed overlay")
        // One question per tab (#193): lateral G answers "how much grip", so it is
        // a tab away rather than stacked under the speed trace.
        XCTAssertFalse(
            app.descendants(matching: .any)["Lateral G by driven distance, per lap"].exists,
            "the Grip channel should not be stacked under Time"
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

        // One question per tab (#193): the driver inputs, the gear ribbon and the
        // shift points are one tap away, not stacked under the speed trace.
        let inputs = app.buttons["Inputs"]
        XCTAssertTrue(inputs.exists, "a session with pedal traces offers the Inputs tab")
        inputs.tap()
        let ribbon = app.descendants(matching: .any)["gearRibbon"]
        XCTAssertTrue(
            ribbon.waitForExistence(timeout: 10),
            "the gear ribbon draws under the RPM trace for a session that stored gear (#187)"
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["shiftTable"].exists,
            "and the shift points are tabulated above the traces"
        )
        attach(app, named: "channel-graphs-gears")

        app.buttons["Grip"].tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["Lateral G by driven distance, per lap"].waitForExistence(timeout: 10),
            "and one chart per stored channel, on the tab its question belongs to"
        )
        // The friction circle (#186) sits above that trace: a square scatter of
        // latG against longG, which is a drawn thing and so worth a screenshot.
        XCTAssertTrue(
            app.descendants(matching: .any)["frictionCircle"].waitForExistence(timeout: 10),
            "a session storing both G channels draws the friction circle"
        )
        attach(app, named: "channel-graphs-friction-circle")
        // And under it the balance scatter (#189) with its per-corner table —
        // also drawn rather than laid out, so it gets its own screenshot.
        let balance = app.descendants(matching: .any)["balanceScatter"]
        XCTAssertTrue(
            scrollTo(balance, in: app),
            "a session storing yaw, steering and speed draws the balance scatter"
        )
        attach(app, named: "channel-graphs-balance")

        // The Car tab (#190): the per-lap scalars as cards with sparklines, the
        // tab that was reserved and empty until this session carried scalars.
        app.buttons["Car"].tap()
        let health = app.descendants(matching: .any)["healthStrip"]
        XCTAssertTrue(
            health.waitForExistence(timeout: 10),
            "a session storing per-lap scalars fills the Car tab"
        )
        attach(app, named: "channel-graphs-health")

        app.buttons["Done"].tap()
        deleteEventFromMenu(app)
    }

    // MARK: - Seeding

    // MARK: - Helpers

    private func deleteEventFromMenu(_ app: XCUIApplication) {
        guard app.buttons["eventMenu"].exists else { return }
        app.buttons["eventMenu"].tap()
        app.buttons["Delete event"].tap()
        app.buttons["Delete event"].tap()
    }

}
