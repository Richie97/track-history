import Foundation

/// A per-event-day setup sheet. Mirrors `SetupSheet` / `sanitizeSetup` in
/// `src/lib/validate.ts` field for field — every field optional, because
/// applicability varies by car.
///
/// The setup notebook is a **deferred** feature on native (web only, see
/// `docs/specs/native/README.md`); this type exists so the event-detail and
/// track-setup responses decode losslessly, and so a native editor later has
/// somewhere to land.
public struct SetupSheet: Codable, Hashable, Sendable {
    /// Tyre pressures, psi.
    public var tpCold: CornerValues?
    public var tpHot: CornerValues?
    /// Degrees.
    public var camber: AxleValues?
    /// The user's unit (degrees or inches).
    public var toe: AxleValues?
    public var caster: AxleValues?
    /// Damper clicks.
    public var rebound: AxleValues?
    public var compression: AxleValues?
    /// Bar position / hole.
    public var sway: AxleValues?
    /// Gallons at session start.
    public var fuel: Double?
    /// `parts.id` references — which consumables were on the car.
    public var tiresId: Int?
    public var padsFId: Int?
    public var padsRId: Int?
    public var notes: String?

    public enum CodingKeys: String, CodingKey {
        case camber, toe, caster, rebound, compression, sway, fuel, notes
        case tpCold = "tp_cold"
        case tpHot = "tp_hot"
        case tiresId = "tires_id"
        case padsFId = "pads_f_id"
        case padsRId = "pads_r_id"
    }

    public init() {}
}

/// Per-corner values: front-left, front-right, rear-left, rear-right.
public struct CornerValues: Codable, Hashable, Sendable {
    public var fl: Double?
    public var fr: Double?
    public var rl: Double?
    public var rr: Double?
}

/// Per-axle values: front, rear.
public struct AxleValues: Codable, Hashable, Sendable {
    public var f: Double?
    public var r: Double?
}

/// One day's setup sheet as returned inside an event's detail.
public struct Setup: Codable, Hashable, Sendable, Identifiable {
    /// 1-based day within the event.
    public var day: Int
    public var data: SetupSheet

    public var id: Int { day }
}

/// `GET /api/events/:id/setups/prefill` — the copy-forward prefill for a blank
/// setup form. `data` is nil when there is nothing to copy forward.
public struct SetupPrefill: Codable, Hashable, Sendable {
    public var data: SetupSheet?
}
