import Foundation

/// `GET /api/share/:slug` — the **unauthenticated** public share page.
///
/// Deliberately a separate type rather than an optional-riddled variant of the
/// authed models: the server strips notes, email, per-lap data, checklists and
/// all garage/setup linkage (`src/routes/share.ts`). Modelling it separately is
/// what makes "did we leak a private field into the public payload?" a decode
/// failure rather than a silent nil.
public struct ShareData: Codable, Hashable, Sendable {
    /// Display name of the logbook's owner.
    public var name: String?
    public var totals: Totals
    public var events: [SharedEvent]
    public var tracks: [SharedTrack]
}

/// An event as seen by the public: stats and times, no notes, no checklist, no
/// vehicle linkage.
public struct SharedEvent: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var trackId: Int
    public var trackName: String
    public var startDate: String
    /// Fractional, like `Event.days` — see the note there.
    public var days: Double
    public var club: String?
    public var runGroup: String?
    public var car: String?
    public var conditions: Conditions?
    public var tempF: Int?
    public var bestTimeMs: Int?
    public var updatedAt: Int
    public var lapBestMs: Int?
    public var lapCount: Int
    public var sessionCount: Int
    public var bestMs: Int?
    public var consistency: Double?
    public var hours: Double

    public enum CodingKeys: String, CodingKey {
        case id, days, club, car, conditions, consistency, hours
        case trackId = "track_id"
        case trackName = "track_name"
        case startDate = "start_date"
        case runGroup = "run_group"
        case tempF = "temp_f"
        case bestTimeMs = "best_time_ms"
        case updatedAt = "updated_at"
        case lapBestMs = "lap_best_ms"
        case lapCount = "lap_count"
        case sessionCount = "session_count"
        case bestMs = "best_ms"
    }
}

/// A track as seen by the public: aggregates and the progress series, no notes.
public struct SharedTrack: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var name: String
    public var goalMs: Int?
    public var catalogId: Int?
    public var updatedAt: Int
    public var eventCount: Int
    public var trackDays: Int
    public var bestMs: Int?
    public var lastDate: String?
    public var series: [TrackSeriesPoint]

    public enum CodingKeys: String, CodingKey {
        case id, name, series
        case goalMs = "goal_ms"
        case catalogId = "catalog_id"
        case updatedAt = "updated_at"
        case eventCount = "event_count"
        case trackDays = "track_days"
        case bestMs = "best_ms"
        case lastDate = "last_date"
    }
}

/// `PUT /api/share` — the slug the server settled on.
public struct ShareSlug: Codable, Hashable, Sendable {
    public var slug: String
}
