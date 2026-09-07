import UIKit
import XCTest

/// The app rotates, and the layout class follows the window that rotating gives
/// it (spec: NS-34).
///
/// NS-34 derives the layout class from the *window* and re-reads it while the app
/// runs — Split View, Stage Manager, folding, and above all rotation, which is
/// the one every user performs. Nothing in the suite ever turned a device, so
/// "landscape works" rested entirely on two arrays in `Info.plist` and on the
/// `GeometryReader` in `measuringLayoutClass()` being re-evaluated. This asserts
/// both.
final class RotationUITests: XCTestCase {

    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        // The simulator keeps its orientation between test cases, so a suite that
        // left one on its side would hand every later test a window it never asked
        // for.
        XCUIDevice.shared.orientation = .portrait
    }

    /// The window turns at all.
    ///
    /// Needs no dev server and no session: whether the window turns is a question
    /// the sign-in screen answers as well as the logbook does.
    func testTheWindowTurnsWithTheDevice() {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))

        let portrait = app.frame
        XCUIDevice.shared.orientation = .landscapeLeft
        let landscape = settledFrame(of: app)

        XCTAssertGreaterThan(
            landscape.width, landscape.height,
            """
            the window is \(Int(landscape.width))×\(Int(landscape.height)) after rotating \
            (it was \(Int(portrait.width))×\(Int(portrait.height))) — check \
            UISupportedInterfaceOrientations in App/Info.plist
            """
        )
    }

    /// Turning the device grows the second pane, with no relaunch.
    ///
    /// The stronger half, and the one only a rotation can make: on an iPad whose
    /// portrait width is below `LayoutClass.EXPANDED_MIN_DP` and whose landscape
    /// width is above it — an iPad mini is the clearest — the two-pane shell has
    /// to appear on the turn. On any other device there is nothing to assert, so
    /// the test says which device to run it on and stops.
    ///
    /// **The idiom is part of that guard, not a shortcut for the width.**
    /// `LayoutClass.of` answers `.compact` whenever UIKit reports a compact
    /// horizontal size class, whatever the number — so an iPhone 17 Pro at 874pt
    /// in landscape is over the 840pt breakpoint and still deliberately one
    /// column. Guarding on width alone would fail this test on exactly the
    /// destination the rest of the suite runs on.
    ///
    /// Needs `npm run dev`; skips otherwise. See `DevServerSignIn`.
    func testTurningTheDeviceCanGrowTheSecondPane() throws {
        XCUIDevice.shared.orientation = .portrait
        let app = try launchSignedIn(tier: .free)

        let addEvent = app.buttons["+ Add event"]
        XCTAssertTrue(addEvent.waitForExistence(timeout: 20), "the dashboard is the list pane")

        let portraitWidth = app.frame.width
        XCUIDevice.shared.orientation = .landscapeLeft
        let landscape = settledFrame(of: app)

        let isPad = UIDevice.current.userInterfaceIdiom == .pad
        try XCTSkipUnless(
            isPad && portraitWidth < 840 && landscape.width >= 840,
            """
            turning this device crosses no layout-class boundary \
            (\(isPad ? "iPad" : "iPhone"), \(Int(portraitWidth))pt → \(Int(landscape.width))pt) \
            — run this on an iPad mini to exercise the crossing
            """
        )

        let card = app.buttons["trackCard"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20), "the seed should give the grid a track")
        card.tap()
        XCTAssertTrue(
            app.buttons["+ Add event at this track"].waitForExistence(timeout: 20)
                || app.staticTexts["Events"].waitForExistence(timeout: 5),
            "tapping a track card should open its page"
        )
        attach(app, named: "two-pane-after-rotating")
        XCTAssertTrue(
            addEvent.exists,
            """
            at \(Int(landscape.width))pt the dashboard should have become a pane of its own \
            without a relaunch — it was one column at \(Int(portraitWidth))pt
            """
        )
    }

    /// The app's frame once the rotation animation has stopped moving it.
    ///
    /// Reading it any earlier is the trap this suite fell into first: the frame is
    /// sampled live, and a mid-animation sample of an iPad mini turning reads
    /// 1311×340 — already wider than it is tall, and nothing like either
    /// orientation. Two identical readings in a row is what "settled" means here;
    /// waiting on `width > height` alone passes on a frame that is still moving,
    /// and the assertion then compares a number that belongs to no layout.
    private func settledFrame(of app: XCUIApplication) -> CGRect {
        var previous = CGRect.null
        for _ in 0..<60 {
            let current = app.frame
            if current == previous, current.width > 0 { return current }
            previous = current
            let tick = expectation(description: "settling")
            tick.isInverted = true
            _ = XCTWaiter.wait(for: [tick], timeout: 0.25)
        }
        return app.frame
    }
}
