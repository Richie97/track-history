import Foundation

/// A garage vehicle (`GET /api/vehicles`). At most one row per user has
/// `isDefault` set; it pre-fills new events.
///
/// `is_default` is SQLite's 0/1 integer on the wire, decoded to `Bool` here.
public struct Vehicle: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var name: String
    public var notes: String?
    public var isDefault: Bool

    public enum CodingKeys: String, CodingKey {
        case id, name, notes
        case isDefault = "is_default"
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        isDefault = try c.decode(Int.self, forKey: .isDefault) != 0
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(notes, forKey: .notes)
        try c.encode(isDefault ? 1 : 0, forKey: .isDefault)
    }
}

/// A vehicle in the garage logbook (`GET /api/garage`): accrued hours plus its
/// consumable parts, each with measurements and a computed wear estimate.
///
/// The garage is a **deferred** feature on native (web only, see
/// `docs/specs/native/README.md`) — modelled so the response decodes and the
/// contract stays pinned, with no client methods yet.
public struct GarageVehicle: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var name: String
    public var notes: String?
    public var isDefault: Bool
    public var updatedAt: Int
    /// On-track hours accrued across the vehicle's events.
    public var hours: Double
    public var eventCount: Int
    public var eventDays: Int
    public var parts: [Part]

    public enum CodingKeys: String, CodingKey {
        case id, name, notes, hours, parts
        case isDefault = "is_default"
        case updatedAt = "updated_at"
        case eventCount = "event_count"
        case eventDays = "event_days"
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        isDefault = try c.decode(Int.self, forKey: .isDefault) != 0
        updatedAt = try c.decode(Int.self, forKey: .updatedAt)
        hours = try c.decode(Double.self, forKey: .hours)
        eventCount = try c.decode(Int.self, forKey: .eventCount)
        eventDays = try c.decode(Int.self, forKey: .eventDays)
        parts = try c.decode([Part].self, forKey: .parts)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(notes, forKey: .notes)
        try c.encode(isDefault ? 1 : 0, forKey: .isDefault)
        try c.encode(updatedAt, forKey: .updatedAt)
        try c.encode(hours, forKey: .hours)
        try c.encode(eventCount, forKey: .eventCount)
        try c.encode(eventDays, forKey: .eventDays)
        try c.encode(parts, forKey: .parts)
    }
}

/// What kind of consumable a part is. Mirrors `PART_KINDS` in
/// `src/lib/validate.ts`; a `RawRepresentable` struct rather than an `enum` for
/// the same reason as `Conditions` — a kind added server-side must not break
/// decoding on an older app.
public struct PartKind: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let padsFront = PartKind(rawValue: "pads_front")
    public static let padsRear = PartKind(rawValue: "pads_rear")
    public static let tires = PartKind(rawValue: "tires")
    public static let rotorsFront = PartKind(rawValue: "rotors_front")
    public static let rotorsRear = PartKind(rawValue: "rotors_rear")
    public static let brakeFluid = PartKind(rawValue: "brake_fluid")
    public static let oil = PartKind(rawValue: "oil")
    public static let other = PartKind(rawValue: "other")

    public static let all: [PartKind] = [
        .padsFront, .padsRear, .tires, .rotorsFront, .rotorsRear, .brakeFluid, .oil, .other
    ]
}

/// A consumable fitted to a vehicle, with its wear measurements and estimate.
public struct Part: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var vehicleId: Int
    public var kind: PartKind
    public var name: String?
    public var installedOn: String
    public var retiredOn: String?
    /// Expected service life in on-track hours; defaulted from retired
    /// lifecycles of the same kind when the user doesn't supply one.
    public var expectedHours: Double?
    /// The measurement value at which the part is considered used up.
    public var wearLimit: Double?
    public var costCents: Int?
    public var notes: String?
    public var measurements: [Measurement]
    public var wear: WearEstimate

    public enum CodingKeys: String, CodingKey {
        case id, kind, name, notes, measurements, wear
        case vehicleId = "vehicle_id"
        case installedOn = "installed_on"
        case retiredOn = "retired_on"
        case expectedHours = "expected_hours"
        case wearLimit = "wear_limit"
        case costCents = "cost_cents"
    }
}

/// A logged wear measurement (pad thickness, tread depth, …).
public struct Measurement: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var partId: Int
    public var measuredOn: String
    public var value: Double
    public var unit: String

    public enum CodingKeys: String, CodingKey {
        case id, value, unit
        case partId = "part_id"
        case measuredOn = "measured_on"
    }
}

/// How much of a part is used up and how much life is left. Mirrors
/// `WearEstimate` in `src/lib/wear.ts`.
public struct WearEstimate: Codable, Hashable, Sendable {
    /// Accrued on-track hours in the part's service window.
    public var hours: Double
    public var events: Int
    /// Event-days in the window ≈ heat cycles for tyres.
    public var cycles: Int
    public var expectedHours: Double?
    public var remainingHours: Double?
    /// 0…1, clamped.
    public var pctUsed: Double?
    public var source: WearSource?
    /// In the measurement's unit; only for a measured projection.
    public var wearPerHour: Double?
    public var lastValue: Double?
    public var unit: String?

    public enum CodingKeys: String, CodingKey {
        case hours, events, cycles, source, unit
        case expectedHours = "expected_hours"
        case remainingHours = "remaining_hours"
        case pctUsed = "pct_used"
        case wearPerHour = "wear_per_hour"
        case lastValue = "last_value"
    }
}

/// How much to trust a remaining-life projection:
/// `measured` — fitted from 2+ wear measurements; `expected` — plain
/// `expectedHours` minus accrued. Absent means there was no basis for one.
public struct WearSource: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let measured = WearSource(rawValue: "measured")
    public static let expected = WearSource(rawValue: "expected")
}
