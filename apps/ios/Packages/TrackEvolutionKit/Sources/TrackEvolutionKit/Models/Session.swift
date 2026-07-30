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
    public var laps: [LapChannels]
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
}
