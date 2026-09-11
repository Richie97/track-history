import Foundation

/// `entitlement` on `GET /api/me` — the server's answer to "is this account
/// Pro" (NS-32). The server owns it: the app never decides tier from a local
/// receipt, and offline the last fetched value stands.
public struct Entitlement: Codable, Hashable, Sendable {
    public enum Tier: String, Codable, Sendable {
        case free, pro
    }

    /// Where the entitlement came from: the store that sold it, `legacy` for the
    /// paid-app grant, or nil for an account that never had one. A lapsed
    /// subscriber keeps their source so "Manage" can still target the right store.
    public enum Source: String, Codable, Sendable {
        case legacy, apple, google
    }

    public var tier: Tier
    public var source: Source?
    /// Epoch ms. Nil for free and for legacy (which has no expiry).
    public var expiresAt: Int?
    /// Nil when unknown (free, legacy); false when the store says it won't renew.
    public var autoRenew: Bool?

    public init(tier: Tier, source: Source? = nil, expiresAt: Int? = nil, autoRenew: Bool? = nil) {
        self.tier = tier
        self.source = source
        self.expiresAt = expiresAt
        self.autoRenew = autoRenew
    }

    public enum CodingKeys: String, CodingKey {
        case tier, source
        case expiresAt = "expires_at"
        case autoRenew = "auto_renew"
    }

    /// What a signed-out or never-fetched client has: free.
    public static let free = Entitlement(tier: .free)
}

/// Every `POST /api/billing/*` answers with the fresh entitlement so the client
/// can update without a second round trip.
public struct BillingResponse: Codable, Hashable, Sendable {
    public var ok: Bool
    public var entitlement: Entitlement
}
