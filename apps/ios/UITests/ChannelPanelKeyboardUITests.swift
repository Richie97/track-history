import XCTest

/// The channel panel's keyboard shortcuts (spec: NS-34 ticket 5).
///
/// Unlike every other UI suite here this one needs **no dev server and no
/// sign-in**: `-channelGraphs` opens the panel on synthetic data before the shell
/// is built, which is exactly the surface the shortcuts live on. That makes it the
/// one screen test that can run anywhere, and it is why the shortcuts are asserted
/// here rather than left to a manual pass — a `.keyboardShortcut` that stops
/// registering fails nothing else.
///
/// It does need the simulator's **hardware keyboard connected**
/// (Simulator, I/O, Keyboard, Connect Hardware Keyboard), like the other typing
/// tests — see `apps/ios/README.md`.
final class ChannelPanelKeyboardUITests: XCTestCase {

    override func setUp() {
        continueAfterFailure = false
    }

    private func launchPanel() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-channelGraphs"]
        app.launch()
        return app
    }

    /// 1…4 select tabs by their place in the bar.
    func testNumberKeysSelectTabs() throws {
        let app = launchPanel()
        XCTAssertTrue(
            app.buttons["Time"].waitForExistence(timeout: 20),
            "the demo panel should offer its tabs"
        )

        app.typeKey("3", modifierFlags: [])
        XCTAssertTrue(
            app.otherElements["frictionCircle"].waitForExistence(timeout: 5),
            "3 should select the third tab, Grip, which is where the friction circle is"
        )
        XCTAssertTrue(app.buttons["Grip"].isSelected)

        app.typeKey("1", modifierFlags: [])
        XCTAssertTrue(
            app.otherElements["sectorTable"].waitForExistence(timeout: 5),
            "1 should go back to Time, where the sector table is"
        )
        XCTAssertTrue(app.buttons["Time"].isSelected)
    }

    /// `[` and `]` move the highlighted lap. The demo session's three laps are
    /// enough to show the step and the step back.
    func testBracketsStepTheHighlightedLap() throws {
        let app = launchPanel()
        XCTAssertTrue(app.buttons["Time"].waitForExistence(timeout: 20))

        // The fastest lap is pre-selected — the panel's own rule.
        XCTAssertEqual(Self.litLapLabels(app).count, 1, "one lap starts highlighted")
        let first = try XCTUnwrap(Self.litLapLabels(app).first)

        app.typeKey("]", modifierFlags: [])
        let stepped = try XCTUnwrap(Self.litLapLabels(app).first)
        XCTAssertNotEqual(stepped, first, "] should move the highlight to another lap")
        XCTAssertEqual(
            Self.litLapLabels(app).count, 1, "stepping replaces the lit lap rather than adding one"
        )

        app.typeKey("[", modifierFlags: [])
        XCTAssertEqual(Self.litLapLabels(app).first, first, "[ should step back to where it started")
    }

    /// ⌘F hides the laps that aren't highlighted. The plot is drawn on a canvas,
    /// so the assertion is the friction circle's spoken value — which is also the
    /// only way a screen-reader user learns the envelope has gone.
    func testCommandFTogglesTheEnvelope() throws {
        let app = launchPanel()
        XCTAssertTrue(app.buttons["Time"].waitForExistence(timeout: 20))
        app.typeKey("3", modifierFlags: [])

        let circle = app.otherElements["frictionCircle"]
        XCTAssertTrue(circle.waitForExistence(timeout: 5))
        XCTAssertFalse(Self.value(of: circle).contains("Other laps hidden"))

        app.typeKey("f", modifierFlags: .command)
        XCTAssertTrue(
            Self.wait(circle) { $0.contains("Other laps hidden") },
            "command-F should hide the envelope, and say so"
        )

        app.typeKey("f", modifierFlags: .command)
        XCTAssertTrue(
            Self.wait(circle) { !$0.contains("Other laps hidden") },
            "command-F again should bring it back"
        )
    }

    // MARK: - Helpers

    /// The labels of the lap chips currently highlighted. A chip carries the
    /// selected trait exactly when its lap has a colour slot.
    private static func litLapLabels(_ app: XCUIApplication) -> [String] {
        app.buttons
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Lap "))
            .allElementsBoundByIndex
            .filter { $0.isSelected }
            .map { $0.label }
    }

    private static func value(of element: XCUIElement) -> String {
        element.value as? String ?? ""
    }

    /// Poll rather than an expectation: the value changes without an event to
    /// wait on, and the change is a redraw away.
    private static func wait(_ element: XCUIElement, until matches: (String) -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if matches(value(of: element)) { return true }
            usleep(100_000)
        }
        return false
    }
}
