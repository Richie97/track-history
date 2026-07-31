import XCTest

/// The prep-checklist template, end to end: edit it in Settings, and an event's
/// "Use my list" starts from what you edited.
///
/// The two halves live on different screens and read the same value through
/// `AuthController`, which is exactly the seam that would rot silently — a
/// Settings editor that saves to the server while the event page keeps offering
/// the built-in default would look fine on both screens on its own.
///
/// Needs `npm run dev`; skips otherwise, so CI stays green. The template is a
/// per-user setting on the shared dev account, so it is reset in `tearDown`.
final class ChecklistTemplateUITests: XCTestCase {
    private static let item = "Purchase Track insurance"
    private static let added = "Zip-tie the fog light (UITest)"

    private var seededEventId: Int?

    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        // Back to the built-in default, whatever the test left behind.
        _ = try? api("PUT", "/api/me/checklist-template", body: ["checklist_template": NSNull()])
        if let id = seededEventId {
            _ = try? api("DELETE", "/api/events/\(id)")
            seededEventId = nil
        }
    }

    func testEditingTheTemplateChangesWhatANewChecklistStartsFrom() throws {
        try XCTSkipUnless(devServerIsRunning(), "needs `npm run dev` on :8787")
        // A fresh account has no template, so the built-in default is what shows.
        _ = try api("PUT", "/api/me/checklist-template", body: ["checklist_template": NSNull()])
        let eventId = try seedUpcomingEvent()

        let app = try launchSignedIn()

        // --- Settings: the default is visible, and editing it makes it yours ---
        openSettings(app)

        let insurance = app.staticTexts[Self.item]
        XCTAssertTrue(scrollTo(insurance, in: app), "the built-in default leads with track insurance")
        XCTAssertTrue(
            app.staticTexts["This is the app's default — your first edit makes it yours."].exists,
            "an untouched template should say so"
        )

        let field = app.textFields["checklistTemplateField"]
        XCTAssertTrue(scrollTo(field, in: app), "the template can be added to")
        field.tap()
        field.typeText(Self.added)
        app.buttons["addChecklistTemplateItem"].tap()

        XCTAssertTrue(
            app.staticTexts[Self.added].waitForExistence(timeout: 15),
            "the added item should appear in the list"
        )
        XCTAssertTrue(
            app.staticTexts["This is your own list."].waitForExistence(timeout: 10),
            "editing it makes it the user's own"
        )
        attach(app, named: "checklist-template-settings")

        // The server has it, not just the screen.
        let saved = try api("GET", "/api/me")["user"] as? [String: Any]
        let template = try XCTUnwrap(saved?["checklist_template"] as? [String])
        XCTAssertEqual(template.first, Self.item, "the default's order survives an append")
        XCTAssertEqual(template.last, Self.added)

        // --- The event page starts a checklist from it ---
        app.buttons["BackButton"].firstMatch.tap()
        openEvent(app)

        let useTemplate = app.buttons["useChecklistTemplate"]
        XCTAssertTrue(scrollTo(useTemplate, in: app), "an upcoming event with no checklist offers the template")
        XCTAssertEqual(useTemplate.label, "Use my list", "a customized template should say whose it is")
        useTemplate.tap()

        // Back to the top: the tap grew the page by ten rows, and a `List` doesn't
        // keep rows it has scrolled away from.
        for _ in 0..<8 where !app.staticTexts[Self.item].isHittable {
            app.collectionViews.firstMatch.swipeDown(velocity: .fast)
        }
        XCTAssertTrue(
            app.staticTexts[Self.item].waitForExistence(timeout: 10),
            "the started checklist should show the template's first item"
        )
        // What actually got saved is the assertion that matters — the whole list,
        // in order, including the item added in Settings.
        let started = try api("GET", "/api/events/\(eventId)")
        let startedItems = (started["checklist"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }
        XCTAssertEqual(startedItems, template, "the checklist starts as an exact copy of the template")
        XCTAssertTrue(startedItems.contains(Self.added), "including what was added in Settings")

        attach(app, named: "checklist-from-template")

        // Editing the template again must not rewrite a checklist already started:
        // those are snapshots, and rewriting one would untick what's been done.
        _ = try api("PUT", "/api/me/checklist-template", body: ["checklist_template": ["Only this"]])
        let detail = try api("GET", "/api/events/\(eventId)")
        let checklist = try XCTUnwrap(detail["checklist"] as? [[String: Any]])
        XCTAssertTrue(
            checklist.contains { $0["text"] as? String == Self.added },
            "the event's own checklist is untouched by a later template edit"
        )
    }

    // MARK: - Helpers

    private func openSettings(_ app: XCUIApplication) {
        // The dashboard's Account button *is* Settings here — see DashboardScreen.
        let account = app.buttons["Account"]
        XCTAssertTrue(account.waitForExistence(timeout: 20), "the dashboard has the account button")
        account.tap()
        XCTAssertTrue(
            app.staticTexts["Prep checklist"].waitForExistence(timeout: 20),
            "Settings should carry the prep-checklist section"
        )
    }

    /// Reached through the dashboard's *upcoming* section, not the Tracks list:
    /// a track only gets a card once it has laps, and the point of this event is
    /// that it hasn't been driven yet.
    private func openEvent(_ app: XCUIApplication) {
        let hero = app.buttons["heroEvent"]
        let also = app.buttons.matching(
            NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "upcomingCard", "Checklist Test")
        ).firstMatch
        if also.waitForExistence(timeout: 5) {
            scrollTo(also, in: app)
            also.tap()
            return
        }
        XCTAssertTrue(hero.waitForExistence(timeout: 20), "the seeded event should be the nearest upcoming one")
        XCTAssertTrue(hero.label.contains("Checklist Test"), "got the hero card: \(hero.label)")
        hero.tap()
    }

    /// An event far enough ahead that the prep panel shows at all.
    private func seedUpcomingEvent() throws -> Int {
        let start = Self.dayOnly(Date().addingTimeInterval(21 * 86_400))
        let event = try api(
            "POST", "/api/events",
            body: [
                "track_name": "Checklist Test Circuit (UITest)",
                "start_date": start,
                "days": 1,
                "club": "UITest"
            ]
        )
        let id = try XCTUnwrap(event["id"] as? Int, "the dev server should return the created event")
        seededEventId = id
        return id
    }

    /// `yyyy-MM-dd` in UTC — the shape `events.start_date` takes, and the clock
    /// `EventDates.todayISO` counts from. Built per call rather than shared:
    /// `ISO8601DateFormatter` isn't `Sendable`, so a static one wouldn't compile
    /// under Swift 6.
    private static func dayOnly(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }
}
