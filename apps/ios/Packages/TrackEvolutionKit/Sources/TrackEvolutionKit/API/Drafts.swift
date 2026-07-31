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

// MARK: - Garage

/// `POST /api/vehicles`. The first vehicle in an empty garage becomes the
/// default whatever this says, so `isDefault` is only worth sending to promote a
/// later one.
public struct VehicleDraft: Encodable, Hashable, Sendable {
    public var name: String
    public var notes: String?
    public var isDefault: Bool?

    public enum CodingKeys: String, CodingKey {
        case name, notes
        case isDefault = "is_default"
    }

    public init(name: String, notes: String? = nil, isDefault: Bool? = nil) {
        self.name = name
        self.notes = notes
        self.isDefault = isDefault
    }
}

/// `PUT /api/vehicles/:id`. The server updates only the keys present and rejects
/// a body with none of them, so every field is a `Patch`.
///
/// Setting `isDefault` to true clears the flag on every other vehicle server-side
/// — there is no "unset the default" request, only "make this one it".
public struct VehiclePatch: Encodable, Hashable, Sendable {
    /// Not nullable server-side: `.set(nil)` would fault with "name required".
    public var name: Patch<String> = .unchanged
    public var notes: Patch<String> = .unchanged
    public var isDefault: Patch<Bool> = .unchanged

    public enum CodingKeys: String, CodingKey {
        case name, notes
        case isDefault = "is_default"
    }

    public init() {}

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(notes, forKey: .notes)
        try c.encode(isDefault, forKey: .isDefault)
    }
}

/// `POST /api/vehicles/:id/parts` — fit a consumable.
///
/// Leaving `expectedHours` nil is the useful default rather than a gap: the
/// server fills it from the mean accrued life of this vehicle's retired parts of
/// the same kind, so the second set of pads calibrates itself.
public struct PartDraft: Encodable, Hashable, Sendable {
    public var kind: PartKind
    public var name: String
    public var installedOn: String
    public var costCents: Int?
    public var expectedHours: Double?
    public var wearLimit: Double?
    public var notes: String?

    public enum CodingKeys: String, CodingKey {
        case kind, name, notes
        case installedOn = "installed_on"
        case costCents = "cost_cents"
        case expectedHours = "expected_hours"
        case wearLimit = "wear_limit"
    }

    public init(kind: PartKind, name: String, installedOn: String) {
        self.kind = kind
        self.name = name
        self.installedOn = installedOn
    }
}

/// `PUT /api/parts/:id`. Present keys only, like `VehiclePatch` — and here the
/// distinction earns its keep: `retiredOn` as `.set(nil)` un-retires a part,
/// while `.unchanged` leaves it retired.
public struct PartPatch: Encodable, Hashable, Sendable {
    public var kind: Patch<PartKind> = .unchanged
    /// Not nullable server-side — see `VehiclePatch.name`.
    public var name: Patch<String> = .unchanged
    public var installedOn: Patch<String> = .unchanged
    /// `.set(nil)` puts a retired part back in service.
    public var retiredOn: Patch<String> = .unchanged
    public var costCents: Patch<Int> = .unchanged
    public var expectedHours: Patch<Double> = .unchanged
    public var wearLimit: Patch<Double> = .unchanged
    public var notes: Patch<String> = .unchanged

    public enum CodingKeys: String, CodingKey {
        case kind, name, notes
        case installedOn = "installed_on"
        case retiredOn = "retired_on"
        case costCents = "cost_cents"
        case expectedHours = "expected_hours"
        case wearLimit = "wear_limit"
    }

    public init() {}

    /// Retire a part as of a date — the one-field edit the garage page makes most.
    public static func retiring(on date: String) -> PartPatch {
        var patch = PartPatch()
        patch.retiredOn = .set(date)
        return patch
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        try c.encode(name, forKey: .name)
        try c.encode(installedOn, forKey: .installedOn)
        try c.encode(retiredOn, forKey: .retiredOn)
        try c.encode(costCents, forKey: .costCents)
        try c.encode(expectedHours, forKey: .expectedHours)
        try c.encode(wearLimit, forKey: .wearLimit)
        try c.encode(notes, forKey: .notes)
    }
}

/// `POST /api/parts/:id/refresh` — "fresh set of the same part". Every field is
/// optional: the successor inherits the old part's spec, and the swap defaults to
/// today. Send `name`/`costCents` only when this set actually differs.
public struct PartRefreshDraft: Encodable, Hashable, Sendable {
    public var installedOn: String?
    public var name: String?
    public var costCents: Int?

    public enum CodingKeys: String, CodingKey {
        case name
        case installedOn = "installed_on"
        case costCents = "cost_cents"
    }

    public init(installedOn: String? = nil, name: String? = nil, costCents: Int? = nil) {
        self.installedOn = installedOn
        self.name = name
        self.costCents = costCents
    }
}

/// `POST /api/parts/:id/measurements` — a pad thickness or tread depth reading.
/// Two of these on one part unlock the measured wear projection.
public struct MeasurementDraft: Encodable, Hashable, Sendable {
    public var measuredOn: String
    public var value: Double
    /// Free text, truncated to 12 characters server-side; blank becomes "mm".
    public var unit: String

    public enum CodingKeys: String, CodingKey {
        case value, unit
        case measuredOn = "measured_on"
    }

    public init(measuredOn: String, value: Double, unit: String) {
        self.measuredOn = measuredOn
        self.value = value
        self.unit = unit
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
