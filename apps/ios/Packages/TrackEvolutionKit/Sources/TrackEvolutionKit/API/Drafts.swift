import Foundation

/// A field in an update request, with three states rather than two.
///
/// The server updates only the columns *present* in the body (`if (col in body)`
/// in `src/routes/events.ts`), so "leave it alone" and "clear it" are different
/// requests. A plain `String?` can't say both — this can: `.unchanged` omits the
/// key, `.set(nil)` sends an explicit null.
public enum Patch<Value: Codable & Hashable & Sendable>: Hashable, Sendable {
    case unchanged
    /// Write this value. `.set(nil)` clears the field.
    case set(Value?)
}

extension KeyedEncodingContainer {
    /// Encode a `Patch`: nothing for `.unchanged`, the value (or an explicit
    /// null) for `.set`.
    mutating func encode<Value>(_ patch: Patch<Value>, forKey key: Key) throws {
        if case .set(let value) = patch {
            try encode(value, forKey: key)
        }
    }
}

/// `POST /api/events`. `startDate` is the only required field; the track is
/// resolved by `trackName` (find-or-create, case-insensitive) or by `trackId`.
public struct EventDraft: Encodable, Hashable, Sendable {
    public var startDate: String
    public var trackName: String?
    public var trackId: Int?
    /// Fractional — the column is `days REAL`. See `Event.days`.
    public var days: Double?
    public var club: String?
    public var runGroup: String?
    public var car: String?
    public var notes: String?
    public var conditions: Conditions?
    public var tempF: Int?
    public var checklist: [ChecklistItem]?
    public var bestTimeMs: Int?
    public var trackHours: Double?

    public enum CodingKeys: String, CodingKey {
        case days, club, car, notes, conditions, checklist
        case startDate = "start_date"
        case trackName = "track_name"
        case trackId = "track_id"
        case runGroup = "run_group"
        case tempF = "temp_f"
        case bestTimeMs = "best_time_ms"
        case trackHours = "track_hours"
    }

    public init(startDate: String, trackName: String? = nil, trackId: Int? = nil) {
        self.startDate = startDate
        self.trackName = trackName
        self.trackId = trackId
    }
}

/// `PUT /api/events/:id`. Every field defaults to `.unchanged`, so an edit sends
/// only what the user actually touched.
public struct EventPatch: Encodable, Hashable, Sendable {
    public var trackName: Patch<String> = .unchanged
    public var trackId: Patch<Int> = .unchanged
    public var startDate: Patch<String> = .unchanged
    public var days: Patch<Double> = .unchanged
    public var club: Patch<String> = .unchanged
    public var runGroup: Patch<String> = .unchanged
    public var car: Patch<String> = .unchanged
    public var notes: Patch<String> = .unchanged
    public var conditions: Patch<Conditions> = .unchanged
    public var tempF: Patch<Int> = .unchanged
    public var checklist: Patch<[ChecklistItem]> = .unchanged
    public var bestTimeMs: Patch<Int> = .unchanged
    public var trackHours: Patch<Double> = .unchanged

    public enum CodingKeys: String, CodingKey {
        case days, club, car, notes, conditions, checklist
        case trackName = "track_name"
        case trackId = "track_id"
        case startDate = "start_date"
        case runGroup = "run_group"
        case tempF = "temp_f"
        case bestTimeMs = "best_time_ms"
        case trackHours = "track_hours"
    }

    public init() {}

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(trackName, forKey: .trackName)
        try c.encode(trackId, forKey: .trackId)
        try c.encode(startDate, forKey: .startDate)
        try c.encode(days, forKey: .days)
        try c.encode(club, forKey: .club)
        try c.encode(runGroup, forKey: .runGroup)
        try c.encode(car, forKey: .car)
        try c.encode(notes, forKey: .notes)
        try c.encode(conditions, forKey: .conditions)
        try c.encode(tempF, forKey: .tempF)
        try c.encode(checklist, forKey: .checklist)
        try c.encode(bestTimeMs, forKey: .bestTimeMs)
        try c.encode(trackHours, forKey: .trackHours)
    }
}

/// `POST /api/events/:id/sessions` — a session and, optionally, its laps in one
/// request. This is what the lap recorder saves (NS-17).
public struct SessionDraft: Encodable, Hashable, Sendable {
    public var label: String?
    public var notes: String?
    /// Lap times in integer milliseconds.
    public var laps: [Int]?
    /// Best-lap GPS trace in local metres.
    public var trace: [TracePoint]?
    /// Per-lap channel data. Written by the web importer only.
    public var channels: SessionChannels?

    public init(
        label: String? = nil,
        notes: String? = nil,
        laps: [Int]? = nil,
        trace: [TracePoint]? = nil,
        channels: SessionChannels? = nil
    ) {
        self.label = label
        self.notes = notes
        self.laps = laps
        self.trace = trace
        self.channels = channels
    }
}

/// `PUT /api/sessions/:id`. Both columns are written unconditionally by the
/// server, so nil really does clear them here.
public struct SessionPatch: Encodable, Hashable, Sendable {
    public var label: String?
    public var notes: String?

    public init(label: String? = nil, notes: String? = nil) {
        self.label = label
        self.notes = notes
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        // Explicit nulls: `UPDATE sessions SET label = ?, notes = ?` writes both.
        try c.encode(label, forKey: .label)
        try c.encode(notes, forKey: .notes)
    }

    public enum CodingKeys: String, CodingKey {
        case label, notes
    }
}

/// `PUT /api/tracks/:id` — rename, set a goal time, or edit notes.
public struct TrackPatch: Encodable, Hashable, Sendable {
    /// Deliberately *not* a `Patch`: the server trims the name unconditionally
    /// when the key is present, so a null would fault. nil omits it.
    public var name: String?
    public var goalMs: Patch<Int> = .unchanged
    public var notes: Patch<String> = .unchanged

    public enum CodingKeys: String, CodingKey {
        case name, notes
        case goalMs = "goal_ms"
    }

    public init(name: String? = nil) {
        self.name = name
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encode(goalMs, forKey: .goalMs)
        try c.encode(notes, forKey: .notes)
    }
}
