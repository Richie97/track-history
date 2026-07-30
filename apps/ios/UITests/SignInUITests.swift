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
        let app = try launchSignedIn()

        // The account itself is on the settings screen, which is also where the
        // required privacy and terms links live.
        app.buttons["Account"].tap()
        XCTAssertTrue(
            app.staticTexts["dev@example.com"].waitForExistence(timeout: 15),
            "the exchanged token should load the dev account"
        )
    }
}
