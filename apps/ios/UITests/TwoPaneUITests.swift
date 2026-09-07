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

    /// Picking a *second* row from the list pane must actually change the detail.
    ///
    /// The regression this pins was invisible in a stack and unmissable on an iPad:
    /// `AppRouter.open` replaces `path[0]` rather than pushing, so the second row
    /// you tap lands at the same stack depth in the same screen type. SwiftUI keeps
    /// that view's identity and its `@State` with it, and every screen here builds
    /// its model in a `.task { if model == nil … }` — so the detail went on showing
    /// the first row you picked while the list pane's selection border moved on
    /// without it. The fix is `.id(route)` on the destination in `RootView`.
    ///
    /// The probe is the **detail pane's own title**, which each screen takes from
    /// its model: a stale model is exactly a stale title. The two nav bars are told
    /// apart by which one is further right, not by index. Compact width has nothing
    /// to assert — there is one pane, and the test above covers it.
    func testPickingASecondRowFromTheListPaneReplacesTheDetail() throws {
        let app = try launchSignedIn(tier: .free)

        XCTAssertTrue(
            app.buttons["+ Add event"].waitForExistence(timeout: 20),
            "the dashboard is the list pane"
        )

        let cards = app.buttons.matching(identifier: "trackCard")
        XCTAssertTrue(cards.firstMatch.waitForExistence(timeout: 20), "the seed should give the grid tracks")

        let width = app.windows.firstMatch.frame.width
        try XCTSkipUnless(width >= 840, "one pane at \(Int(width))pt — there is no detail to replace")
        try XCTSkipUnless(cards.count >= 2, "needs two tracks in the seed to pick a second one")

        // What the empty state calls itself, so the first tap is waited out against
        // the placeholder rather than against "anything non-empty".
        let placeholder = Self.detailTitle(app)

        cards.element(boundBy: 0).tap()
        let first = Self.waitForDetailTitle(app, changingFrom: placeholder)
        XCTAssertNotEqual(
            first,
            placeholder,
            "tapping a track card should open its page in the detail — bars: \(Self.barSummary(app))"
        )

        cards.element(boundBy: 1).tap()
        let second = Self.waitForDetailTitle(app, changingFrom: first)
        attach(app, named: "two-pane-second-pick")

        XCTAssertNotEqual(
            second,
            first,
            "picking a second row from the list pane must replace the detail, not leave the first one showing"
        )
        XCTAssertFalse(second.isEmpty, "the second row's page should have loaded, not gone blank")
    }

    /// A route that owns the whole window can be left again (#TBD).
    ///
    /// At expanded width the recorder is a `fullScreenCover` rather than a push, so
    /// it is the *root* of its own stack: the system draws no back button and there
    /// is no stack behind it to swipe back through. It shipped that way, which made
    /// the record screen a room with no door on an iPad — reachable from the
    /// dashboard's own button and leaveable only by force-quitting. The cover now
    /// carries its own control.
    ///
    /// Pro, because the recorder is gated and a free account gets the paywall here
    /// instead — which has its own way out and would not be testing this one.
    func testTheRecorderCanBeLeftAgainWhenItOwnsTheWindow() throws {
        let app = try launchSignedIn(tier: .pro)

        let addEvent = app.buttons["+ Add event"]
        XCTAssertTrue(addEvent.waitForExistence(timeout: 20), "the dashboard is the list pane")

        let width = app.windows.firstMatch.frame.width
        try XCTSkipUnless(width >= 840, "at \(Int(width))pt the recorder is a push and the system draws the way back")

        let record = app.buttons["dashboardRecord"]
        XCTAssertTrue(record.waitForExistence(timeout: 20), "the dashboard offers the recorder when it is idle")
        record.tap()

        let back = app.buttons["fullWindowBack"]
        XCTAssertTrue(back.waitForExistence(timeout: 20), "the recorder owns the window, so it carries its own way back")
        attach(app, named: "recorder-full-window")
        back.tap()

        XCTAssertTrue(
            addEvent.waitForExistence(timeout: 20),
            "leaving the recorder should put the logbook back in front of you"
        )
    }

    /// Poll the detail pane's title until it changes, or give up and return what it
    /// still says — so the assertion, not the wait, is what reports the failure.
    private static func waitForDetailTitle(
        _ app: XCUIApplication,
        changingFrom previous: String,
        timeout: TimeInterval = 20
    ) -> String {
        let deadline = Date().addingTimeInterval(timeout)
        var title = previous
        while Date() < deadline {
            title = detailTitle(app)
            if title != previous, !title.isEmpty { return title }
        }
        return title
    }

    /// The detail pane's navigation bar title.
    ///
    /// The **widest** bar, not the rightmost: a split view reports the detail's bar
    /// spanning the whole window (`@0w1032` on a 13-inch iPad) with the sidebar's
    /// inset inside it (`@10w320`), so comparing left edges picks the sidebar and
    /// reads "Track Evolution" whatever the detail is showing. Width tells them
    /// apart at every split-view proportion, and at compact width there is only one
    /// bar to pick.
    private static func detailTitle(_ app: XCUIApplication) -> String {
        app.navigationBars.allElementsBoundByIndex
            .max { $0.frame.width < $1.frame.width }?
            .identifier ?? ""
    }

    /// Every navigation bar with where it sits — for a failure message, so one run
    /// says what the pane structure actually was.
    private static func barSummary(_ app: XCUIApplication) -> String {
        app.navigationBars.allElementsBoundByIndex
            .map { "\($0.identifier)@\(Int($0.frame.minX))w\(Int($0.frame.width))" }
            .joined(separator: ", ")
    }
}
