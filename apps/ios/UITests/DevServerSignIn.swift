import CryptoKit
import XCTest

/// Getting a UI test to a signed-in app, against the local dev server.
///
/// Shared by every UI test that needs real data. The session comes from the
/// `DEV_MODE` bypass, and the test performs **the app's own PKCE exchange itself**
/// rather than driving the browser — see `devSessionToken()`:
///
///     npm run dev     # at the repo root, with .dev.vars
///
/// Tests probe for that server and **skip** when it isn't there, so a plain
/// `xcodebuild test` — and CI — stays green. (Probing beats an environment flag:
/// `xcodebuild` doesn't forward the shell environment to the test process, so a flag
/// would silently skip exactly when you meant to run it.)
extension XCTestCase {
    /// `http://localhost:8787` unless told otherwise. The override exists because
    /// `wrangler dev` picks the next free port when 8787 is taken, so a second
    /// checkout of this repo lands on 8788 — and without this its UI tests would
    /// silently write to the *other* checkout's logbook:
    ///
    ///     xcodebuild test … TEST_RUNNER_TE_DEV_SERVER=http://localhost:8788
    ///
    /// `xcodebuild` doesn't forward the shell environment to the test process, but
    /// it does forward variables prefixed `TEST_RUNNER_`, with the prefix stripped.
    static let devServerURL =
        ProcessInfo.processInfo.environment["TE_DEV_SERVER"] ?? "http://localhost:8787"

    /// Is `wrangler dev` up? Also confirms the bypass is enabled: without
    /// `DEV_MODE=1` in `.dev.vars` the flow would need a real Google password.
    func devServerIsRunning() -> Bool {
        var request = URLRequest(url: URL(string: "\(Self.devServerURL)/auth/providers")!)
        request.timeoutInterval = 3
        var ok = false
        let probe = expectation(description: "dev server probe")
        URLSession.shared.dataTask(with: request) { _, response, _ in
            ok = (response as? HTTPURLResponse)?.statusCode == 200
            probe.fulfill()
        }.resume()
        wait(for: [probe], timeout: 8)
        return ok
    }

    /// Bring an element into view, and say whether it got there.
    ///
    /// Two things this has to get right, each learned the hard way:
    ///
    /// - **Scroll the scroller, not the app.** `app.swipeUp()` swipes the application
    ///   element and reliably moves nothing on these screens; the gesture has to land
    ///   on the scroll container. A SwiftUI `List` is a collection view, a `ScrollView`
    ///   a scroll view.
    /// - **Wait for `isHittable`, not `exists`.** A `List` builds rows lazily, so an
    ///   off-screen row may not exist yet — but once it does exist it can still be
    ///   off-screen, and `tap()` on it fails. Hittable is the property that matters.
    @discardableResult
    func scrollTo(_ element: XCUIElement, in app: XCUIApplication, swipes: Int = 12) -> Bool {
        let scroller =
            app.collectionViews.firstMatch.exists
            ? app.collectionViews.firstMatch
            : (app.scrollViews.firstMatch.exists ? app.scrollViews.firstMatch : app)
        for _ in 0..<swipes {
            if element.exists && element.isHittable { return true }
            scroller.swipeUp(velocity: .fast)
        }
        return element.exists && element.isHittable
    }

    /// Launch, tap through the browser flow, and return the app on the dashboard.
    ///
    /// `tier` has no default on purpose. Every screen test runs against one shared
    /// dev logbook, and several of them depend on the account's tier — the lap
    /// overlay and the garage are gated server-side, the recorder's Start is gated
    /// on the client, and the Settings subscription row asserts the *free* state.
    /// A default would let a suite inherit whatever the last one left behind, which
    /// is how the database ends up deciding which tests pass; requiring it makes
    /// each suite say what it exercises. Set before launch, because the client
    /// caches the entitlement from `GET /api/me` at sign-in.
    ///
    /// `extraLaunchArguments` is for debug-only test hooks that have to be in place
    /// before the first screen draws — `-pendingRecording`, which seeds the unsaved
    /// recording the dashboard banner is about.
    func launchSignedIn(tier: DevTier, extraLaunchArguments: [String] = []) throws -> XCUIApplication {
        try XCTSkipUnless(devServerIsRunning(), "needs `npm run dev` on :8787")
        try setDevTier(tier)

        let token = try devSessionToken()

        let app = XCUIApplication()
        // UserDefaults reads launch arguments, so pointing the app at the dev server
        // needs no test hook. The dev bypass only answers on localhost.
        //
        // -resetAuth clears the Keychain token, which outlives an app reinstall in the
        // simulator: without it a test would pass by starting already signed in.
        // -resetRecording does the same for an unsaved recording, which would
        // otherwise put a banner on the dashboard that this run didn't create.
        // -authToken then seeds the session this test just minted.
        app.launchArguments = [
            "-server.url", Self.devServerURL, "-resetAuth", "-resetRecording", "-authToken", token
        ] + extraLaunchArguments
        app.launch()

        // The dashboard's own button, rather than anything about the account: this is
        // the assertion that the token actually loaded the logbook.
        XCTAssertTrue(
            app.buttons["+ Add event"].waitForExistence(timeout: 30),
            "the seeded token should land on the dashboard"
        )
        return app
    }

    /// A real session token for the dev user, obtained the way the app obtains one.
    ///
    /// The native flow is PKCE: `GET /auth/login?client=app&code_challenge=…` answers
    /// with a redirect to `trackevolution://auth?code=…`, and `POST /auth/exchange`
    /// trades that single-use code plus the verifier for a bearer token. Under
    /// `DEV_MODE` on a dev host the first step skips Google and signs in as the fixed
    /// dev user — so the whole exchange is two HTTP requests, and **the browser is
    /// the only part being skipped**. The token is as real as any other, the code is
    /// still single-use, and the PKCE check still runs against it.
    ///
    /// Why bother: `ASWebAuthenticationSession` is a system service these suites do
    /// not mean to exercise. On this machine it takes the app down with an XPC fault
    /// inside BoardServices before any assertion runs — reproducibly, and on `main`
    /// — which left every screen test unrunnable for a reason that has nothing to do
    /// with the screens. `SignInUITests` still drives the real browser flow, so that
    /// coverage moves here rather than disappearing.
    func devSessionToken() throws -> String {
        // 43 unreserved characters, which is the shortest a verifier may be.
        let verifier = String(
            (0..<43).map { _ in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~".randomElement()! }
        )
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()

        var login = URLComponents(string: "\(Self.devServerURL)/auth/login")!
        login.queryItems = [
            URLQueryItem(name: "client", value: "app"),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256")
        ]
        // Redirects are refused rather than followed: the target is the app's custom
        // scheme, which `URLSession` cannot fetch — the `Location` header *is* the
        // answer.
        let redirect = try request(URLRequest(url: login.url!), followRedirects: false)
        let location = try XCTUnwrap(
            (redirect.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Location"),
            "the dev bypass should redirect to the app with a code — is DEV_MODE=1 set?"
        )
        let code = try XCTUnwrap(
            URLComponents(string: location)?.queryItems?.first(where: { $0.name == "code" })?.value,
            "the redirect should carry a single-use code: \(location)"
        )

        var exchange = URLRequest(url: URL(string: "\(Self.devServerURL)/auth/exchange")!)
        exchange.httpMethod = "POST"
        exchange.setValue("application/json", forHTTPHeaderField: "Content-Type")
        exchange.httpBody = try JSONSerialization.data(
            withJSONObject: ["code": code, "code_verifier": verifier]
        )
        let exchanged = try request(exchange, followRedirects: true)
        let status = (exchanged.response as? HTTPURLResponse)?.statusCode ?? 0
        XCTAssertEqual(status, 200, "the code should exchange for a token")
        let body = try JSONSerialization.jsonObject(with: exchanged.data) as? [String: Any]
        return try XCTUnwrap(body?["token"] as? String, "the exchange should answer with a token")
    }

    /// One request, run to completion on the calling thread.
    private func request(
        _ request: URLRequest, followRedirects: Bool
    ) throws -> (data: Data, response: URLResponse?) {
        let session = followRedirects
            ? URLSession.shared
            : URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
        defer { if !followRedirects { session.finishTasksAndInvalidate() } }

        var result: (Data, URLResponse?)?
        var failure: Error?
        let done = expectation(description: "request")
        session.dataTask(with: request) { data, response, error in
            if let error { failure = error } else { result = (data ?? Data(), response) }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 20)
        if let failure { throw failure }
        return try XCTUnwrap(result, "the dev server should have answered")
    }

    /// Open an event with a chartable number of laps, from the dashboard, via its
    /// track page.
    ///
    /// The dashboard used to list recent events directly; it doesn't any more — the
    /// Tracks grid already carries recency, and the table under it was the same
    /// logbook said twice. So the route into a past event is one hop longer, and
    /// every test that needs one goes through here rather than repeating it.
    ///
    /// "Driven" means **three or more laps**, which is what the event page needs
    /// before it draws its pace chart and what these tests are all about. The track
    /// page's event cards carry a consistency figure, and `fmtConsistency` renders one
    /// only with 3+ laps — so a card whose label has a percentage in it is the
    /// predicate, read without opening anything or scrolling anywhere. The seed's
    /// newest track may have no such event, hence the walk across tracks.
    ///
    /// Returns false when the logbook has nothing driven in it, which is a skip
    /// condition rather than a failure.
    @discardableResult
    func openADrivenEvent(_ app: XCUIApplication) -> Bool {
        let tracks = app.buttons.matching(identifier: "trackCard")
        guard tracks.firstMatch.waitForExistence(timeout: 20) else { return false }
        // Snapshotted: once we navigate into a track the query matches nothing.
        let trackCount = tracks.count

        for index in 0..<trackCount {
            let track = tracks.element(boundBy: index)
            guard track.exists, track.isHittable else { continue }
            track.tap()

            let events = app.buttons.matching(identifier: "trackEventCard")
            if events.firstMatch.waitForExistence(timeout: 15) {
                if let driven = events.allElementsBoundByIndex.first(where: { $0.label.contains("%") }) {
                    driven.tap()
                    return app.staticTexts["Best time"].waitForExistence(timeout: 15)
                }
            }

            app.navigationBars.buttons.element(boundBy: 0).tap()
            _ = tracks.firstMatch.waitForExistence(timeout: 15)
        }
        return false
    }

    // MARK: - Talking to the dev server directly

    /// One dev-server call, signed in through the `DEV_MODE` bypass.
    ///
    /// Some fixtures can't be produced through the UI — a session with stored
    /// channels, an event a later screen has to already find — so the tests that
    /// need one seed it over HTTP and delete it again in `tearDown`.
    ///
    /// `URLSession.shared` keeps the session cookie, so `GET /auth/login` once per
    /// call is enough — it is a redirect on an already-authenticated session.
    @discardableResult
    func api(_ method: String, _ path: String, body: [String: Any]? = nil) throws -> [String: Any] {
        try signInOverHTTP()
        var request = URLRequest(url: URL(string: "\(Self.devServerURL)\(path)")!)
        request.httpMethod = method
        request.timeoutInterval = 15
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        var payload: [String: Any] = [:]
        var status = 0
        let done = expectation(description: "\(method) \(path)")
        URLSession.shared.dataTask(with: request) { data, response, _ in
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                payload = object
            }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 20)
        XCTAssertTrue((200..<300).contains(status), "\(method) \(path) failed: \(status) \(payload)")
        return payload
    }

    /// The tier a test exercises.
    ///
    /// Entitlement is server-owned by design, so no launch argument can fake it:
    /// `channels` is stripped and `GET /garage` is gated on the *server*. Every
    /// suite that depends on tier therefore says which one it wants, rather than
    /// inheriting whatever the shared dev logbook happens to hold — otherwise the
    /// database decides which tests pass, and the two expectations are mutually
    /// exclusive (the overlay and the garage need Pro; the Settings subscription
    /// row needs Free to reach the paywall).
    ///
    /// Backed by `POST /auth/dev/entitlement`, which answers only under DEV_MODE
    /// on a local dev host. Set it *before* launching the app: the client caches
    /// the entitlement from `GET /api/me` at sign-in.
    enum DevTier {
        case pro
        case free
    }

    func setDevTier(_ tier: DevTier) throws {
        try api("POST", "/auth/dev/entitlement", body: ["pro": tier == .pro])
    }

    func signInOverHTTP() throws {
        var request = URLRequest(url: URL(string: "\(Self.devServerURL)/auth/login")!)
        request.timeoutInterval = 10
        let done = expectation(description: "dev sign-in")
        URLSession.shared.dataTask(with: request) { _, _, _ in done.fulfill() }.resume()
        wait(for: [done], timeout: 15)
    }

    /// Kept on success as well as failure: a chart or a trackmap that renders wrong
    /// trips no assertion, so the screenshot is the only artifact that shows it.
    func attach(_ app: XCUIApplication, named name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}


/// Stops `URLSession` following the sign-in redirect, whose target is the app's
/// own URL scheme rather than something it could fetch.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

extension Data {
    /// base64url, unpadded — what PKCE's S256 challenge is encoded with.
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
