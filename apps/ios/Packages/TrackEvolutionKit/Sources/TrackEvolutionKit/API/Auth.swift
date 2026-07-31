import Foundation

/// Which sign-in providers a server offers (`GET /auth/providers`).
///
/// Apple is only advertised when that deployment carries the `APPLE_*` secrets,
/// so the button is driven by this and never hardcoded visible.
public struct AuthProviders: Codable, Hashable, Sendable {
    public var google: Bool
    public var apple: Bool

    public init(google: Bool, apple: Bool) {
        self.google = google
        self.apple = apple
    }
}

/// What each server last advertised, remembered across launches.
///
/// `GET /auth/providers` is unauthenticated and cheap, but it can still fail — a
/// phone cold-starting without signal, a sign-out in the paddock — and the app
/// asks for it exactly where a wrong answer is unrecoverable: no Apple button
/// locks out anyone whose account is an Apple one, with relaunching the app the
/// only way back. Remembering the last answer makes a failed fetch a no-op
/// instead of a silent downgrade to Google-only.
///
/// It only ever *stores* what a server advertised and never invents a provider,
/// so a self-hosted instance without the `APPLE_*` secrets still draws Google
/// alone. Keyed by server, because this is a property of the deployment:
/// pointing a dev build at `wrangler dev` and back must not carry one server's
/// answer over to the other.
/// Not `Sendable`: `UserDefaults` isn't marked as such, and this is only ever
/// touched from the main actor (`AuthController`).
public struct AuthProvidersStore {
    /// Google is always on (`src/routes/auth.ts`); Apple has to be earned.
    public static let fallback = AuthProviders(google: true, apple: false)

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public static func key(for server: URL) -> String {
        "auth.providers.\(server.absoluteString)"
    }

    /// What this server said last time, or the Google-only fallback.
    public func providers(for server: URL) -> AuthProviders {
        guard let data = defaults.data(forKey: Self.key(for: server)),
              let stored = try? JSONDecoder().decode(AuthProviders.self, from: data)
        else {
            return Self.fallback
        }
        return stored
    }

    public func save(_ providers: AuthProviders, for server: URL) {
        guard let encoded = try? JSONEncoder().encode(providers) else { return }
        defaults.set(encoded, forKey: Self.key(for: server))
    }
}

/// The identity providers the app can start a flow with.
public enum AuthProvider: String, CaseIterable, Sendable {
    case google
    case apple

    /// The login path to open in the system browser.
    var loginPath: String {
        switch self {
        case .google: "/auth/login"
        case .apple: "/auth/apple/login"
        }
    }
}

/// `POST /auth/exchange` — the bearer token.
struct AuthTokenResponse: Codable, Hashable, Sendable {
    var token: String
}

extension APIClient {
    /// The sign-in URL to open **in the system browser**. Google forbids OAuth in
    /// an embedded web view, which is why this flow exists at all.
    public func signInURL(provider: AuthProvider, challenge: String) -> URL? {
        guard var components = URLComponents(string: serverURL.absoluteString + provider.loginPath) else {
            return nil
        }
        components.queryItems = [
            URLQueryItem(name: "client", value: "app"),
            URLQueryItem(name: "code_challenge", value: challenge)
        ]
        return components.url
    }

    /// Which providers this server advertises. Unauthenticated.
    public func authProviders() async throws -> AuthProviders {
        try await authGet("/providers", as: AuthProviders.self)
    }

    /// Trade the one-time code from the `trackevolution://auth` redirect, plus the
    /// PKCE verifier, for a bearer token. Do this immediately: the code expires in
    /// 60 seconds and is burned on first use.
    public func exchange(code: String, verifier: String) async throws -> String {
        try await authPost(
            "/exchange",
            body: ExchangeBody(code: code, code_verifier: verifier),
            as: AuthTokenResponse.self
        ).token
    }

    /// Revoke the session server-side. The caller still has to clear the token and
    /// any cached data locally.
    public func logout() async throws {
        _ = try await authPost("/logout", body: EmptyBody(), as: OKResponse.self)
    }

    private struct ExchangeBody: Encodable {
        // Snake case on purpose: this is the server's field name.
        var code: String
        var code_verifier: String
    }

    private struct EmptyBody: Encodable {}
}
