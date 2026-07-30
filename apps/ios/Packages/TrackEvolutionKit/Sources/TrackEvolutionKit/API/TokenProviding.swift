import Foundation

/// Source of the bearer token `APIClient` sends. Defined here, **implemented in
/// NS-08** — this layer must never reach into the Keychain itself.
public protocol TokenProviding: Sendable {
    /// The current token, or nil when signed out.
    func currentToken() async -> String?
}

/// Signed out: no `Authorization` header. The client's default, and what the
/// public share endpoint needs.
public struct NoToken: TokenProviding {
    public init() {}
    public func currentToken() async -> String? { nil }
}

/// A fixed token — for tests, previews, and the dev bypass.
public struct StaticToken: TokenProviding {
    public let token: String

    public init(_ token: String) {
        self.token = token
    }

    public func currentToken() async -> String? { token }
}
