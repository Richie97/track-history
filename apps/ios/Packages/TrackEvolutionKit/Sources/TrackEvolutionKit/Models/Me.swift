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
    /// The user's own prep-checklist template, or nil when they haven't made one
    /// and `EventDates.DEFAULT_CHECKLIST` applies. Strings, not `ChecklistItem`s:
    /// a template is what a checklist starts *from*, so it carries no done flags.
    public var checklistTemplate: [String]?
    /// Whether the user appears on per-track community leaderboards. Optional
    /// so a cached response from an older server still decodes; absent means
    /// false.
    public var leaderboardOptIn: Bool?

    public enum CodingKeys: String, CodingKey {
        case id, email, name, picture
        case shareSlug = "share_slug"
        case checklistTemplate = "checklist_template"
        case leaderboardOptIn = "leaderboard_opt_in"
    }

    /// The list "Use my list" actually uses.
    public var effectiveChecklistTemplate: [String] {
        checklistTemplate ?? EventDates.DEFAULT_CHECKLIST
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
