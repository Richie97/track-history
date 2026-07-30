import XCTest

/// Gestures that other tests can't see going wrong.
///
/// Both of these fail *silently* in the worst way: every button still works, every
/// assertion elsewhere still passes, and the app just stops responding to a finger the
/// way a phone should. They exist because one of them was actually broken.
final class GestureUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    /// A chart must not eat the page's scroll.
    ///
    /// `ProgressChart` used to carry a `DragGesture(minimumDistance: 0)` for
    /// drag-to-read. Inside a vertical scroller — which is every screen it appears on —
    /// that took the touch which would have started a scroll, so the event page refused
    /// to move whenever your finger landed on the chart. It sits across the middle of
    /// the screen, so in practice the page looked frozen.
    ///
    /// The read-out is a tap now. This asserts the scroll: swipe *starting on the
    /// chart* and the record panel, far below it, must come into view.
    func testTheEventPageScrollsWhenTheSwipeStartsOnTheChart() throws {
        let app = try launchSignedIn()

        let event = app.buttons["recentEventCard"].firstMatch
        XCTAssertTrue(event.waitForExistence(timeout: 20))
        event.tap()
        XCTAssertTrue(app.staticTexts["Best time"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Lap times"].waitForExistence(timeout: 10), "the chart should be on screen")

        // Centred on the collection view, which puts the touch down on the chart.
        app.collectionViews.firstMatch.swipeUp(velocity: .fast)

        XCTAssertTrue(
            app.buttons["recordEntry"].waitForExistence(timeout: 10),
            "a swipe starting on the chart must scroll the page, not be swallowed by it"
        )
    }

    /// Swipe from the left edge to go back. `NavigationStack` gives this for free, so
    /// what's tested is that nothing steals it — a stray gesture on a chart or a list
    /// row would.
    private func swipeBack(_ app: XCUIApplication, atHeight dy: CGFloat) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.002, dy: dy))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: dy))
        start.press(forDuration: 0.05, thenDragTo: end)
    }

    func testSwipeBackFromTheTrackPageOverTheChart() throws {
        let app = try launchSignedIn()

        let card = app.buttons["trackCard"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20))
        card.tap()
        XCTAssertTrue(app.staticTexts["Personal best"].waitForExistence(timeout: 15))

        // 0.32 crosses the progress chart.
        swipeBack(app, atHeight: 0.32)

        XCTAssertTrue(
            app.buttons["+ Add event"].waitForExistence(timeout: 10),
            "an edge swipe over the chart should still pop back to the dashboard"
        )
    }

    func testSwipeBackFromTheEventPageOverTheLapList() throws {
        let app = try launchSignedIn()

        let event = app.buttons["recentEventCard"].firstMatch
        XCTAssertTrue(event.waitForExistence(timeout: 20))
        event.tap()
        XCTAssertTrue(app.staticTexts["Best time"].waitForExistence(timeout: 15))

        // Low on the screen, across the `List` whose rows carry `swipeActions`.
        swipeBack(app, atHeight: 0.75)

        XCTAssertTrue(
            app.buttons["+ Add event"].waitForExistence(timeout: 10),
            "an edge swipe over the lap list should still pop back to the dashboard"
        )
    }

    func testSwipeBackFromSettings() throws {
        let app = try launchSignedIn()

        app.buttons["Account"].tap()
        XCTAssertTrue(app.staticTexts["Privacy policy"].waitForExistence(timeout: 15))

        swipeBack(app, atHeight: 0.5)

        XCTAssertTrue(
            app.buttons["+ Add event"].waitForExistence(timeout: 10),
            "an edge swipe should pop settings"
        )
    }
}
