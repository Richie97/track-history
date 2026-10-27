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

    /// 1…3 select tabs by their place in the bar.
    func testNumberKeysSelectTabs() throws {
        let app = launchPanel()
        XCTAssertTrue(
            app.buttons["Traces"].waitForExistence(timeout: 20),
            "the demo panel should offer its tabs"
        )

        app.typeKey("2", modifierFlags: [])
        XCTAssertTrue(
            app.otherElements["frictionCircle"].waitForExistence(timeout: 5),
            "2 should select the second tab, Grip, which is where the friction circle is"
        )
        XCTAssertTrue(app.buttons["Grip"].isSelected)

        app.typeKey("1", modifierFlags: [])
        XCTAssertTrue(
            app.otherElements["sectorTable"].waitForExistence(timeout: 5),
            "1 should go back to Traces, where the sector table is"
        )
        XCTAssertTrue(app.buttons["Traces"].isSelected)
    }

    /// `[` and `]` move the highlighted lap. The demo session's three laps are
    /// enough to show the step and the step back.
    func testBracketsStepTheHighlightedLap() throws {
        let app = launchPanel()
        XCTAssertTrue(app.buttons["Traces"].waitForExistence(timeout: 20))

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
        XCTAssertTrue(app.buttons["Traces"].waitForExistence(timeout: 20))
        app.typeKey("2", modifierFlags: [])

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

    // MARK: - The cursor and the axis

    /// Tapping a trace parks a cursor there — "Marked at …" with a Clear — and
    /// the Distance / Time switch re-lays the charts out against time, which
    /// clears it. Pointer-free, so it needs no keyboard either.
    func testATapMarksThePlaceAndTheAxisSwitchesToTime() throws {
        let app = launchPanel()
        let speed = app.descendants(matching: .any)["Speed by driven distance, per lap"]
        XCTAssertTrue(speed.waitForExistence(timeout: 20), "the demo panel draws speed on the Traces tab")
        XCTAssertTrue(
            app.descendants(matching: .any)["cursorMap"].exists,
            "a panel with no map beside it draws one for the cursor"
        )

        speed.tap()
        let bar = app.descendants(matching: .any)["cursorBar"]
        XCTAssertTrue(bar.waitForExistence(timeout: 5), "a tap parks the cursor")
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Marked at ")).firstMatch.exists
        )
        app.buttons["clearCursor"].tap()
        XCTAssertTrue(Self.waitGone(bar), "Clear lets go of it")

        let time = app.segmentedControls["axisSwitch"].buttons["Time"]
        XCTAssertTrue(time.exists, "the panel offers a time axis")
        time.tap()
        let speedByTime = app.descendants(matching: .any)["Speed by time, per lap"]
        XCTAssertTrue(speedByTime.waitForExistence(timeout: 5), "the charts say which axis they are on")
        speedByTime.tap()
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label MATCHES %@", "Marked at [0-9]+:[0-9]{2}\\.[0-9]")).firstMatch
                .waitForExistence(timeout: 5),
            "a place on a time axis is said as m:ss.s"
        )
    }

    // MARK: - The lap stage (NS-51)

    /// Space plays and pauses the stage; ← / → step it a second. `-lapStage`
    /// opens it on the same synthetic session, no server, with a generated clip
    /// on each lap.
    func testSpacePlaysAndArrowsStepTheLapStage() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-lapStage", "-syncMode", "place"]
        app.launch()

        let play = app.buttons["stagePlay"]
        XCTAssertTrue(play.waitForExistence(timeout: 30), "the demo stage should open")
        let scrubber = app.descendants(matching: .any)["stageScrubber"]
        XCTAssertTrue(scrubber.waitForExistence(timeout: 5))
        XCTAssertEqual(Self.value(of: scrubber), "\u{2212}0:02.0, Before the line", "it opens two seconds before the line")

        app.typeKey(.rightArrow, modifierFlags: [])
        XCTAssertTrue(
            Self.wait(scrubber) { $0 == "\u{2212}0:01.0, Before the line" },
            "→ should step one second"
        )
        app.typeKey(.leftArrow, modifierFlags: [])
        XCTAssertTrue(Self.wait(scrubber) { $0.hasPrefix("\u{2212}0:02.0") }, "← should step back")

        app.typeKey(" ", modifierFlags: [])
        XCTAssertTrue(Self.wait(play) { $0 == "playing" }, "space should play")
        XCTAssertTrue(
            Self.wait(scrubber) { $0.contains("in T") || $0.contains(" ft") || $0.contains(" mi") },
            "playing should carry the playhead over the line and into the lap"
        )
        app.typeKey(" ", modifierFlags: [])
        XCTAssertTrue(Self.wait(play) { $0 == "paused" }, "space again should pause")
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

    private static func waitGone(_ element: XCUIElement) -> Bool {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if !element.exists { return true }
            usleep(100_000)
        }
        return false
    }

    private static func value(of element: XCUIElement) -> String {
        element.value as? String ?? ""
    }

    /// Poll rather than an expectation: the value changes without an event to
    /// wait on, and the change is a redraw away.
    private static func wait(_ element: XCUIElement, until matches: (String) -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            if matches(value(of: element)) { return true }
            usleep(100_000)
        }
        return false
    }
}
