import Foundation

/// One timed lap. `timeMs` is integer milliseconds, always.
public struct Lap: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var sessionId: Int
    public var lapNum: Int
    public var timeMs: Int

    public enum CodingKeys: String, CodingKey {
        case id
        case sessionId = "session_id"
        case lapNum = "lap_num"
        case timeMs = "time_ms"
    }

    public init(id: Int, sessionId: Int, lapNum: Int, timeMs: Int) {
        self.id = id
        self.sessionId = sessionId
        self.lapNum = lapNum
        self.timeMs = timeMs
    }
}

/// A run group session within an event, with its laps.
public struct Session: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var label: String?
    public var notes: String?
    public var sort: Int
    /// Best-lap GPS trace in local meters, present only on imported/recorded
    /// sessions (`sanitizeTrace` in `src/lib/validate.ts`).
    public var trace: [TracePoint]?
    /// Per-lap channel data on a shared driven-distance grid, present only on
    /// telemetry imports (`sanitizeChannels`).
    public var channels: SessionChannels?
    public var laps: [Lap]
}

/// One `[x, y, v]` point of a stored trace: local metres east/north plus speed.
/// Encoded as a bare array on the wire, matching `sanitizeTrace`.
public struct TracePoint: Codable, Hashable, Sendable {
    public var x: Double
    public var y: Double
    public var v: Double

    public init(x: Double, y: Double, v: Double) {
        self.x = x
        self.y = y
        self.v = v
    }

    public init(from decoder: any Decoder) throws {
        var c = try decoder.unkeyedContainer()
        x = try c.decode(Double.self)
        y = try c.decode(Double.self)
        v = try c.decode(Double.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.unkeyedContainer()
        try c.encode(x)
        try c.encode(y)
        try c.encode(v)
    }
}

/// `sessions.channels` — every lap's channels resampled onto one
/// driven-distance grid. Produced by the *web* importer only: telemetry file
/// import is deliberately never ported to native (see
/// `docs/specs/native/README.md`), so native reads this and never writes it.
public struct SessionChannels: Codable, Hashable, Sendable {
    /// Schema version; `sanitizeChannels` always writes 1.
    public var v: Int
    /// Grid step in metres of driven distance.
    public var dStepM: Double
    /// One value each for the whole session — ambient conditions, the track's
    /// elevation range, and the car's own odometer reading. Absent when the
    /// source carried none of them.
    public var meta: ChannelMeta?
    public var laps: [LapChannels]

    /// Decoding is the only way this arrives in the app — the initializer is here for
    /// the previews and the `-channelGraphs` demo, which have no import to read.
    public init(v: Int, dStepM: Double, meta: ChannelMeta? = nil, laps: [LapChannels]) {
        self.v = v
        self.dStepM = dStepM
        self.meta = meta
        self.laps = laps
    }
}

/// Session-level numbers stored alongside the per-lap channels. `odometerKm` is
/// the car's lifetime odometer as the recorder saw it, not this session's
/// distance.
public struct ChannelMeta: Codable, Hashable, Sendable {
    public var ambientC: Double?
    public var intakeC: Double?
    public var elevationM: Double?
    public var odometerKm: Double?

    public init(
        ambientC: Double? = nil, intakeC: Double? = nil, elevationM: Double? = nil,
        odometerKm: Double? = nil
    ) {
        self.ambientC = ambientC
        self.intakeC = intakeC
        self.elevationM = elevationM
        self.odometerKm = odometerKm
    }
}

/// One lap's channel series. All present channels share the same length —
/// `sanitizeChannels` rejects ragged data.
public struct LapChannels: Codable, Hashable, Sendable {
    /// Lap number within the session.
    public var n: Int
    public var timeMs: Int
    public var speed: [Double]?
    public var rpm: [Double]?
    public var latG: [Double]?
    /// Pedal positions in percent (0–100); PDR imports only.
    public var throttle: [Double]?
    public var brake: [Double]?
    /// Steering-wheel angle in degrees, signed; PDR imports only.
    public var steering: [Double]?
    /// Longitudinal G, signed — negative under braking. PDR imports only.
    public var longG: [Double]?
    /// Yaw rate in degrees per second, signed.
    public var yaw: [Double]?
    /// Selected gear 1–8; 0 is the clutch-in / no-gear state, not a gear.
    public var gear: [Double]?
    /// (driven − non-driven) wheelspeed as a percentage: + wheelspin, − lockup.
    public var wheelSlip: [Double]?
    /// Manifold gauge pressure in kPa; negative under vacuum.
    public var boost: [Double]?
    /// Bitfield: ABS | traction control << 1 | stability control << 2.
    public var flags: [Double]?

    // MARK: - Per-lap scalars
    //
    // Slow channels (0.5–1.4 Hz) reduced to one value per lap, because at one
    // real sample every 40–90 m an array on the 20 m grid would be
    // interpolation rather than data. `SCALAR_NAMES` in the JS.

    /// Peak oil temperature during the lap, °C.
    public var oilC: Double?
    /// Lowest oil pressure during the lap, kPa.
    public var oilKpa: Double?
    public var coolantC: Double?
    public var transC: Double?
    /// Fuel level as the lap finished, %.
    public var fuelPct: Double?
    public var battV: Double?
    /// Tyre pressures as the lap finished, kPa.
    public var tyreKpaLF: Double?
    public var tyreKpaRF: Double?
    public var tyreKpaLR: Double?
    public var tyreKpaRR: Double?
    /// Peak tyre temperatures during the lap, °C.
    public var tyreCLF: Double?
    public var tyreCRF: Double?
    public var tyreCLR: Double?
    public var tyreCRR: Double?

    public init(
        n: Int, timeMs: Int, speed: [Double]? = nil, rpm: [Double]? = nil, latG: [Double]? = nil,
        throttle: [Double]? = nil, brake: [Double]? = nil, steering: [Double]? = nil,
        longG: [Double]? = nil, yaw: [Double]? = nil, gear: [Double]? = nil,
        wheelSlip: [Double]? = nil, boost: [Double]? = nil, flags: [Double]? = nil,
        oilC: Double? = nil, oilKpa: Double? = nil, coolantC: Double? = nil,
        transC: Double? = nil, fuelPct: Double? = nil, battV: Double? = nil,
        tyreKpaLF: Double? = nil, tyreKpaRF: Double? = nil, tyreKpaLR: Double? = nil,
        tyreKpaRR: Double? = nil, tyreCLF: Double? = nil, tyreCRF: Double? = nil,
        tyreCLR: Double? = nil, tyreCRR: Double? = nil
    ) {
        self.n = n
        self.timeMs = timeMs
        self.speed = speed
        self.rpm = rpm
        self.latG = latG
        self.throttle = throttle
        self.brake = brake
        self.steering = steering
        self.longG = longG
        self.yaw = yaw
        self.gear = gear
        self.wheelSlip = wheelSlip
        self.boost = boost
        self.flags = flags
        self.oilC = oilC
        self.oilKpa = oilKpa
        self.coolantC = coolantC
        self.transC = transC
        self.fuelPct = fuelPct
        self.battV = battV
        self.tyreKpaLF = tyreKpaLF
        self.tyreKpaRF = tyreKpaRF
        self.tyreKpaLR = tyreKpaLR
        self.tyreKpaRR = tyreKpaRR
        self.tyreCLF = tyreCLF
        self.tyreCRF = tyreCRF
        self.tyreCLR = tyreCLR
        self.tyreCRR = tyreCRR
    }

    /// A gridded channel by name — `entry[name]` in the JS, which writes into a
    /// plain object. Keeping one lookup here is what lets `buildLapChannels`
    /// walk `CHANNEL_NAMES` instead of repeating a switch per channel.
    public subscript(channel name: String) -> [Double]? {
        get {
            switch name {
            case "speed": speed
            case "rpm": rpm
            case "latG": latG
            case "throttle": throttle
            case "brake": brake
            case "steering": steering
            case "longG": longG
            case "yaw": yaw
            case "gear": gear
            case "wheelSlip": wheelSlip
            case "boost": boost
            case "flags": flags
            default: nil
            }
        }
        set {
            switch name {
            case "speed": speed = newValue
            case "rpm": rpm = newValue
            case "latG": latG = newValue
            case "throttle": throttle = newValue
            case "brake": brake = newValue
            case "steering": steering = newValue
            case "longG": longG = newValue
            case "yaw": yaw = newValue
            case "gear": gear = newValue
            case "wheelSlip": wheelSlip = newValue
            case "boost": boost = newValue
            case "flags": flags = newValue
            default: break
            }
        }
    }

    /// A per-lap scalar by name — the same idea for `SCALAR_NAMES`.
    public subscript(scalar name: String) -> Double? {
        get {
            switch name {
            case "oilC": oilC
            case "oilKpa": oilKpa
            case "coolantC": coolantC
            case "transC": transC
            case "fuelPct": fuelPct
            case "battV": battV
            case "tyreKpaLF": tyreKpaLF
            case "tyreKpaRF": tyreKpaRF
            case "tyreKpaLR": tyreKpaLR
            case "tyreKpaRR": tyreKpaRR
            case "tyreCLF": tyreCLF
            case "tyreCRF": tyreCRF
            case "tyreCLR": tyreCLR
            case "tyreCRR": tyreCRR
            default: nil
            }
        }
        set {
            switch name {
            case "oilC": oilC = newValue
            case "oilKpa": oilKpa = newValue
            case "coolantC": coolantC = newValue
            case "transC": transC = newValue
            case "fuelPct": fuelPct = newValue
            case "battV": battV = newValue
            case "tyreKpaLF": tyreKpaLF = newValue
            case "tyreKpaRF": tyreKpaRF = newValue
            case "tyreKpaLR": tyreKpaLR = newValue
            case "tyreKpaRR": tyreKpaRR = newValue
            case "tyreCLF": tyreCLF = newValue
            case "tyreCRF": tyreCRF = newValue
            case "tyreCLR": tyreCLR = newValue
            case "tyreCRR": tyreCRR = newValue
            default: break
            }
        }
    }
}

extension ChannelMeta {
    /// A session number by name — `META_NAMES` in the JS.
    public subscript(name: String) -> Double? {
        get {
            switch name {
            case "ambientC": ambientC
            case "intakeC": intakeC
            case "elevationM": elevationM
            case "odometerKm": odometerKm
            default: nil
            }
        }
        set {
            switch name {
            case "ambientC": ambientC = newValue
            case "intakeC": intakeC = newValue
            case "elevationM": elevationM = newValue
            case "odometerKm": odometerKm = newValue
            default: break
            }
        }
    }

    var isEmpty: Bool {
        ambientC == nil && intakeC == nil && elevationM == nil && odometerKm == nil
    }
}
