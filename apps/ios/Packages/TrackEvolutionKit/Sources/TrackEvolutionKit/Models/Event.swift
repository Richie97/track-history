import Foundation

/// One item of an event's prep checklist.
public struct ChecklistItem: Codable, Hashable, Sendable {
    public var text: String
    public var done: Bool

    public init(text: String, done: Bool) {
        self.text = text
        self.done = done
    }
}

/// Track conditions for an event. Mirrors `CONDITIONS` in `src/lib/validate.ts`.
///
/// Deliberately a `RawRepresentable` struct rather than a Swift `enum`: a value
/// the server adds later must not fail the decode of a whole event on an app
/// that predates it. Use `Conditions.all` to drive a picker.
public struct Conditions: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let dry = Conditions(rawValue: "dry")
    public static let damp = Conditions(rawValue: "damp")
    public static let wet = Conditions(rawValue: "wet")
    public static let mixed = Conditions(rawValue: "mixed")

    public static let all: [Conditions] = [.dry, .damp, .wet, .mixed]
}

/// A track day. The canonical shape is `ComputedEvent` in `src/lib/stats.ts`
/// (`EVENT_SELECT` in `src/db.ts` for the columns).
///
/// Optionality here is load-bearing and mirrors `withComputed`:
/// - `bestMs` is nil when the event has neither a manual best nor any laps.
/// - `consistency` is nil below 3 laps — **not** zero.
/// - `hours` is never nil; the server already rounded it to 1dp.
/// - `checklist` is nil when absent *or* malformed (`parseChecklist` degrades
///   rather than throwing).
/// `lap_avg`/`lap_avg_sq` are stripped by `withComputed` and so are absent here.
public struct Event: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var trackId: Int
    public var trackName: String
    /// ISO `yyyy-mm-dd`, the format every date column stores.
    public var startDate: String
    public var days: Int
    public var club: String?
    public var runGroup: String?
    public var car: String?
    public var vehicleId: Int?
    public var notes: String?
    public var conditions: Conditions?
    /// Ambient temperature in °F — a whole number (`isValidTemp`).
    public var tempF: Int?
    public var checklist: [ChecklistItem]?
    /// Manually entered best lap, independent of logged laps.
    public var bestTimeMs: Int?
    /// Manual override of the on-track hours estimate.
    public var trackHours: Double?
    public var updatedAt: Int
    public var lapBestMs: Int?
    public var lapCount: Int
    public var sessionCount: Int
    /// `min(bestTimeMs, lapBestMs)` — the number the UI shows as *the* best.
    public var bestMs: Int?
    /// Coefficient of variation of lap times; nil below 3 laps.
    public var consistency: Double?
    /// On-track hours: the override, else `max(days × 2h, logged lap time)`.
    public var hours: Double

    public enum CodingKeys: String, CodingKey {
        case id
        case trackId = "track_id"
        case trackName = "track_name"
        case startDate = "start_date"
        case days
        case club
        case runGroup = "run_group"
        case car
        case vehicleId = "vehicle_id"
        case notes
        case conditions
        case tempF = "temp_f"
        case checklist
        case bestTimeMs = "best_time_ms"
        case trackHours = "track_hours"
        case updatedAt = "updated_at"
        case lapBestMs = "lap_best_ms"
        case lapCount = "lap_count"
        case sessionCount = "session_count"
        case bestMs = "best_ms"
        case consistency
        case hours
    }
}

/// `GET /api/events/:id` — an event plus its sessions and per-day setup sheets.
///
/// The event fields are decoded by `Event` from the same container, so the two
/// can never drift apart.
public struct EventDetail: Codable, Hashable, Sendable, Identifiable {
    public var event: Event
    public var sessions: [Session]
    public var setups: [Setup]

    public var id: Int { event.id }

    public enum CodingKeys: String, CodingKey {
        case sessions, setups
    }

    public init(from decoder: any Decoder) throws {
        event = try Event(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessions = try c.decode([Session].self, forKey: .sessions)
        setups = try c.decode([Setup].self, forKey: .setups)
    }

    public func encode(to encoder: any Encoder) throws {
        try event.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(sessions, forKey: .sessions)
        try c.encode(setups, forKey: .setups)
    }
}
