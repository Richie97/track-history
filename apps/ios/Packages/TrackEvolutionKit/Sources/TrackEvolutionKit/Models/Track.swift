import Foundation

/// A track in the user's logbook, with per-track aggregates. `tracksSummary` in
/// `src/db.ts` is the canonical shape.
///
/// Tracks are per-user, but the name carries the layout — "Virginia
/// International Raceway (Full)" vs "(Patriot)" — so bests and goals never mix
/// across layouts. `catalogId` links to the seeded canonical catalog.
public struct Track: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var name: String
    /// Target lap time the user is chasing here.
    public var goalMs: Int?
    public var notes: String?
    public var catalogId: Int?
    public var updatedAt: Int
    /// Past events only — `tracksSummary` filters `start_date <= today`.
    public var eventCount: Int
    public var trackDays: Int
    public var bestMs: Int?
    /// Start date of the most recent past event; nil when there are none.
    public var lastDate: String?
    /// Chronological best-per-event series for the sparkline.
    public var series: [TrackSeriesPoint]

    public enum CodingKeys: String, CodingKey {
        case id, name, notes, series
        case goalMs = "goal_ms"
        case catalogId = "catalog_id"
        case updatedAt = "updated_at"
        case eventCount = "event_count"
        case trackDays = "track_days"
        case bestMs = "best_ms"
        case lastDate = "last_date"
    }
}

/// One point of a track's progress series. `bestMs` is never null — the server
/// filters events without a best out of the series.
public struct TrackSeriesPoint: Codable, Hashable, Sendable {
    public var date: String
    public var bestMs: Int

    public enum CodingKeys: String, CodingKey {
        case date
        case bestMs = "best_ms"
    }
}

/// An entry of the seeded canonical track catalog (`GET /api/catalog`), which
/// backs the track-name suggestions in the event form.
public struct CatalogTrack: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var name: String
}

/// The per-track community leaderboard (`GET /api/tracks/:id/leaderboard`):
/// opted-in users' best laps at the same catalog track. `catalogId` is nil for
/// a track the catalog doesn't know — no cross-user identity, so no
/// leaderboard. `optedIn` is the viewer's own flag, so the UI can offer the
/// opt-in without a second request.
public struct TrackLeaderboard: Codable, Hashable, Sendable {
    public var catalogId: Int?
    public var optedIn: Bool
    public var entries: [LeaderboardEntry]

    public enum CodingKeys: String, CodingKey {
        case entries
        case catalogId = "catalog_id"
        case optedIn = "opted_in"
    }
}

/// One leaderboard row. `you` marks the viewer's own entry.
public struct LeaderboardEntry: Codable, Hashable, Sendable {
    public var name: String?
    public var bestMs: Int
    public var date: String
    public var you: Bool

    public enum CodingKeys: String, CodingKey {
        case name, date, you
        case bestMs = "best_ms"
    }
}

/// One row of "setup vs. lap times" for a track (`GET /api/tracks/:id/setups`):
/// a day's setup sheet paired with what the car did that day.
public struct TrackSetupRow: Codable, Hashable, Sendable {
    public var eventId: Int
    public var startDate: String
    public var day: Int
    public var car: String?
    public var conditions: Conditions?
    public var tempF: Int?
    public var bestMs: Int?
    public var consistency: Double?
    public var data: SetupSheet

    public enum CodingKeys: String, CodingKey {
        case day, car, conditions, data, consistency
        case eventId = "event_id"
        case startDate = "start_date"
        case tempF = "temp_f"
        case bestMs = "best_ms"
    }
}
