import XCTest

/// Getting a UI test to a signed-in app, against the local dev server.
///
/// Shared by every UI test that needs real data, because the `DEV_MODE` bypass is the
/// only way through the `ASWebAuthenticationSession` browser step without typing a
/// Google password:
///
///     npm run dev     # at the repo root, with .dev.vars
///
/// Tests probe for that server and **skip** when it isn't there, so a plain
/// `xcodebuild test` — and CI — stays green. (Probing beats an environment flag:
/// `xcodebuild` doesn't forward the shell environment to the test process, so a flag
/// would silently skip exactly when you meant to run it.)
extension XCTestCase {
    /// `http://localhost:8787` unless told otherwise. The override exists because
    /// `wrangler dev` picks the next free port when 8787 is taken, so a second
    /// checkout of this repo lands on 8788 — and without this its UI tests would
    /// silently write to the *other* checkout's logbook:
    ///
    ///     xcodebuild test … TEST_RUNNER_TE_DEV_SERVER=http://localhost:8788
    ///
    /// `xcodebuild` doesn't forward the shell environment to the test process, but
    /// it does forward variables prefixed `TEST_RUNNER_`, with the prefix stripped.
    static let devServerURL =
        ProcessInfo.processInfo.environment["TE_DEV_SERVER"] ?? "http://localhost:8787"

    /// Is `wrangler dev` up? Also confirms the bypass is enabled: without
    /// `DEV_MODE=1` in `.dev.vars` the flow would need a real Google password.
    func devServerIsRunning() -> Bool {
        var request = URLRequest(url: URL(string: "\(Self.devServerURL)/auth/providers")!)
        request.timeoutInterval = 3
        var ok = false
        let probe = expectation(description: "dev server probe")
        URLSession.shared.dataTask(with: request) { _, response, _ in
            ok = (response as? HTTPURLResponse)?.statusCode == 200
            probe.fulfill()
        }.resume()
        wait(for: [probe], timeout: 8)
        return ok
    }

    /// Bring an element into view, and say whether it got there.
    ///
    /// Two things this has to get right, each learned the hard way:
    ///
    /// - **Scroll the scroller, not the app.** `app.swipeUp()` swipes the application
    ///   element and reliably moves nothing on these screens; the gesture has to land
    ///   on the scroll container. A SwiftUI `List` is a collection view, a `ScrollView`
    ///   a scroll view.
    /// - **Wait for `isHittable`, not `exists`.** A `List` builds rows lazily, so an
    ///   off-screen row may not exist yet — but once it does exist it can still be
    ///   off-screen, and `tap()` on it fails. Hittable is the property that matters.
    @discardableResult
    func scrollTo(_ element: XCUIElement, in app: XCUIApplication, swipes: Int = 12) -> Bool {
        let scroller =
            app.collectionViews.firstMatch.exists
            ? app.collectionViews.firstMatch
            : (app.scrollViews.firstMatch.exists ? app.scrollViews.firstMatch : app)
        for _ in 0..<swipes {
            if element.exists && element.isHittable { return true }
            scroller.swipeUp(velocity: .fast)
        }
        return element.exists && element.isHittable
    }

    /// Launch, tap through the browser flow, and return the app on the dashboard.
    func launchSignedIn() throws -> XCUIApplication {
        try XCTSkipUnless(devServerIsRunning(), "needs `npm run dev` on :8787")

        let app = XCUIApplication()
        // UserDefaults reads launch arguments, so pointing the app at the dev server
        // needs no test hook. The dev bypass only answers on localhost.
        //
        // -resetAuth clears the Keychain token, which outlives an app reinstall in the
        // simulator: without it a test would pass by starting already signed in.
        // -resetRecording does the same for an unsaved recording, which would
        // otherwise put a banner on the dashboard that this run didn't create.
        app.launchArguments = [
            "-server.url", Self.devServerURL, "-resetAuth", "-resetRecording"
        ]
        app.launch()

        let google = app.buttons["Continue with Google"]
        XCTAssertTrue(google.waitForExistence(timeout: 15), "the sign-in screen should offer Google")
        google.tap()

        // "TrackEvolution wants to use localhost to sign in" — the consent alert
        // belongs to springboard, not to the app.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let consent = springboard.buttons["Continue"]
        if consent.waitForExistence(timeout: 15) {
            consent.tap()
        }

        // The dashboard's own button, rather than anything about the account: this is
        // the assertion that the exchanged token actually loaded the logbook.
        XCTAssertTrue(
            app.buttons["+ Add event"].waitForExistence(timeout: 30),
            "the exchanged token should land on the dashboard"
        )
        return app
    }
}
