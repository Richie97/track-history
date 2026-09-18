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
    /// The target hot tyre pressure (psi, all four corners) the web app's
    /// pressure loop aims the next cold pressures at (#190). Set on the web,
    /// decoded here so the response stays pinned; nothing native reads it yet.
    public var targetHotPsi: Double?
    /// The seeded car-catalog generation this car was picked from (#221), or
    /// nil for a car typed by hand. Identity, not ownership: the pick pre-filled
    /// the two numbers below and the catalog is never consulted again.
    public var catalogId: Int?
    /// Wheelbase in millimetres and the steering ratio ("16.25:1" → 16.25),
    /// the two spec-sheet constants the balance read-out needs (#208). Both
    /// optional; a car with neither keeps the relative reading.
    public var wheelbaseMm: Int?
    public var steeringRatio: Double?

    public enum CodingKeys: String, CodingKey {
        case id, name, notes
        case isDefault = "is_default"
        case targetHotPsi = "target_hot_psi"
        case catalogId = "catalog_id"
        case wheelbaseMm = "wheelbase_mm"
        case steeringRatio = "steering_ratio"
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        isDefault = try c.decode(Int.self, forKey: .isDefault) != 0
        targetHotPsi = try c.decodeIfPresent(Double.self, forKey: .targetHotPsi)
        catalogId = try c.decodeIfPresent(Int.self, forKey: .catalogId)
        wheelbaseMm = try c.decodeIfPresent(Int.self, forKey: .wheelbaseMm)
        steeringRatio = try c.decodeIfPresent(Double.self, forKey: .steeringRatio)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(notes, forKey: .notes)
        try c.encode(isDefault ? 1 : 0, forKey: .isDefault)
        try c.encode(targetHotPsi, forKey: .targetHotPsi)
        try c.encode(catalogId, forKey: .catalogId)
        try c.encode(wheelbaseMm, forKey: .wheelbaseMm)
        try c.encode(steeringRatio, forKey: .steeringRatio)
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
    /// See `Vehicle.targetHotPsi`.
    public var targetHotPsi: Double?
    public var updatedAt: Int
    /// On-track hours accrued across the vehicle's events.
    public var hours: Double
    public var eventCount: Int
    public var eventDays: Int
    public var parts: [Part]
    /// See `Vehicle.catalogId` / `wheelbaseMm` / `steeringRatio`.
    public var catalogId: Int?
    public var wheelbaseMm: Int?
    public var steeringRatio: Double?

    public enum CodingKeys: String, CodingKey {
        case id, name, notes, hours, parts
        case isDefault = "is_default"
        case targetHotPsi = "target_hot_psi"
        case updatedAt = "updated_at"
        case eventCount = "event_count"
        case eventDays = "event_days"
        case catalogId = "catalog_id"
        case wheelbaseMm = "wheelbase_mm"
        case steeringRatio = "steering_ratio"
    }

    /// Spelled out because the custom `init(from:)` below suppresses the
    /// memberwise one — tests and previews still need to build a garage.
    public init(
        id: Int,
        name: String,
        notes: String? = nil,
        isDefault: Bool = false,
        targetHotPsi: Double? = nil,
        updatedAt: Int = 0,
        hours: Double = 0,
        eventCount: Int = 0,
        eventDays: Int = 0,
        parts: [Part] = [],
        catalogId: Int? = nil,
        wheelbaseMm: Int? = nil,
        steeringRatio: Double? = nil
    ) {
        self.id = id
        self.name = name
        self.notes = notes
        self.isDefault = isDefault
        self.targetHotPsi = targetHotPsi
        self.updatedAt = updatedAt
        self.hours = hours
        self.eventCount = eventCount
        self.eventDays = eventDays
        self.parts = parts
        self.catalogId = catalogId
        self.wheelbaseMm = wheelbaseMm
        self.steeringRatio = steeringRatio
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        isDefault = try c.decode(Int.self, forKey: .isDefault) != 0
        targetHotPsi = try c.decodeIfPresent(Double.self, forKey: .targetHotPsi)
        updatedAt = try c.decode(Int.self, forKey: .updatedAt)
        hours = try c.decode(Double.self, forKey: .hours)
        eventCount = try c.decode(Int.self, forKey: .eventCount)
        eventDays = try c.decode(Int.self, forKey: .eventDays)
        parts = try c.decode([Part].self, forKey: .parts)
        catalogId = try c.decodeIfPresent(Int.self, forKey: .catalogId)
        wheelbaseMm = try c.decodeIfPresent(Int.self, forKey: .wheelbaseMm)
        steeringRatio = try c.decodeIfPresent(Double.self, forKey: .steeringRatio)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(notes, forKey: .notes)
        try c.encode(isDefault ? 1 : 0, forKey: .isDefault)
        try c.encode(targetHotPsi, forKey: .targetHotPsi)
        try c.encode(updatedAt, forKey: .updatedAt)
        try c.encode(hours, forKey: .hours)
        try c.encode(eventCount, forKey: .eventCount)
        try c.encode(eventDays, forKey: .eventDays)
        try c.encode(parts, forKey: .parts)
        try c.encode(catalogId, forKey: .catalogId)
        try c.encode(wheelbaseMm, forKey: .wheelbaseMm)
        try c.encode(steeringRatio, forKey: .steeringRatio)
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
