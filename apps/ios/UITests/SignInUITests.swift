import XCTest

/// The one part of NS-08 no unit test can reach: tapping through the real
/// `ASWebAuthenticationSession` browser flow.
///
/// This is also what established that the reported "sign-in is broken" was the app
/// pointing at a dev server that was not running — the browser step itself works.
///
/// The flow itself lives in `DevServerSignIn`, shared with the screen tests; what
/// this file owns is the assertion that it completes at all.
final class SignInUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    /// That the dashboard arrives is the regression guard: with the
    /// `ASWebAuthenticationSession` released early, the sheet closed instantly, the
    /// completion handler never fired, and the app sat on its spinner forever.
    func testSignsInThroughTheSystemBrowser() throws {
        let app = try launchSignedIn(tier: .free)

        // The account itself is on the settings screen, which is also where the
        // required privacy and terms links live.
        app.buttons["Account"].tap()
        XCTAssertTrue(
            app.staticTexts["dev@example.com"].waitForExistence(timeout: 15),
            "the exchanged token should load the dev account"
        )
    }

    /// The sign-in screen must not wait on `GET /auth/providers`.
    ///
    /// `restore()` used to `await refreshProviders()` before deciding the auth state,
    /// which put a launch-blocking network request in front of every cold start: on a
    /// weak connection the app sat on its launch spinner for the full URLSession
    /// timeout — a minute of nothing — and then showed a sign-in screen whose Apple
    /// button that same failed request had just hidden.
    ///
    /// Pointed at a black-hole address so the request hangs rather than failing fast,
    /// which is the case that actually bit. No dev server needed, so this one runs in
    /// CI: the assertion is about *not* reaching the network.
    func testSignInScreenDoesNotWaitOnTheProvidersFetch() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-server.url", "http://10.255.255.1:8787", "-resetAuth", "-resetRecording"
        ]
        app.launch()

        // Comfortably inside URLSession's 60-second default, and comfortably outside
        // anything a cold launch legitimately needs.
        XCTAssertTrue(
            app.buttons["Continue with Google"].waitForExistence(timeout: 15),
            "sign-in should render before the providers request resolves"
        )

        // The brand mark is a drawn `Shape`, so a bad render fails no assertion — the
        // screenshot is the artifact that would show it. It's also the thing that was
        // missing entirely: the screen led with bare text and read as half-loaded.
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "sign-in"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
