import XCTest

/// The one part of NS-08 no unit test can reach: tapping through the real
/// `ASWebAuthenticationSession` browser flow.
///
/// This is also what established that the reported "sign-in is broken" was the app
/// pointing at a dev server that was not running — the browser step itself works.
///
/// Requires a local dev server, because the `DEV_MODE` bypass is what lets the
/// flow complete without typing a Google password:
///
///     npm run dev     # at the repo root, with .dev.vars
///     xcodebuild test -project apps/ios/TrackEvolution.xcodeproj \
///       -scheme TrackEvolution -destination 'platform=iOS Simulator,name=iPhone 17'
///
/// It probes for that server and **skips** when it isn't there, so a plain
/// `xcodebuild test` — and CI — stays green. (Probing beats an environment flag:
/// `xcodebuild` doesn't forward the shell environment to the test process, so a
/// flag would silently skip exactly when you meant to run it.)
final class SignInUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    /// Is `wrangler dev` up? Also confirms the bypass is enabled: without
    /// `DEV_MODE=1` in `.dev.vars` the flow would need a real Google password.
    private func devServerIsRunning() -> Bool {
        var url = URLComponents(string: "http://localhost:8787/auth/providers")!
        url.scheme = "http"
        var request = URLRequest(url: url.url!)
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

    func testSignsInThroughTheSystemBrowser() throws {
        try XCTSkipUnless(devServerIsRunning(), "needs `npm run dev` on :8787")

        let app = XCUIApplication()
        // UserDefaults reads launch arguments, so this needs no test hook in the
        // app. The dev bypass only answers on localhost.
        // -resetAuth clears the Keychain token: it outlives an app reinstall in
        // the simulator, so without this the test would pass by starting already
        // signed in and never touching the browser at all.
        app.launchArguments = ["-server.url", "http://localhost:8787", "-resetAuth"]
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

        // DEV_MODE mints the one-time code and redirects straight back, so the app
        // should exchange it and land on the signed-in screen. That this arrives at
        // all is the regression guard: with the ASWebAuthenticationSession released
        // early, the sheet closed instantly and the app sat on its spinner.
        let email = app.staticTexts["dev@example.com"]
        XCTAssertTrue(
            email.waitForExistence(timeout: 30),
            "the exchanged token should load the dev account"
        )
    }
}
