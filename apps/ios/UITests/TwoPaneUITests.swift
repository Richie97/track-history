import XCTest

/// The two-pane shell at expanded width (spec: NS-34 ticket 2).
///
/// This is the assertion #216 asked for and could not have: at expanded width the
/// dashboard stays beside the detail, and at compact width opening something
/// replaces it. Both are the *same* navigation call — `AppRouter.open` — so the
/// only way to tell them apart is to look at a running app at two widths, which
/// is what this does.
///
/// The expectation comes from the **window's own width** rather than from the
/// destination the test was launched on: one test, run on an iPhone and on an
/// iPad, asserting the rule rather than the device. `RouterTests` pins the
/// navigation semantics underneath it, and `LayoutClassTests` pins the boundary
/// the width is compared against.
///
/// Needs `npm run dev`; skips otherwise. See `DevServerSignIn`.
final class TwoPaneUITests: XCTestCase {

    override func setUp() {
        continueAfterFailure = false
    }

    func testTheDashboardStaysBesideTheDetailOnlyWhenThereIsRoom() throws {
        let app = try launchSignedIn(tier: .free)

        let addEvent = app.buttons["+ Add event"]
        XCTAssertTrue(addEvent.waitForExistence(timeout: 20), "the dashboard is the list pane")

        let card = app.buttons["trackCard"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20), "the seed should give the grid a track")
        card.tap()

        // The track page has arrived either way — this is about what happened to
        // the dashboard behind it.
        XCTAssertTrue(
            app.buttons["+ Add event at this track"].waitForExistence(timeout: 20)
                || app.staticTexts["Events"].waitForExistence(timeout: 5),
            "tapping a track card should open its page"
        )

        let width = app.windows.firstMatch.frame.width
        let expanded = width >= 840
        attach(app, named: expanded ? "two-pane-expanded" : "one-pane-compact")

        if expanded {
            XCTAssertTrue(
                addEvent.exists,
                "at \(Int(width))pt the dashboard is a pane of its own and stays put beside the detail"
            )
        } else {
            XCTAssertFalse(
                addEvent.exists,
                "at \(Int(width))pt the detail is a push, so the dashboard goes behind it"
            )
        }
    }
}
