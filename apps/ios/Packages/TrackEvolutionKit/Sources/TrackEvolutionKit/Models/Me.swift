import Foundation

/// `GET /api/me` — the signed-in user plus their headline totals.
public struct Me: Codable, Hashable, Sendable {
    public var user: User
    public var totals: Totals
    /// The account's tier (NS-32). Optional so a cached response from a server
    /// that predates subscriptions still decodes; absent reads as free.
    public var entitlement: Entitlement?
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
    /// Whether the user's *ranked lap itself* — its racing line and telemetry —
    /// is open to other drivers ranked at the same track (NS-35). A second,
    /// separate consent stacked on ``leaderboardOptIn``, never implied by it.
    /// Optional for the same reason: an older cached response has no such key.
    public var leaderboardShareLaps: Bool?
    /// The unit system the user sees the logbook in (`PUT /api/me/units`).
    /// Display-only: the server stores and returns the same numbers either way —
    /// temperatures whole °F, channel speeds km/h, setup pressures psi, fuel
    /// gallons. The server always answers one of the two; optional here only so a
    /// `/me` cached before the field existed still decodes, with nil read as
    /// `.imperial` (what the app always showed) via `effectiveUnits`.
    public var units: UnitSystem?

    public enum CodingKeys: String, CodingKey {
        case id, email, name, picture
        case shareSlug = "share_slug"
        case checklistTemplate = "checklist_template"
        case leaderboardOptIn = "leaderboard_opt_in"
        case leaderboardShareLaps = "leaderboard_share_laps"
        case units
    }

    public var effectiveUnits: UnitSystem { units ?? .imperial }

    /// The list "Use my list" actually uses.
    public var effectiveChecklistTemplate: [String] {
        checklistTemplate ?? EventDates.DEFAULT_CHECKLIST
    }
}

/// Mirrors `UNIT_SYSTEMS` in `src/lib/validate.ts` and `public/js/units.js`.
public enum UnitSystem: String, Codable, Hashable, Sendable, CaseIterable {
    case imperial
    case metric
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
