import Foundation

/// `GET /api/me` — the signed-in user plus their headline totals.
public struct Me: Codable, Hashable, Sendable {
    public var user: User
    public var totals: Totals
}

public struct User: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var email: String
    public var name: String?
    /// Avatar URL from the identity provider.
    public var picture: String?
    /// The public share slug, when the user has claimed one.
    public var shareSlug: String?

    public enum CodingKeys: String, CodingKey {
        case id, email, name, picture
        case shareSlug = "share_slug"
    }
}

/// Headline counts shown on the dashboard and the public share page.
public struct Totals: Codable, Hashable, Sendable {
    public var events: Int
    public var trackDays: Int

    public enum CodingKeys: String, CodingKey {
        case events
        case trackDays = "track_days"
    }
}
