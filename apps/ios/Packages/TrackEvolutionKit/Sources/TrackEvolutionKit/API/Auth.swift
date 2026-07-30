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
