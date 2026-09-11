import XCTest

/// Event, session and lap CRUD **with the server gone** — NS-25's acceptance
/// criterion, and the whole reason the offline layer exists. A paddock has no usable
/// signal, and the app is used *there*.
///
/// The server is stopped mid-test by making it unreachable: the app is relaunched
/// pointed at a dead port, which is what a lost connection looks like to
/// `URLSession`. The cache was already warmed on the previous launch (the dashboard
/// prefetches every event detail), so the logbook still reads.
///
/// What this proves that `OfflineStoreTests` can't: that the *screens* show a queued
/// write immediately, that the sync banner says so, and that navigating around
/// doesn't lose it.
///
/// Needs `npm run dev` for the first, online launch; skips otherwise.
final class OfflineWritesUITests: XCTestCase {
    /// A port nothing is listening on. Not `localhost:8787` with the server stopped,
    /// because stopping it would break the sign-in this test needs first.
    private static let deadServer = "http://localhost:8799"

    override func setUp() {
        continueAfterFailure = false
    }

    func testAnEventLoggedOfflineIsVisibleAndQueued() throws {
        // Online first: sign in, and let the dashboard warm the cache.
        let app = try launchSignedIn(tier: .free)
        XCTAssertTrue(app.buttons["trackCard"].firstMatch.waitForExistence(timeout: 20))
        // The warm-up runs after first paint; give it a moment to pull event details.
        let warmed = expectation(description: "cache warms")
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { warmed.fulfill() }
        wait(for: [warmed], timeout: 15)

        // Now the paddock: same Keychain token, no reachable server.
        app.terminate()
        app.launchArguments = ["-server.url", Self.deadServer, "-resetRecording"]
        app.launch()

        // The cached logbook still reads. This is the part that makes the app usable
        // at a track at all.
        XCTAssertTrue(
            app.buttons["trackCard"].firstMatch.waitForExistence(timeout: 30),
            "the cached logbook should still render with no server"
        )

        // Create an event offline. It gets a negative temp id and is patched into the
        // cached responses, so it has to appear straight away.
        app.buttons["+ Add event"].tap()
        let trackField = app.textFields["Virginia International Raceway (Full)"]
        XCTAssertTrue(trackField.waitForExistence(timeout: 15))
        trackField.tap()
        trackField.typeText("Paddock Offline Test")
        app.buttons["Create event"].tap()

        XCTAssertTrue(
            app.staticTexts["Best time"].waitForExistence(timeout: 20),
            "an event created offline should open like any other"
        )

        // And a session with laps on top of it — a write against a row the server has
        // never seen, which is the case that needs temp-id substitution on replay.
        let manual = app.buttons["manualEntry"]
        XCTAssertTrue(scrollTo(manual, in: app), "the Add a session card should offer hand entry")
        manual.tap()
        let label = app.textFields["Day 1 — Session 2"]
        XCTAssertTrue(label.waitForExistence(timeout: 15))
        label.tap()
        label.typeText("Offline session")
        let laps = app.textFields["2:03.55, 2:01.24, 2:02.61"]
        laps.tap()
        laps.typeText("2:05.0, 2:03.0")
        app.buttons["Add session"].tap()

        XCTAssertTrue(
            app.staticTexts["Lap 1"].waitForExistence(timeout: 20),
            "laps logged offline should be on screen immediately, not after a sync"
        )
        XCTAssertTrue(app.staticTexts["Lap 2"].exists)

        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "offline-event-with-queued-laps"
        shot.lifetime = .keepAlways
        add(shot)

        // The sync banner has to say the writes are waiting. An app that silently
        // holds unsent changes is the failure this prevents.
        XCTAssertTrue(
            app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS 'Offline' OR label CONTAINS 'sync'")
            ).firstMatch.waitForExistence(timeout: 20),
            "the sync banner should report the queued writes"
        )

        // Leaving and coming back must not lose any of it: the queue and its cache
        // patch commit in one transaction, so both survive a relaunch.
        //
        // What a *screen* can check here is the queue, via the banner. The cached
        // patch has no dashboard surface any more — the front page lists tracks, and
        // a track invented offline isn't in the cached `/tracks` — so the patch's own
        // survival is asserted one level down, by `OfflineStoreTests`'
        // `aQueueSurvivesTheProcessThatMadeIt`.
        app.terminate()
        app.launch()
        XCTAssertTrue(
            app.buttons["+ Add event"].waitForExistence(timeout: 30),
            "the app should come back up offline"
        )
        XCTAssertTrue(
            app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS 'Offline' OR label CONTAINS 'sync'")
            ).firstMatch.waitForExistence(timeout: 20),
            "the writes queued offline should still be waiting after a relaunch"
        )
    }
}
