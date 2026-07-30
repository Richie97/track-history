import AuthenticationServices
import Foundation
import UIKit
import OSLog
import TrackEvolutionKit

/// Sign-in, sign-out, and who's signed in.
///
/// The whole flow already exists server-side (`src/routes/auth.ts`) and this
/// changes none of it: generate a PKCE verifier, open
/// `/auth/login?client=app&code_challenge=…` **in the system browser** (Google
/// forbids OAuth in an embedded web view), catch the `trackevolution://auth?code=`
/// redirect, and trade the code for a bearer token within its 60-second life.
@MainActor
@Observable
final class AuthController {
    private static let log = Logger(subsystem: "app.trackevolution", category: "auth")

    enum State: Equatable {
        case unknown
        case signedOut
        case signingIn
        /// Signed in. `Me` is nil until the account loads — which it might not, if
        /// the app started offline; that is not the same as being signed out.
        case signedIn(Me?)
    }

    private(set) var state: State = .unknown
    /// Which buttons the sign-in screen should draw. Apple only when the server
    /// advertises it.
    private(set) var providers = AuthProviders(google: true, apple: false)
    /// Surfaced by the sign-in screen; a failed exchange must read as retryable,
    /// because it is — with a fresh code.
    var error: String?

    let api: APIClient
    let server: ServerSettings
    private let tokens: KeychainTokenStore
    private let webAuth: WebAuthenticating

    init(
        tokens: KeychainTokenStore = KeychainTokenStore(),
        server: ServerSettings = ServerSettings(),
        webAuth: WebAuthenticating? = nil
    ) {
        self.tokens = tokens
        self.server = server
        self.api = APIClient(baseURL: server.url, tokens: tokens)
        self.webAuth = webAuth ?? WebAuthSession()
    }

    // MARK: - Launch

    /// Decide what to show at launch, and refresh who's signed in.
    func restore() async {
        await refreshProviders()
        guard tokens.isSignedIn else {
            state = .signedOut
            return
        }
        do {
            state = .signedIn(try await api.me())
        } catch let error as APIError where error.isUnauthorized {
            // Expired or revoked server-side: drop to sign-in, don't retry.
            handleUnauthorized()
        } catch {
            // Offline at launch is not signed out — keep the token and carry on.
            Self.log.notice("could not refresh the account: \(error.localizedDescription, privacy: .public)")
            state = .signedIn(nil)
        }
    }

    func refreshProviders() async {
        if let advertised = try? await api.authProviders() {
            providers = advertised
        }
    }

    // MARK: - Sign in

    func signIn(with provider: AuthProvider) async {
        state = .signingIn
        error = nil
        let pkce = PKCE()
        guard let url = await api.signInURL(provider: provider, challenge: pkce.challenge) else {
            fail("That server URL isn't valid.")
            return
        }
        do {
            let callback = try await webAuth.authenticate(
                url: url,
                callbackScheme: TrackEvolutionKit.callbackScheme
            )
            try await complete(callback: callback, verifier: pkce.verifier)
        } catch is CancellationError {
            state = .signedOut
        } catch let authError as ASWebAuthenticationSessionError
            where authError.code == .canceledLogin {
            state = .signedOut
        } catch let apiError as APIError {
            // The code is burned on first use, so there is nothing to retry with —
            // starting over is the recovery, and the message says so.
            fail("\(apiError.message) Try signing in again.")
        } catch {
            fail(error.localizedDescription)
        }
    }

    /// Finish a flow from the `trackevolution://auth?code=…` redirect.
    private func complete(callback: URL, verifier: String) async throws {
        guard let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "code" })?.value
        else {
            throw APIError.server(status: 400, message: "The sign-in redirect carried no code.")
        }
        let token = try await api.exchange(code: code, verifier: verifier)
        tokens.save(token)
        state = .signedIn(try await api.me())
        Self.log.notice("signed in")
    }

    // MARK: - Sign out

    /// Revoke server-side, then clear the token. Cached logbook data goes too, once
    /// NS-21 has a cache — a shared device must not keep the previous user's
    /// history.
    func signOut() async {
        try? await api.logout()
        tokens.clear()
        state = .signedOut
    }

    /// A 401 from anywhere means the session is gone. Clear and show sign-in; never
    /// silently retry.
    func handleUnauthorized() {
        tokens.clear()
        state = .signedOut
    }

    // MARK: - Server override

    /// Point the app at another instance — `wrangler dev`, or a self-hosted deploy.
    func useServer(_ url: URL) async {
        server.url = url
        await api.setServerURL(url)
        tokens.clear()
        state = .signedOut
        await refreshProviders()
    }

    private func fail(_ message: String) {
        error = message
        state = .signedOut
    }
}

/// The web sign-in step, behind a protocol so the controller is testable without a
/// browser.
@MainActor
protocol WebAuthenticating {
    func authenticate(url: URL, callbackScheme: String) async throws -> URL
}

/// `ASWebAuthenticationSession`: the system browser, sharing Safari's cookies.
///
/// `prefersEphemeralWebBrowserSession` stays **false** on purpose — reusing an
/// existing Google session is the difference between a two-tap sign-in and
/// retyping a password.
@MainActor
final class WebAuthSession: NSObject, WebAuthenticating {
    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url, callbackURLScheme: callbackScheme
            ) { callback, error in
                if let callback {
                    continuation.resume(returning: callback)
                } else {
                    continuation.resume(throwing: error ?? CancellationError())
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            session.start()
        }
    }
}

extension WebAuthSession: ASWebAuthenticationPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive }
            return scene?.keyWindow ?? ASPresentationAnchor()
        }
    }
}

/// Which server the app talks to, persisted. The Capacitor shell had a
/// server-settings panel for pointing at `wrangler dev`; this is its equivalent.
///
/// Note the server's `DEV_MODE` bypass only answers on `localhost`, `127.0.0.1`,
/// `[::1]` and `10.0.2.2` — a real device on the LAN reaches the dev server but
/// still has to use real OAuth.
@Observable
final class ServerSettings {
    static let storageKey = "server.url"

    private let defaults: UserDefaults

    var url: URL {
        didSet { defaults.set(url.absoluteString, forKey: Self.storageKey) }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        url = defaults.string(forKey: Self.storageKey).flatMap(URL.init(string:))
            ?? TrackEvolutionKit.defaultBaseURL
    }

    var isDefault: Bool { url == TrackEvolutionKit.defaultBaseURL }
}
