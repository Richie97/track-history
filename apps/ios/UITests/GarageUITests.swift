import XCTest

/// The garage, walked end to end against the local dev logbook: add a car, fit a
/// consumable to it, measure the consumable, and clear up.
///
/// Worth a UI test rather than only unit coverage for two reasons. The garage is
/// the **one part of the app that needs a live server** — its writes are
/// deliberately absent from the offline queue — so a broken request here fails at
/// the point of use and nowhere earlier. And the wear bar is a drawn shape whose
/// wrongness no assertion would catch, which is why this attaches a screenshot.
///
/// Creates everything it asserts on and deletes it again: the dev logbook is
/// shared between tests, and a leftover car with worn-out pads would put a
/// maintenance reminder on every later run's dashboard.
///
/// Needs `npm run dev`; skips otherwise, so CI stays green. See `DevServerSignIn`.
final class GarageUITests: XCTestCase {
    /// Distinctive enough not to collide with seeded vehicles, and a name no
    /// `COLLATE NOCASE` match would confuse with one.
    private static let vehicleName = "UITest Garage Car"

    override func setUp() {
        continueAfterFailure = false
    }

    /// Remove the test car however the run ended.
    ///
    /// The in-app delete at the end of the happy path is part of what this suite
    /// asserts, so it stays — but a run that fails before reaching it used to leave
    /// its car and parts behind, and the next run added another part to the *same*
    /// car. A few failures in and the page carries a dozen cards, which is enough
    /// to make the scrolling helpers fail for reasons that have nothing to do with
    /// what is being tested. A suite whose failures make the next failure worse is
    /// a suite nobody can debug.
    ///
    /// Best-effort and never asserting: on the happy path the car is already gone
    /// and there is nothing here to do.
    override func tearDown() {
        guard devServerIsRunning() else { return }
        for id in testVehicleIds() {
            deleteVehicleBestEffort(id)
        }
    }

    /// The ids of every car this suite has left behind, by name.
    private func testVehicleIds() -> [Int] {
        try? signInOverHTTP()
        var ids: [Int] = []
        let done = expectation(description: "list vehicles")
        var request = URLRequest(url: URL(string: "\(Self.devServerURL)/api/vehicles")!)
        request.timeoutInterval = 15
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data,
               let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                ids = rows
                    .filter { ($0["name"] as? String) == Self.vehicleName }
                    .compactMap { $0["id"] as? Int }
            }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 20)
        return ids
    }

    private func deleteVehicleBestEffort(_ id: Int) {
        var request = URLRequest(url: URL(string: "\(Self.devServerURL)/api/vehicles/\(id)")!)
        request.httpMethod = "DELETE"
        request.timeoutInterval = 15
        let done = expectation(description: "delete vehicle \(id)")
        URLSession.shared.dataTask(with: request) { _, _, _ in done.fulfill() }.resume()
        wait(for: [done], timeout: 20)
    }

    func testGarageTracksAConsumableFromInstallToMeasurement() throws {
        let app = try launchSignedIn(tier: .pro)

        // --- add the car, from Settings
        app.buttons["Account"].tap()
        let nameField = app.textFields["Corvette Z06"]
        XCTAssertTrue(nameField.waitForExistence(timeout: 20), "Settings should offer the add-vehicle field")
        nameField.tap()
        nameField.typeText(Self.vehicleName)
        app.buttons["addVehicle"].tap()

        let row = app.buttons["vehicleRow"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the new vehicle should appear in the list")
        XCTAssertTrue(
            app.staticTexts[Self.vehicleName].waitForExistence(timeout: 10),
            "under the name it was given"
        )

        // --- open its garage page
        app.staticTexts[Self.vehicleName].firstMatch.tap()
        XCTAssertTrue(
            app.staticTexts["Consumables in service"].waitForExistence(timeout: 20),
            "the vehicle row should open the garage page"
        )
        XCTAssertTrue(app.staticTexts["Track hours"].exists, "with the accrued-hours tiles")

        // --- fit a part
        app.buttons["addPart"].tap()
        let partName = app.textFields["Hawk DTC-60, RE-71RS 255/40…"]
        XCTAssertTrue(partName.waitForExistence(timeout: 15), "the add-part sheet should open")
        partName.tap()
        partName.typeText("Hawk DTC-60")

        // An expected life makes the wear projection possible with no measurements
        // at all, which is the case the bar and the status line are built around.
        let expected = app.textFields["auto from history"]
        expected.tap()
        expected.typeText("6")

        app.buttons["savePart"].tap()

        // Matched among any descendants: a card is a stack, and SwiftUI doesn't
        // promise which element type it publishes one as.
        let card = app.descendants(matching: .any)["partCard"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20), "the part should land on the page")
        XCTAssertTrue(
            app.staticTexts["Front pads"].firstMatch.exists,
            "labelled with its kind, not its raw enum value"
        )
        // A brand-new part on a car with no events: no hours accrued, all of the
        // expected life left. The phrasing is pinned against the JS in
        // `contracts/logic/garage-status.json`; this asserts it reaches the screen.
        XCTAssertTrue(
            app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS %@", "3 track days")
            ).firstMatch.exists,
            "6 expected hours with none accrued should read as ≈3 track days left"
        )

        // --- measure it
        let measure = app.buttons["measurePart"].firstMatch
        // The part card sits below the fold once the page has its stat tiles and
        // the explanatory copy; a SwiftUI `ScrollView` doesn't auto-scroll to a tap
        // target the way a table does.
        scrollUntilHittable(app, measure)
        measure.tap()
        let value = app.textFields["Value"]
        XCTAssertTrue(value.waitForExistence(timeout: 15), "the measurement row should open")
        value.tap()
        value.typeText("8")
        app.buttons["Log measurement"].tap()

        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "8 mm")).firstMatch
                .waitForExistence(timeout: 20),
            "the measurement should be logged in the kind's default unit"
        )

        attachScreenshot(app, named: "garage-vehicle")

        // --- and the dashboard knows about the car
        app.navigationBars.buttons.element(boundBy: 0).tap()  // back to Settings
        app.navigationBars.buttons.element(boundBy: 0).tap()  // back to the dashboard
        XCTAssertTrue(
            app.buttons["garageCard"].firstMatch.waitForExistence(timeout: 20),
            "the dashboard should carry a card per vehicle"
        )

        // --- clear up
        app.buttons["Account"].tap()
        XCTAssertTrue(
            app.staticTexts[Self.vehicleName].waitForExistence(timeout: 20),
            "back in Settings to delete the car"
        )
        deleteVehicle(app)
        XCTAssertFalse(
            app.staticTexts[Self.vehicleName].waitForExistence(timeout: 5),
            "the vehicle, its part and its measurement should all be gone"
        )
    }

    /// Delete the test car, by finding the Delete that belongs to *its* row.
    ///
    /// Two things this has to get right, and the version before it got neither —
    /// which nothing noticed, because the suite could not be run at all:
    ///
    /// - **Match by label, not identifier.** This button sets no identifier of its
    ///   own and SwiftUI synthesizes none, so `matching(identifier: "Delete")`
    ///   matched *nothing* and the walk fell straight through to its failure.
    /// - **Scroll first.** Settings is longer than a screen and the vehicles sit
    ///   under the checklist-template editor, so every Delete starts off-screen and
    ///   `isHittable` is false for all of them. A `where isHittable` filter over
    ///   elements nobody has scrolled to skips the whole list.
    ///
    /// Which Delete belongs to this car is decided by **geometry**: the buttons sit
    /// under their own row, so the right one is the first Delete at or below the
    /// row's top edge. The confirmation still quotes the name, and that is asserted
    /// rather than searched — a delete that reached the wrong dialog should fail
    /// loudly, not quietly cancel and try the next one.
    private func deleteVehicle(_ app: XCUIApplication) {
        let row = app.buttons
            .matching(NSPredicate(format: "label CONTAINS %@", Self.vehicleName))
            .firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "the test car should still be listed")
        scrollUntilHittable(app, row)

        let deletes = app.buttons.matching(NSPredicate(format: "label == %@", "Delete"))
        let mine = deletes.allElementsBoundByIndex
            .filter { $0.exists && $0.frame.minY >= row.frame.minY }
            .min { $0.frame.minY < $1.frame.minY }
        guard let mine, mine.isHittable else {
            XCTFail("no Delete button under the test vehicle's row")
            return
        }
        mine.tap()

        XCTAssertTrue(
            app.buttons["Delete vehicle"].waitForExistence(timeout: 10),
            "deleting a car should ask first — it takes its parts with it"
        )
        XCTAssertTrue(
            app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS %@", Self.vehicleName)
            ).firstMatch.exists,
            "and the confirmation should name the car being deleted"
        )
        app.buttons["Delete vehicle"].tap()
    }

    /// Swipe until the element can actually be tapped, or give up after a few
    /// screens. `waitForExistence` isn't enough on a `ScrollView`: an element below
    /// the fold exists in the hierarchy but isn't hittable — and SwiftUI publishes
    /// only what it has laid out, so far enough down it doesn't exist yet either.
    /// Swipes the scroll view rather than the app, so the gesture lands on
    /// something scrollable.
    private func scrollUntilHittable(_ app: XCUIApplication, _ element: XCUIElement, swipes: Int = 8) {
        let scroller = app.scrollViews.firstMatch
        for _ in 0..<swipes {
            if element.exists, element.isHittable { return }
            if scroller.exists { scroller.swipeUp() } else { app.swipeUp() }
        }
        XCTAssertTrue(
            element.exists && element.isHittable,
            "never reached \(element); buttons on screen: "
                + app.buttons.allElementsBoundByIndex.map { $0.identifier.isEmpty ? $0.label : $0.identifier }
                    .joined(separator: ", ")
        )
    }

    /// Kept on success: the wear bar is a drawn shape, so a bad render fails no
    /// assertion and a screenshot is the only artifact that would show it.
    private func attachScreenshot(_ app: XCUIApplication, named name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
