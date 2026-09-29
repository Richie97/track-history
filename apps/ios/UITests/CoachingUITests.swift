import XCTest

/// Share with a coach (NS-38), end to end against the local dev logbook.
///
/// Two halves, because the dev server has one account of its own:
///
/// - **The driver's half needs nothing more** than `npm run dev`: a Pro driver
///   mints an invite (link, Copy, share and QR), opens their own link and is told
///   it is theirs, and fills in their profile; a free account sees inviting locked.
/// - **The coach's half needs a second account**, which the `DEV_MODE` bypass
///   cannot sign in as — it only ever answers as `DEV_USER_EMAIL`. So it takes a
///   session token for one from `TE_COACH_TOKEN` (passed as
///   `TEST_RUNNER_TE_COACH_TOKEN=…` in xcodebuild's environment) and skips without
///   it. Minting one for the local D1 is two statements, run from the repo root:
///
///       TOKEN=uitest-coach-$(openssl rand -hex 16)
///       HASH=$(printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1)
///       npx wrangler d1 execute track-history --local --command \
///         "INSERT OR IGNORE INTO users (email, name) VALUES ('coach@example.test', 'Sam Coach');
///          INSERT INTO auth_sessions (token, user_id, expires_at)
///          SELECT '$HASH', id, 4102444800000 FROM users WHERE email = 'coach@example.test';"
///       echo $TOKEN
///
///   With it, the dev user is the student: Pro, with an imported session, and the
///   coach — free — accepts the invite through the accept screen and reads the
///   session's channel panel with the **Grip tab open and no upsell**, because the
///   student's tier is the one that counts.
///
/// Both halves delete what they create: the dev logbook is shared between suites.
final class CoachingUITests: XCTestCase {
    private static let track = "Coaching Test Circuit (UITest)"
    private static let coachToken = ProcessInfo.processInfo.environment["TE_COACH_TOKEN"]

    private var seededEventId: Int?
    private var originalProfile: Any?
    private var studentIdToLeave: Int?

    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        // Every invite the dev user still holds, however the test ended — an
        // unused one is only a row, but a pile of them is the next run's clutter.
        if devServerIsRunning(),
           let invites = (try? api("GET", "/api/coaching"))?["invites"] as? [[String: Any]] {
            for invite in invites {
                if let id = invite["id"] as? Int { _ = try? api("DELETE", "/api/coaching/invites/\(id)") }
            }
        }
        if let id = seededEventId {
            deleteEventBestEffort(id)
            seededEventId = nil
        }
        if let profile = originalProfile {
            _ = try? api("PUT", "/api/me/profile", body: ["profile": profile])
            originalProfile = nil
        }
        if let id = studentIdToLeave, let token = Self.coachToken {
            _ = try? bearer(token, "DELETE", "/api/coaching/students/\(id)", allowFailure: true)
            studentIdToLeave = nil
        }
    }

    // MARK: - The driver

    func testAProDriverInvitesACoachAndFillsInTheirProfile() throws {
        let app = try launchSignedIn(tier: .pro)
        originalProfile = try api("GET", "/api/me/profile")["profile"] ?? NSNull()
        // An empty form to type into; the driver's own profile goes back in tearDown.
        try api("PUT", "/api/me/profile", body: ["profile": NSNull()])
        openCoaching(app)

        // The link is shown once, with its three ways out of the app.
        let create = app.buttons["createInvite"]
        XCTAssertTrue(create.waitForExistence(timeout: 15), "a Pro driver can invite a coach")
        create.tap()
        let link = app.staticTexts["inviteURL"]
        XCTAssertTrue(link.waitForExistence(timeout: 15), "the new link is shown")
        XCTAssertTrue(link.label.contains("/coach/"), "and it is an invite link: \(link.label)")
        XCTAssertTrue(app.buttons["copyInvite"].exists, "with Copy")
        XCTAssertTrue(app.images["inviteQR"].exists, "and a QR code to scan in the paddock")
        attach(app, named: "coaching-invite")

        // Withdrawing is what an unused invite offers, and it tidies this test up.
        let withdraw = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'withdrawInvite-'")).firstMatch
        XCTAssertTrue(scrollTo(withdraw, in: app), "the open invite is listed")
        withdraw.tap()
        XCTAssertFalse(link.waitForExistence(timeout: 5) && link.isHittable, "a withdrawn link stops being shown")

        // The profile form, built from the shared field spec.
        let edit = app.buttons["editProfile"]
        XCTAssertTrue(scrollTo(edit, in: app))
        edit.tap()
        let occupation = app.textFields["profile-occupation"]
        XCTAssertTrue(occupation.waitForExistence(timeout: 15), "the form draws its first field")
        occupation.tap()
        occupation.typeText("Test pilot\n")
        let save = app.buttons["saveProfile"]
        XCTAssertTrue(scrollTo(save, in: app))
        save.tap()

        let card = app.descendants(matching: .any)["profileCard"]
        XCTAssertTrue(card.waitForExistence(timeout: 15), "back on Coaching, the profile card reads what was saved")
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Test pilot")).firstMatch.exists,
            "the card shows the new occupation"
        )
        attach(app, named: "coaching-profile")
    }

    func testOpeningYourOwnInviteSaysItIsYours() throws {
        try XCTSkipUnless(devServerIsRunning(), "needs `npm run dev` on :8787")
        try setDevTier(.pro)
        let invite = try api("POST", "/api/coaching/invites")
        let url = try XCTUnwrap(invite["url"] as? String)
        let inviteId = try XCTUnwrap(invite["id"] as? Int)
        defer { _ = try? api("DELETE", "/api/coaching/invites/\(inviteId)") }

        // Launched straight onto the link, so not through `launchSignedIn`, whose
        // check is that the app landed on the dashboard.
        let app = XCUIApplication()
        app.launchArguments = [
            "-server.url", Self.devServerURL, "-resetAuth", "-resetRecording", "-authToken", try devSessionToken(),
            "-openLink", url
        ]
        app.launch()
        XCTAssertTrue(
            app.staticTexts["inviteOwn"].waitForExistence(timeout: 20),
            "a driver opening their own link is told to send it on, not offered Accept"
        )
        XCTAssertFalse(app.buttons["acceptInvite"].exists)
        attach(app, named: "coaching-own-invite")
    }

    func testAFreeAccountSeesInvitingLocked() throws {
        let app = try launchSignedIn(tier: .free)
        openCoaching(app)
        XCTAssertTrue(
            app.buttons["proUpsell"].waitForExistence(timeout: 15),
            "inviting a coach is Pro, and a free account is offered it rather than refused"
        )
        XCTAssertFalse(app.buttons["createInvite"].exists)
        // The profile stays free: it is what a coach reads, whoever pays.
        XCTAssertTrue(scrollTo(app.buttons["editProfile"], in: app))
    }

    // MARK: - The coach

    func testAFreeCoachReadsAProStudentsFullChannelPanel() throws {
        try XCTSkipUnless(devServerIsRunning(), "needs `npm run dev` on :8787")
        let coachToken = try XCTUnwrap(
            Self.coachToken.flatMap { $0.isEmpty ? nil : $0 },
            "set TEST_RUNNER_TE_COACH_TOKEN — see the note at the top of this file"
        )

        // The student: the dev user, Pro, with an imported session to read.
        try setDevTier(.pro)
        seededEventId = try seedImportedSession(track: Self.track)
        let studentId = try XCTUnwrap(try api("GET", "/api/me/profile")["id"] as? Int)
        let invite = try api("POST", "/api/coaching/invites")
        let url = try XCTUnwrap(invite["url"] as? String)
        studentIdToLeave = studentId

        // The coach: free, which is the point — the student's tier decides.
        _ = try bearer(coachToken, "POST", "/auth/dev/entitlement", body: ["pro": false])

        let app = XCUIApplication()
        app.launchArguments = [
            "-server.url", Self.devServerURL, "-resetAuth", "-resetRecording", "-authToken", coachToken,
            "-openLink", url
        ]
        app.launch()

        let accept = app.buttons["acceptInvite"]
        XCTAssertTrue(accept.waitForExistence(timeout: 30), "the invite previews with an Accept button")
        attach(app, named: "coaching-accept")
        accept.tap()

        // The student's dashboard, with the banner saying whose it is.
        XCTAssertTrue(app.descendants(matching: .any)["studentBanner"].waitForExistence(timeout: 20))
        let card = app.buttons.matching(
            NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "trackCard", "Coaching Test")
        ).firstMatch
        XCTAssertTrue(scrollTo(card, in: app), "the student's tracks are listed")
        attach(app, named: "coaching-student-home")
        card.tap()

        let event = app.buttons["trackEventCard"].firstMatch
        XCTAssertTrue(event.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["Leaderboard"].exists, "a student's leaderboard is never a coach's to read")
        // The track page's own door, by its spoken label: at expanded width the
        // coach's own dashboard sits in the list pane with its "+ Add event".
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Add event at'")).firstMatch.exists)
        event.tap()

        XCTAssertTrue(app.staticTexts["Best time"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["eventMenu"].exists, "a student's event has no edit or delete")
        XCTAssertFalse(app.buttons["recordEntry"].exists, "and no way to add a session")
        let entry = app.buttons["channelGraphs"]
        XCTAssertTrue(scrollTo(entry, in: app), "the imported session offers its lap overlay")
        entry.tap()

        let grip = app.buttons["Grip"]
        XCTAssertTrue(grip.waitForExistence(timeout: 20), "the Pro student's lateral G reached a free coach")
        XCTAssertFalse(app.buttons["proUpsell"].exists, "and nothing on the panel is locked")
        grip.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["frictionCircle"].waitForExistence(timeout: 10),
            "the Grip tab is open: the friction circle draws"
        )
        attach(app, named: "coaching-student-grip")
        app.buttons["Done"].tap()
    }

    // MARK: - Helpers

    private func openCoaching(_ app: XCUIApplication) {
        app.buttons["Account"].tap()
        let open = app.buttons["openCoaching"]
        XCTAssertTrue(scrollTo(open, in: app), "Settings has a way into Coaching")
        open.tap()
        XCTAssertTrue(app.navigationBars["Coaching"].waitForExistence(timeout: 15))
    }

    /// One call as another account, by bearer token.
    @discardableResult
    private func bearer(
        _ token: String, _ method: String, _ path: String, body: [String: Any]? = nil, allowFailure: Bool = false
    ) throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "\(Self.devServerURL)\(path)")!)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        var payload: [String: Any] = [:]
        var status = 0
        let done = expectation(description: "\(method) \(path)")
        // Ephemeral, so the dev user's cookie in the shared session is not sent.
        URLSession(configuration: .ephemeral).dataTask(with: request) { data, response, _ in
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                payload = object
            }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 20)
        if !allowFailure {
            XCTAssertTrue((200..<300).contains(status), "\(method) \(path) as the coach failed: \(status) \(payload)")
        }
        return payload
    }
}
