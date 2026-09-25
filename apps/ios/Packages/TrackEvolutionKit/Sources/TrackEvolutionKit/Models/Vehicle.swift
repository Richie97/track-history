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

    public init(
        id: Int,
        name: String,
        notes: String? = nil,
        isDefault: Bool = false,
        targetHotPsi: Double? = nil,
        catalogId: Int? = nil,
        wheelbaseMm: Int? = nil,
        steeringRatio: Double? = nil
    ) {
        self.id = id
        self.name = name
        self.notes = notes
        self.isDefault = isDefault
        self.targetHotPsi = targetHotPsi
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
    /// What the car has cost (#147), in cents: its past track days' entered
    /// costs and every part ever fitted. Sums, so zero rather than nil when
    /// nothing was entered. Decoded so the contract stays pinned; nothing on
    /// this platform shows them yet.
    public var eventCostCents: Int
    public var partsCostCents: Int
    /// What the car's own odometer last said (#192), from video imports only;
    /// nil when no recorded session carries a reading. Worded by
    /// `Garage.vehicleOdometerLine`.
    public var odometer: VehicleOdometer?
    public var parts: [Part]
    /// See `Vehicle.catalogId` / `wheelbaseMm` / `steeringRatio`.
    public var catalogId: Int?
    public var wheelbaseMm: Int?
    public var steeringRatio: Double?

    public enum CodingKeys: String, CodingKey {
        case id, name, notes, hours, parts, odometer
        case isDefault = "is_default"
        case targetHotPsi = "target_hot_psi"
        case updatedAt = "updated_at"
        case eventCount = "event_count"
        case eventDays = "event_days"
        case eventCostCents = "event_cost_cents"
        case partsCostCents = "parts_cost_cents"
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
        eventCostCents: Int = 0,
        partsCostCents: Int = 0,
        odometer: VehicleOdometer? = nil,
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
        self.eventCostCents = eventCostCents
        self.partsCostCents = partsCostCents
        self.odometer = odometer
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
        eventCostCents = try c.decodeIfPresent(Int.self, forKey: .eventCostCents) ?? 0
        partsCostCents = try c.decodeIfPresent(Int.self, forKey: .partsCostCents) ?? 0
        odometer = try c.decodeIfPresent(VehicleOdometer.self, forKey: .odometer)
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
        try c.encode(eventCostCents, forKey: .eventCostCents)
        try c.encode(partsCostCents, forKey: .partsCostCents)
        try c.encode(odometer, forKey: .odometer)
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
    /// A full set — all four corners the same tyre.
    public static let tires = PartKind(rawValue: "tires")
    /// A front or rear pair, for a staggered car (its own size and wear).
    public static let tiresFront = PartKind(rawValue: "tires_front")
    public static let tiresRear = PartKind(rawValue: "tires_rear")
    public static let rotorsFront = PartKind(rawValue: "rotors_front")
    public static let rotorsRear = PartKind(rawValue: "rotors_rear")
    public static let brakeFluid = PartKind(rawValue: "brake_fluid")
    public static let oil = PartKind(rawValue: "oil")
    public static let other = PartKind(rawValue: "other")

    public static let all: [PartKind] = [
        .padsFront, .padsRear, .tires, .tiresFront, .tiresRear, .rotorsFront, .rotorsRear, .brakeFluid, .oil, .other
    ]

    /// `isTireKind` in `public/js/garage.js`: a full set or a front or rear pair.
    public var isTire: Bool { self == .tires || self == .tiresFront || self == .tiresRear }
}

/// A consumable fitted to a vehicle, with its wear measurements and estimate.
public struct Part: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var vehicleId: Int
    public var kind: PartKind
    public var name: String?
    /// A free-text size or spec ("255/40R17"), migration 0029.
    public var size: String? = nil
    public var installedOn: String
    public var retiredOn: String?
    /// On the car right now (migration 0029). False and not retired means a
    /// spare on the shelf, whose wear is frozen until it goes back on. Nil from
    /// a response cached before the field existed — read as on the car.
    public var equipped: Bool? = nil
    /// The stretches the part was on the car; wear accrues across these only.
    public var mounts: [PartMount]? = nil
    /// Expected service life in on-track hours; defaulted from retired
    /// lifecycles of the same kind when the user doesn't supply one.
    public var expectedHours: Double?
    /// The measurement value at which the part is considered used up.
    public var wearLimit: Double?
    public var costCents: Int?
    public var notes: String?
    public var measurements: [Measurement]
    public var wear: WearEstimate
    /// The distance the car's odometer covered across this part's recorded
    /// sessions (#192) — reported beside `wear`, never an input to it. Nil with
    /// fewer than two readings in its service window.
    public var odometer: PartOdometer? = nil

    public enum CodingKeys: String, CodingKey {
        case id, kind, name, size, equipped, mounts, notes, measurements, wear, odometer
        case vehicleId = "vehicle_id"
        case installedOn = "installed_on"
        case retiredOn = "retired_on"
        case expectedHours = "expected_hours"
        case wearLimit = "wear_limit"
        case costCents = "cost_cents"
    }
}

/// One stretch a part was on the car (both ends inclusive).
public struct PartMount: Codable, Hashable, Sendable {
    public var mountedOn: String
    /// Nil while it is still fitted.
    public var removedOn: String?

    public init(mountedOn: String, removedOn: String? = nil) {
        self.mountedOn = mountedOn
        self.removedOn = removedOn
    }

    public enum CodingKeys: String, CodingKey {
        case mountedOn = "mounted_on"
        case removedOn = "removed_on"
    }
}

/// The car's latest odometer reading (`vehicleOdometer` in
/// `src/lib/odometer.ts`). A reading below the running maximum is taken as
/// another car's — a borrowed or mislinked day — and counted in `otherCar`
/// rather than treated as an error.
public struct VehicleOdometer: Codable, Hashable, Sendable {
    /// Kilometres, as the car's recorder stored them.
    public var km: Double
    /// The date of the event the reading was recorded at.
    public var on: String
    public var readings: Int
    public var otherCar: Int

    public init(km: Double, on: String, readings: Int, otherCar: Int) {
        self.km = km
        self.on = on
        self.readings = readings
        self.otherCar = otherCar
    }

    public enum CodingKeys: String, CodingKey {
        case km, on, readings
        case otherCar = "other_car"
    }
}

/// A part's recorded odometer span (`partOdometer` in `src/lib/odometer.ts`).
public struct PartOdometer: Codable, Hashable, Sendable {
    /// Kilometres between the first and last reading in the service window.
    public var km: Double
    public var from: String
    public var to: String
    public var readings: Int

    public init(km: Double, from: String, to: String, readings: Int) {
        self.km = km
        self.from = from
        self.to = to
        self.readings = readings
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

public extension GarageVehicle {
    /// The car itself, without the garage's Pro half — what the vehicle list
    /// (`GET /api/vehicles`) carries for the same row, since both responses select
    /// the server's one `VEHICLE_COLUMNS`.
    var vehicle: Vehicle {
        Vehicle(
            id: id, name: name, notes: notes, isDefault: isDefault, targetHotPsi: targetHotPsi,
            catalogId: catalogId, wheelbaseMm: wheelbaseMm, steeringRatio: steeringRatio
        )
    }
}
