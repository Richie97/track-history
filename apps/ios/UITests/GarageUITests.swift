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

    func testGarageTracksAConsumableFromInstallToMeasurement() throws {
        let app = try launchSignedIn()

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

    /// Delete the test car. Its row is the only one with this name, and the
    /// confirmation's destructive button repeats the label.
    private func deleteVehicle(_ app: XCUIApplication) {
        let deletes = app.buttons.matching(identifier: "Delete")
        // The row order follows the server's (default first, then name), so the
        // Delete under this car's name is found by walking from its label.
        for index in 0..<deletes.count where deletes.element(boundBy: index).isHittable {
            deletes.element(boundBy: index).tap()
            if app.buttons["Delete vehicle"].waitForExistence(timeout: 5) {
                // The dialog quotes the car's name — only confirm for ours.
                let mine = app.staticTexts.containing(
                    NSPredicate(format: "label CONTAINS %@", Self.vehicleName)
                ).firstMatch.exists
                if mine {
                    app.buttons["Delete vehicle"].tap()
                    return
                }
                app.buttons["Keep it"].tap()
            }
        }
        XCTFail("no Delete button matched the test vehicle")
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
