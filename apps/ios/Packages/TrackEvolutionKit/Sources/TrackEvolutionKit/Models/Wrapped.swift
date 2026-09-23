import Foundation

/// `GET /api/wrapped/:year` — Season Wrapped (NS-36): one calendar year's
/// numbers, past events only, computed on the server by `src/lib/wrapped.ts`.
///
/// **No screen reads this yet.** Wrapped is web-first; the model is here so the
/// golden contract decodes, and so a native Wrapped next November is this model
/// plus a screen — the computation is the server's, so there is nothing to port.
/// Every card is optional because the server skips a card with no data rather
/// than sending it empty.
public struct Wrapped: Codable, Hashable, Sendable {
    public var year: Int
    /// Every year with a past event, newest first — the picker.
    public var years: [Int]
    /// Today, ISO `YYYY-MM-DD`, while the year is running; nil once it has ended.
    public var through: String?
    public var name: String?
    public var totals: WrappedTotals
    public var mostDriven: WrappedMostDriven?
    public var improvement: WrappedImprovement?
    public var fastest: WrappedFastest?
    public var newTracks: [WrappedTrack]
    public var hottest: WrappedHottest?
    /// The one tier-dependent field: nil for a free account (the client draws
    /// the two Pro cards locked); for Pro, each card is nil when there is no data.
    /// Absent altogether from the public share (`GET /api/share/:slug/wrapped/:year`),
    /// which carries the free card set only and decodes into this same model.
    public var pro: WrappedPro?

    public enum CodingKeys: String, CodingKey {
        case year, years, through, name, totals, improvement, fastest, hottest, pro
        case mostDriven = "most_driven"
        case newTracks = "new_tracks"
    }
}

public struct WrappedTotals: Codable, Hashable, Sendable {
    public var events: Int
    /// Fractional, like `Event.days`.
    public var trackDays: Double
    public var tracks: Int
    public var laps: Int
    public var hours: Double
    public var miles: Double
    /// How many of `tracks` had a known lap length — "across N of M tracks".
    public var milesTracksCounted: Int

    public enum CodingKeys: String, CodingKey {
        case events, tracks, laps, hours, miles
        case trackDays = "track_days"
        case milesTracksCounted = "miles_tracks_counted"
    }
}

public struct WrappedTrack: Codable, Hashable, Sendable {
    public var trackId: Int
    public var trackName: String

    public enum CodingKeys: String, CodingKey {
        case trackId = "track_id"
        case trackName = "track_name"
    }
}

public struct WrappedMostDriven: Codable, Hashable, Sendable {
    public var trackId: Int
    public var trackName: String
    public var trackDays: Double
    public var laps: Int
    public var bestMs: Int?

    public enum CodingKeys: String, CodingKey {
        case laps
        case trackId = "track_id"
        case trackName = "track_name"
        case trackDays = "track_days"
        case bestMs = "best_ms"
    }
}

public struct WrappedImprovement: Codable, Hashable, Sendable {
    public var trackId: Int
    public var trackName: String
    public var bestBefore: Int
    public var bestThisYear: Int
    public var gainMs: Int
    /// `"prior_years"`, or `"first_event"` for a first year at the track.
    public var baseline: String

    public enum CodingKeys: String, CodingKey {
        case baseline
        case trackId = "track_id"
        case trackName = "track_name"
        case bestBefore = "best_before"
        case bestThisYear = "best_this_year"
        case gainMs = "gain_ms"
    }
}

public struct WrappedFastest: Codable, Hashable, Sendable {
    public var trackId: Int
    public var trackName: String
    public var bestMs: Int
    public var eventId: Int
    public var date: String

    public enum CodingKeys: String, CodingKey {
        case date
        case trackId = "track_id"
        case trackName = "track_name"
        case bestMs = "best_ms"
        case eventId = "event_id"
    }
}

public struct WrappedHottest: Codable, Hashable, Sendable {
    public var eventId: Int
    public var trackName: String
    public var date: String
    public var tempC: Double

    public enum CodingKeys: String, CodingKey {
        case date
        case eventId = "event_id"
        case trackName = "track_name"
        case tempC = "temp_c"
    }
}

public struct WrappedPro: Codable, Hashable, Sendable {
    public var tire: WrappedTire?
    public var topSpeed: WrappedTopSpeed?

    public enum CodingKeys: String, CodingKey {
        case tire
        case topSpeed = "top_speed"
    }
}

/// The tyre with the most track days on it this year (garage consumables).
public struct WrappedTire: Codable, Hashable, Sendable {
    public var partId: Int
    public var vehicleId: Int
    public var vehicleName: String
    public var name: String
    public var trackDays: Double
    public var hours: Double

    public enum CodingKeys: String, CodingKey {
        case name, hours
        case partId = "part_id"
        case vehicleId = "vehicle_id"
        case vehicleName = "vehicle_name"
        case trackDays = "track_days"
    }
}

/// The year's highest stored speed sample, km/h.
public struct WrappedTopSpeed: Codable, Hashable, Sendable {
    public var kph: Double
    public var trackId: Int
    public var trackName: String
    public var eventId: Int
    public var date: String

    public enum CodingKeys: String, CodingKey {
        case kph, date
        case trackId = "track_id"
        case trackName = "track_name"
        case eventId = "event_id"
    }
}
