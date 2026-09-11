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
    /// The fixture for the column test below — distinct from every other suite's,
    /// since the dev logbook is shared and the test navigates by name.
    private static let track = "Two Pane Test Circuit (UITest)"

    private var seededEventId: Int?

    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        if let id = seededEventId {
            deleteEventBestEffort(id)
            seededEventId = nil
        }
        // Left as it was found: the simulator remembers the orientation, and a
        // suite that ends sideways rotates the next one's first screenshot.
        XCUIDevice.shared.orientation = .portrait
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

    /// The column beside the page ends where the pane does — at both orientations.
    ///
    /// This is the shipped-iPad bug, and the reason it needs a running app: both
    /// halves of it were arithmetic that compiled, passed every unit test, and was
    /// only wrong once something laid it out.
    ///
    /// The analysis column was given a width computed from the **window** and a
    /// slot decided by an `HStack` — and the two had nothing to do with each
    /// other, because `measuringPaneWidth()` wrapped the fixed frame in a greedy
    /// `GeometryReader` and the row simply halved itself. On a full-window
    /// 13-inch iPad that left 80pt of dead background down the right-hand side;
    /// with the sidebar showing it put 90pt of track map, legend and lap chips off
    /// the side of the screen, and in portrait, 104pt.
    ///
    /// So the assertion is the invariant both failures break, in one line each:
    /// the column ends where the window ends. Nothing hangs off the edge, and
    /// nothing stops short of it. Where the pane is too narrow for two columns the
    /// column is simply not there — the third thing that changed, and why its
    /// absence is a pass rather than a skip; the run still has to have seen one
    /// somewhere, or it has asserted nothing at all.
    ///
    /// It seeds its own event because an analysis column with nothing in it cannot
    /// overflow: the empty state fits any width, and the content is the whole
    /// question.
    func testTheColumnBesideThePageFillsThePaneAndNeverOverrunsIt() throws {
        try XCTSkipUnless(devServerIsRunning(), "needs `npm run dev` on :8787")
        seededEventId = try seedImportedSession(track: Self.track)

        let app = try launchSignedIn(tier: .pro)
        // A phone is the phone layout at every width — UIKit reports `.compact`
        // whatever the number, and `LayoutClass` follows it — so there is nothing
        // here to measure however it is turned. 600 is `MEDIUM_MIN_DP`, spelled
        // out because a UI test does not link the app.
        let window = app.windows.firstMatch.frame
        try XCTSkipUnless(
            min(window.width, window.height) >= 600,
            "one column at both orientations on this device — nothing to measure"
        )

        // By name: every track card carries the same identifier, and this one has
        // the channels.
        let card = app.buttons.matching(
            NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "trackCard", "Two Pane Test")
        ).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20), "the seeded track should have a dashboard card")
        scrollTo(card, in: app)
        card.tap()

        let event = app.buttons["trackEventCard"].firstMatch
        XCTAssertTrue(event.waitForExistence(timeout: 15), "the track page should list the seeded event")
        event.tap()
        XCTAssertTrue(app.staticTexts["Best time"].waitForExistence(timeout: 20), "the event page should load")

        // Both ways round, because the pane is a different width in each and the
        // failure was a different one in each: too much room in landscape, too
        // little in portrait.
        var sawColumn = false
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            waitForWindow(app, landscape: orientation == .landscapeLeft)
            sawColumn = assertTheSideColumnFitsThePane(
                app, named: "analysis-column-\(orientation == .portrait ? "portrait" : "landscape")"
            ) || sawColumn
        }
        XCUIDevice.shared.orientation = .landscapeLeft

        // A skip rather than a failure, and the distinction is the point: how wide
        // the *pane* gets depends on the sidebar the system sizes, so a tablet
        // narrow enough to be one column at both orientations is a device this
        // test cannot run on rather than a bug. Silently passing would be the
        // third option and the wrong one — nothing above would have been measured.
        try XCTSkipUnless(
            sawColumn,
            "the event page stayed one column at both orientations — no column to measure on this device"
        )
    }

    /// Wait for the window to be the shape the device was just turned to.
    ///
    /// Rotation is not instant and the screenshot proves it: measured too early,
    /// the app is still laid out for the width it had, with the new one painted
    /// black beside it. Polling the window's own frame is what the assertions are
    /// about anyway, so there is nothing else to synchronise on.
    private func waitForWindow(_ app: XCUIApplication, landscape: Bool, timeout: TimeInterval = 10) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let frame = app.windows.firstMatch.frame
            if frame.width > 0, (frame.width > frame.height) == landscape {
                // The frame is the new one before the pixels are: a screenshot
                // taken here catches the old layout rotated into the new canvas,
                // with the rest of the window black. The measurement is already
                // right; this is so the attachment is worth keeping.
                Thread.sleep(forTimeInterval: 0.75)
                return
            }
        }
    }

    /// The column ends exactly where the window does, or isn't there at all.
    ///
    /// Retried rather than read once: a split view re-lays out over a frame or
    /// two after a rotation, and a mid-flight measurement is a flake rather than a
    /// finding. The last reading is the one asserted, so a real failure still
    /// reports its own numbers.
    ///
    /// A point of tolerance either way: these are accessibility frames in screen
    /// points, and a hairline divider is allowed to round.
    @discardableResult
    private func assertTheSideColumnFitsThePane(_ app: XCUIApplication, named: String) -> Bool {
        let deadline = Date().addingTimeInterval(6)
        var window = CGRect.zero
        var frame: CGRect?
        repeat {
            window = app.windows.firstMatch.frame
            let column = app.descendants(matching: .any)["analysisColumn"]
            frame = column.exists ? column.frame : nil
            if let frame, abs(frame.maxX - window.maxX) <= 1, frame.width >= 379 { break }
        } while Date() < deadline

        // The **screen**, not the app: `XCUIApplication.screenshot()` hands back
        // the framebuffer without the device rotation applied, so a landscape run
        // attaches a portrait image with the layout turned on its side and the
        // rest of the canvas black — which looks exactly like the bug this is
        // about. `XCUIScreen` applies it.
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = named
        shot.lifetime = .keepAlways
        add(shot)
        // What was measured, on a pass as well as a failure: "the column is where
        // it should be" is a claim about numbers, and a green run that never found
        // a column looks identical to one that measured a good one.
        let note = XCTAttachment(
            string: frame.map {
                "window \(Int(window.width))×\(Int(window.height))pt, "
                    + "column \(Int($0.minX))…\(Int($0.maxX))pt (\(Int($0.width))pt wide)"
            } ?? "window \(Int(window.width))×\(Int(window.height))pt, one column"
        )
        note.name = "\(named)-geometry"
        note.lifetime = .keepAlways
        add(note)

        guard let frame else { return false }  // one column here — see the note above.
        let where_ = "window \(Int(window.width))pt, column \(Int(frame.minX))…\(Int(frame.maxX))"

        XCTAssertLessThanOrEqual(
            frame.maxX, window.maxX + 1,
            "the analysis column runs off the side of the window — \(where_)"
        )
        XCTAssertGreaterThanOrEqual(
            frame.maxX, window.maxX - 1,
            "the analysis column stops short of the window, leaving dead background — \(where_)"
        )
        XCTAssertGreaterThanOrEqual(
            frame.width, 379,
            "a column this narrow should not have been drawn at all — \(where_)"
        )
        return true
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
