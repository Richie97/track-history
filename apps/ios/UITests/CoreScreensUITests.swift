import XCTest

/// The five screens of NS-25, walked against the local dev logbook.
///
/// These assert on **content and reachability**, not layout: that the dashboard shows
/// the logbook, that an event's sessions and laps render with their per-session stats,
/// that the form creates an event without mangling its track name, and that privacy
/// and terms are reachable from Settings — which is an acceptance criterion, not a
/// nicety, since the native app renders no footer to put them in.
///
/// Navigation goes by accessibility identifier rather than by card title: titles are
/// user data, so a test that taps a track name breaks when the seed data changes.
///
/// Two of these need the **example seed** (`npm run db:seed:local`) because they read
/// history no UI can create in a test: a past event's progress chart, and an upcoming
/// event for the hero slot. The rest create what they assert on and delete it again —
/// the dev logbook is shared between these tests, and an accumulating pile of
/// leftovers silently rewrites the dashboard's totals and which event is next.
///
/// Needs `npm run dev`; skips otherwise, so CI stays green. See `DevServerSignIn`.
final class CoreScreensUITests: XCTestCase {
    /// From `seed/data.example.mjs`. The parenthetical layout name is the part that
    /// matters — it has to survive a round trip through the app untouched.
    private static let seededTrack = "Virginia International Raceway (Full)"

    override func setUp() {
        continueAfterFailure = false
    }

    // MARK: - Dashboard

    func testDashboardShowsTheLogbook() throws {
        let app = try launchSignedIn()

        XCTAssertTrue(
            app.buttons["trackCard"].firstMatch.waitForExistence(timeout: 20),
            "the Tracks section should have a card per driven track"
        )
        attach(app, named: "dashboard")
        XCTAssertTrue(app.staticTexts["Track days"].exists, "the totals tiles should be there")
        XCTAssertTrue(app.buttons["recentEventCard"].firstMatch.exists, "with recent events under them")
        // Matched among any descendants: the hero is one combined accessibility
        // element, which SwiftUI doesn't necessarily publish as a button. Needs the
        // example seed, whose last event is in the future.
        XCTAssertTrue(
            app.descendants(matching: .any)["heroEvent"].exists,
            "an upcoming event gets the hero slot (needs the example seed)"
        )
        XCTAssertTrue(
            app.staticTexts[Self.seededTrack].firstMatch.exists,
            "a track name should render with its layout suffix intact"
        )

    }

    /// The dashboard's own way into the recorder: one tap from the front page to a
    /// live Start button, without going through an event first.
    ///
    /// Asserts reachability only, and deliberately stops at Start rather than pressing
    /// it — recording end to end needs a simulated drive, which is
    /// `RecordAndSaveUITests`' job. `-resetRecording` matters here: an unsaved
    /// recording left on disk by an earlier test puts the recorder in `.stopped`, and
    /// this button is idle-only, so the dashboard would legitimately not show it.
    func testDashboardStartsARecording() throws {
        let app = try launchSignedIn()

        let record = app.buttons["dashboardRecord"]
        XCTAssertTrue(
            record.waitForExistence(timeout: 20),
            "the dashboard should offer the recorder next to + Add event"
        )
        record.tap()

        XCTAssertTrue(
            app.buttons["Start recording"].waitForExistence(timeout: 10),
            "it should land on the record screen, ready to start"
        )
        attach(app, named: "dashboard-record")
    }

    // MARK: - Event: create, log laps, delete

    /// The event page's real content, on data this test owns: create the event, add a
    /// session with lap times, check what the page makes of them, delete it again.
    func testEventLogsLapsAndShowsTheirStats() throws {
        let app = try launchSignedIn()

        try createEvent(app, named: "Summit Point (Shenandoah)")

        // Add a session with laps. These four are chosen so every line of
        // `LapStats` has something to say: an out-lap outside the 107% cutoff, then a
        // clean improving run.
        let label = app.textFields["Day 1 — Session 2"]
        XCTAssertTrue(label.waitForExistence(timeout: 15), "the add-session form should be on the event page")
        label.tap()
        label.typeText("Session 1")

        let laps = app.textFields["2:03.55, 2:01.24, 2:02.61"]
        laps.tap()
        laps.typeText("2:20.0, 2:03.5, 2:02.0, 2:01.5, 2:01.2")

        app.buttons["Add session"].tap()

        // The laps, as rows — exact match, because "LAP TIMES" is a field label on
        // this same screen and a prefix match would pass without any laps at all.
        XCTAssertTrue(
            app.staticTexts["Lap 1"].waitForExistence(timeout: 20),
            "the saved session's laps should be listed"
        )
        XCTAssertTrue(app.staticTexts["Lap 5"].exists, "all five of them")
        // The ported `lap-stats.js` analysis, and the event's recomputed aggregates.
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'best 3 avg'")).firstMatch.exists,
            "the per-session stats line should report the best-3 average"
        )
        XCTAssertTrue(
            app.staticTexts["1:01.2"].exists || app.staticTexts["2:01.2"].exists,
            "the best lap should reach the Best time tile"
        )
        attach(app, named: "event")

        // NS-17's recorder. The event page is the door that attaches a recording to
        // *this* event; the dashboard's is the one for a session about to be driven.
        XCTAssertTrue(app.buttons["recordEntry"].exists)

        deleteCurrentEvent(app)
    }

    // MARK: - Track page

    func testTrackPageChartsProgressAndCarriesTheGoal() throws {
        let app = try launchSignedIn()

        let card = app.buttons["trackCard"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20))
        card.tap()

        XCTAssertTrue(
            app.staticTexts["Personal best"].waitForExistence(timeout: 15),
            "the track page leads with the personal best"
        )
        XCTAssertTrue(
            app.staticTexts["GOAL LAP"].exists || app.staticTexts["Goal lap"].exists,
            "the goal control should be on the page"
        )
        XCTAssertTrue(app.buttons["trackEventCard"].firstMatch.exists, "with the event history under it")
        attach(app, named: "track")
        // Deferred with the rest of the garage feature.
        XCTAssertFalse(app.staticTexts["Setup vs. lap times"].exists)
    }

    // MARK: - Settings

    /// Privacy and terms are required on every platform. The web app carries them in
    /// its footer and in Settings; a native app with no footer has only Settings.
    func testPrivacyAndTermsAreReachableFromSettings() throws {
        let app = try launchSignedIn()

        app.buttons["Account"].tap()

        XCTAssertTrue(
            app.staticTexts["Privacy policy"].waitForExistence(timeout: 15),
            "the privacy policy must be reachable from Settings"
        )
        XCTAssertTrue(app.staticTexts["Terms of use"].exists, "so must the terms of use")
        XCTAssertTrue(app.staticTexts["dev@example.com"].exists, "with the signed-in account")
        XCTAssertTrue(app.staticTexts["Vehicles"].exists, "the garage's vehicle list lives here")
        XCTAssertTrue(app.buttons["Sign out"].exists)

        // A year is an identifier, not a quantity. `Text` interpolation formats a bare
        // Int for the locale, which rendered the copyright as "© 2,026". Matched by
        // shape rather than against this year's number, so the test doesn't expire.
        XCTAssertTrue(
            app.staticTexts.containing(
                NSPredicate(format: "label MATCHES %@", "© [0-9]{4} Speedshift LLC")
            ).firstMatch.exists,
            "the copyright year must not be group-separated"
        )
        attach(app, named: "settings")
    }

    // MARK: - Helpers

    /// Create an event through the form and land on it.
    private func createEvent(_ app: XCUIApplication, named track: String) throws {
        app.buttons["+ Add event"].tap()

        let trackField = app.textFields[Self.seededTrack]
        XCTAssertTrue(trackField.waitForExistence(timeout: 15), "the form should offer the track field")
        trackField.tap()
        // A layout suffix and mixed case, typed exactly: the server matches names
        // case-insensitively, and normalizing here would merge two real layouts.
        trackField.typeText(track)

        app.buttons["Create event"].tap()

        XCTAssertTrue(
            app.staticTexts["Best time"].waitForExistence(timeout: 20),
            "creating an event should land on the event page"
        )
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", track)).firstMatch.exists,
            "the track name must arrive exactly as it was typed"
        )
    }

    /// Delete the event on screen. Also covers the event menu and its confirmation.
    private func deleteCurrentEvent(_ app: XCUIApplication) {
        app.buttons["eventMenu"].tap()
        app.buttons["Delete event"].tap()
        // Again, for the confirmation dialog's destructive button.
        app.buttons["Delete event"].tap()
        XCTAssertTrue(
            app.buttons["+ Add event"].waitForExistence(timeout: 20),
            "deleting an event should pop back to the dashboard"
        )
    }
}
