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

    private func deleteEventBestEffort(_ id: Int) {
        var request = URLRequest(url: URL(string: "\(Self.devServerURL)/api/events/\(id)")!)
        request.httpMethod = "DELETE"
        request.timeoutInterval = 10
        let done = expectation(description: "cleanup \(id)")
        URLSession.shared.dataTask(with: request) { _, _, _ in done.fulfill() }.resume()
        wait(for: [done], timeout: 15)
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

    /// An event with one session carrying three laps of channel data, shaped like a
    /// PDR telemetry import: 120 points per lap on a 20 m grid, the seven charted
    /// channels plus `gear`, `wheelSlip` and the ABS/TC/VSC `flags` bitfield, and a
    /// GPS trace for the best lap so the map has limit marks to place (#187, #188,
    /// #189).
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
                            },
                            // The pedals trade off against each other, so the
                            // Inputs tab has traces for the limit bands to shade.
                            "throttle": (0..<120).map { k in
                                max(0, sin(Double(k) / 9 + Double(index) * 0.15)) * 100
                            },
                            "brake": (0..<120).map { k in
                                max(0, -sin(Double(k) / 9 + Double(index) * 0.15)) * 100
                            },
                            // Longitudinal G a quarter turn out of phase with the
                            // cornering, so the Grip tab's friction circle has both
                            // lobes to draw (#186).
                            "longG": (0..<120).map { k in
                                sin(Double(k) / 9 + Double(index) * 0.15) * 1.3
                            },
                            // Steering and yaw: the balance scatter needs both, and
                            // the rotation falls short through the back half of the
                            // lap so its table has a corner that pushes (#189). The
                            // side derivation the friction circle does off the
                            // steering sign is covered by `GripTests` and lap B of
                            // `contracts/logic/grip.json`, not from here.
                            "steering": (0..<120).map { k in
                                cos(Double(k) / 9 + Double(index) * 0.15) * 120
                            },
                            "yaw": (0..<120).map { k -> Double in
                                let speed = 90 + 60 * sin(Double(k) / 9 + Double(index) * 0.15)
                                let steer = cos(Double(k) / 9 + Double(index) * 0.15) * 120
                                return steer * (speed / 3.6) * 0.012 * (k > 60 ? 0.7 : 1)
                            },
                            // Gear steps with the speed wave, dropping to 0 through
                            // one shift — the clutch-in gap the ribbon draws as a gap.
                            "gear": (0..<120).map { k -> Double in
                                let wave = sin(Double(k) / 9 + Double(index) * 0.15)
                                return k % 37 == 18 ? 0 : Double(2 + Int((wave + 1) / 2 * 3))
                            },
                            "wheelSlip": (0..<120).map { k in
                                sin(Double(k) / 9 + Double(index) * 0.15) * 5
                            },
                            "flags": (0..<120).map { k -> Double in
                                let wave = sin(Double(k) / 9 + Double(index) * 0.15)
                                return wave < -0.85 ? 1 : wave > 0.9 ? 2 : 0
                            },
                            // The per-lap scalars the Car tab reads (#190). Oil
                            // climbs past its line by the last lap and fuel drains,
                            // so the strip has a shaded card and a fuel outlook
                            // rather than three cards of flat numbers.
                            "oilC": 118 + Double(index) * 8,
                            "oilKpa": 320 - Double(index) * 20,
                            "coolantC": 99 + Double(index) * 5,
                            "transC": 94 + Double(index) * 6,
                            "fuelPct": 74 - Double(index) * 12,
                            "battV": 13.6 - Double(index) * 0.4,
                            "tyreKpaLF": 214 + Double(index) * 9,
                            "tyreKpaRF": 210 + Double(index) * 8,
                            "tyreKpaLR": 205 + Double(index) * 7,
                            "tyreKpaRR": 204 + Double(index) * 7,
                            "tyreCLF": 82 + Double(index) * 9,
                            "tyreCRF": 74 + Double(index) * 7,
                            "tyreCLR": 68 + Double(index) * 6,
                            "tyreCRR": 66 + Double(index) * 6
                        ] as [String: Any]
                    }
                ],
                // A closed circuit in projected metres — `renderTrackMap`'s floor is
                // ten points, and the marks are placed along its cumulative length.
                "trace": (0..<80).map { k -> [Double] in
                    let a = Double(k) / 80 * 2 * Double.pi
                    return [cos(a) * 400, sin(a) * 250, 25 + 15 * sin(a * 2)]
                }
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
