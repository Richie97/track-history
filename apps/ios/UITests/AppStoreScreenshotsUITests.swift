import XCTest

/// The App Store listing's screens that only a tap reaches (epic #277, ticket 4).
///
/// The rest of the listing is deep-linked with `-openLink` and captured with
/// `simctl io screenshot`, which needs no test at all; these three sit behind a
/// button, and on the iPhone Duo the simulator's tap control drives only the cover
/// display, so a UI test is the one thing that can reach them on the inner one.
///
/// Runs only when handed a logbook to film — the promo's demo logbook (`promo/`),
/// served by its scratch Worker — and skips otherwise, so CI and an ordinary
/// `xcodebuild test` never touch it. The variables go in xcodebuild's
/// *environment* — as `KEY=VALUE` arguments they are build settings, and ignored:
///
///     TEST_RUNNER_TE_DEV_SERVER=http://localhost:<port> TEST_RUNNER_TE_SHOT_TOKEN=<token> \
///     TEST_RUNNER_TE_SHOT_EVENT=6 TEST_RUNNER_TE_SHOT_TRACK=1 TEST_RUNNER_TE_SHOT_LAP=216 \
///       xcodebuild test … -only-testing:TrackEvolutionUITests/AppStoreScreenshotsUITests
///
/// Each capture is a `XCTAttachment` kept on success, named for its listing slot;
/// `xcrun xcresulttool export attachments` takes them out of the result bundle.
final class AppStoreScreenshotsUITests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipUnless(env["TE_SHOT_TOKEN"] != nil, "needs TE_SHOT_TOKEN — a demo logbook to film")
    }

    private func launch(link: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-server.url", Self.devServerURL, "-resetAuth", "-resetRecording",
            "-authToken", env["TE_SHOT_TOKEN"]!, "-openLink", "https://trackevolution.app/#/\(link)",
        ]
        app.launch()
        return app
    }

    private func capture(_ name: String, in app: XCUIApplication) {
        // Charts animate in and lists settle; the listing wants the still frame.
        Thread.sleep(forTimeInterval: 3)
        // Not `XCUIScreen.main`: on the Duo that is the cover display, dark while
        // the phone is open. The screen to film is the one the app's window fills
        // — the inner display open, the cover closed, the only one elsewhere.
        let window = app.windows.firstMatch.frame.size
        let screen = XCUIScreen.screens.first {
            let size = $0.screenshot().image.size
            return abs(size.width - window.width) < 1 && abs(size.height - window.height) < 1
        } ?? XCUIScreen.main
        let shot = XCTAttachment(screenshot: screen.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testLeaderboard() throws {
        let app = launch(link: "track/\(env["TE_SHOT_TRACK"] ?? "1")")
        let button = app.buttons["Leaderboard"]
        XCTAssertTrue(button.waitForExistence(timeout: 20))
        XCTAssertTrue(scrollTo(button, in: app))
        button.tap()
        capture("07-leaderboard", in: app)
    }

    func testTwoLapCompare() throws {
        let app = launch(link: "track/\(env["TE_SHOT_TRACK"] ?? "1")")
        let button = app.buttons["Compare two laps"]
        XCTAssertTrue(button.waitForExistence(timeout: 20))
        XCTAssertTrue(scrollTo(button, in: app))
        button.tap()
        // The sheet's own explainer, which is there once the pair is aligned.
        let explainer = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "delta chart")).firstMatch
        XCTAssertTrue(explainer.waitForExistence(timeout: 20))
        capture("08-compare", in: app)
    }

    func testLapGrip() throws {
        let app = launch(link: "event/\(env["TE_SHOT_EVENT"] ?? "6")")
        // A `List` row: built only once it is scrolled near, so scroll before
        // waiting rather than waiting for it to exist first.
        XCTAssertTrue(app.collectionViews.firstMatch.waitForExistence(timeout: 20))
        let lap = app.descendants(matching: .any)["lap-\(env["TE_SHOT_LAP"] ?? "")"]
        XCTAssertTrue(scrollTo(lap, in: app, swipes: 40))
        lap.tap()
        XCTAssertTrue(app.descendants(matching: .any)["lapDetail"].waitForExistence(timeout: 20))
        capture("09-lap-time", in: app)
        let grip = app.buttons["Grip"]
        if scrollTo(grip, in: app) {
            grip.tap()
            // Lift the friction circle clear of the floating tab bar.
            let list = app.scrollViews.firstMatch.exists ? app.scrollViews.firstMatch : app.collectionViews.firstMatch
            list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
                .press(forDuration: 0.05, thenDragTo: list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)))
            capture("10-lap-grip", in: app)
        }
    }
}
