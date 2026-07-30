import Foundation

/// Live lap-recording core: the pure logic behind the in-app GPS recorder.
///
/// A port of `public/js/record/core.js` — same function names, same constants,
/// same values, so the Swift, Kotlin and JS versions can be diffed by eye. That
/// is the drift defense for logic no contract test covers. Its test cases come
/// from `test/unit/record.test.js`.
///
/// Plain data in, data out: no CoreLocation, no UI. The background location
/// service (NS-15) feeds it; `toParsed()` hands the result to the same review and
/// line-picker flow an imported telemetry file goes through (NS-17).
///
/// If you find a genuine bug in here, fix it in the JS first so all three clients
/// get it.
public enum RecorderCore {
    /// Checkpoint format version.
    public static let RECORDING_V = 1
    /// Fixes with worse reported accuracy than this are noise (parking garages,
    /// cold starts) — dropping them beats feeding them to the gate math.
    public static let MAX_ACC_M = 100.0
    /// Above this speed the car has clearly been on track (m/s, ~54 km/h) —
    /// auto-stop is armed only after this, so a long grid wait before the first
    /// lap never kills the recording.
    public static let DRIVEN_MPS = 15.0
    /// "Stationary" for trimming and auto-stop (m/s, brisk walking pace).
    public static let IDLE_MPS = 2.0
    /// Auto-stop after this long stationary once the car has been driven.
    public static let AUTO_STOP_IDLE_S = 15.0 * 60
    /// Absolute cap — a forgotten recorder must not run all day.
    public static let MAX_DURATION_S = 4.0 * 3600
    public static let MAX_FIXES = 20_000

    /// Default margin kept either side of the driving when trimming idle tails.
    public static let TRIM_MARGIN_S = 30.0
    /// `toParsed` needs at least this much data to be worth timing.
    static let MIN_FIXES = 30
    static let MIN_DURATION_S = 60.0

    // MARK: - Free functions (the ones the JS exports without a recording)

    /// Per-fix speed in m/s: the source's own speed when reported, else the
    /// displacement rate to the neighbouring fix (equirectangular metres — fine
    /// at track scale, same approximation as `Geo.projectTrace`).
    public static func fixSpeeds(_ fixes: [Recording.Fix]) -> [Double] {
        guard let first = fixes.first else { return [] }
        let kx = 111_320 * cos(first.lat * .pi / 180)
        let ky = 110_540.0
        return fixes.indices.map { i in
            if let v = fixes[i].v { return v }
            let a = fixes[max(0, i - 1)]
            let b = fixes[min(fixes.count - 1, i + 1)]
            let dt = b.t - a.t
            if dt <= 0 { return 0 }
            let dx = (b.lon - a.lon) * kx
            let dy = (b.lat - a.lat) * ky
            return (dx * dx + dy * dy).squareRoot() / dt
        }
    }

    /// Cut the stationary paddock/grid tails off the fix list, keeping `marginS`
    /// of context on each side so the out-lap start and the cool-down survive.
    public static func trimIdle(
        _ fixes: [Recording.Fix],
        idleMps: Double = IDLE_MPS,
        marginS: Double = TRIM_MARGIN_S
    ) -> [Recording.Fix] {
        if fixes.count < 2 { return fixes }
        let speeds = fixSpeeds(fixes)
        var first = -1
        var last = -1
        for i in speeds.indices where speeds[i] >= idleMps {
            if first < 0 { first = i }
            last = i
        }
        if first < 0 { return [] }
        let t0 = fixes[first].t - marginS
        let t1 = fixes[last].t + marginS
        return fixes.filter { $0.t >= t0 && $0.t <= t1 }
    }

    /// The checkpoint JSON. Tuple-encoded fixes keep it ~50 bytes per fix, and
    /// identical across the three clients.
    public static func serializeRecording(_ rec: Recording) -> String {
        let encoder = JSONEncoder()
        // Deterministic output: JSONEncoder doesn't otherwise promise a key
        // order, and a checkpoint gets rewritten every ~10 s and compared by eye
        // when something goes wrong. The key *order* differs from
        // JSON.stringify's (which follows declaration order) — the keys and
        // values don't, which is what makes a checkpoint portable between
        // clients.
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(rec) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    /// nil — never a throw — for anything that isn't a plausible recording. A
    /// corrupt checkpoint must not crash launch.
    public static func deserializeRecording(_ json: String?) -> Recording? {
        guard let json, !json.isEmpty, let data = json.data(using: .utf8) else { return nil }
        guard let rec = try? JSONDecoder().decode(Recording.self, from: data) else { return nil }
        guard rec.v == RECORDING_V, rec.startedAtMs.isFinite else { return nil }
        return rec
    }
}

/// A recording in progress, and the shape of its checkpoint:
/// `{ v, eventId, startedAtMs, fixes: [[tRelS, lat, lon, v|null, acc|null]] }`.
///
/// A value type with `Sendable` semantics on purpose: NS-15 feeds it from a
/// background location callback under Swift 6 strict concurrency.
public struct Recording: Hashable, Sendable {
    public var v: Int
    /// The event this recording will be saved to, if it is already known.
    ///
    /// A `String` because that's what's on the wire: the web app takes it from
    /// the `#/event/:id/record` route, so a checkpoint written there holds a
    /// string — and for an event created offline it holds a `tmp-N` placeholder.
    /// Recording must never depend on the network, so an event-less recording
    /// (nil, e.g. started from CarPlay) is normal and is adopted by an event
    /// later.
    public var eventId: String?
    /// Wall-clock start, in milliseconds since the epoch.
    public var startedAtMs: Double
    public var fixes: [Fix]

    /// One stored fix. `t` is seconds since `startedAtMs`, `v` is m/s, `acc` is
    /// the reported accuracy in metres.
    public struct Fix: Hashable, Sendable {
        public var t: Double
        public var lat: Double
        public var lon: Double
        public var v: Double?
        public var acc: Double?

        public init(t: Double, lat: Double, lon: Double, v: Double? = nil, acc: Double? = nil) {
            self.t = t
            self.lat = lat
            self.lon = lon
            self.v = v
            self.acc = acc
        }
    }

    /// A fix as the location service reports it, before validation and rounding.
    public struct RawFix: Hashable, Sendable {
        public var timeMs: Double
        public var lat: Double
        public var lon: Double
        public var speed: Double?
        public var accuracy: Double?

        public init(
            timeMs: Double, lat: Double, lon: Double, speed: Double? = nil, accuracy: Double? = nil
        ) {
            self.timeMs = timeMs
            self.lat = lat
            self.lon = lon
            self.speed = speed
            self.accuracy = accuracy
        }
    }

    /// `createRecording` in the JS.
    public init(eventId: String?, startedAtMs: Double) {
        self.v = RecorderCore.RECORDING_V
        self.eventId = eventId
        self.startedAtMs = startedAtMs
        self.fixes = []
    }

    /// Convenience for the native app, where event ids are integers.
    public init(eventId: Int?, startedAtMs: Double) {
        self.init(eventId: eventId.map(String.init), startedAtMs: startedAtMs)
    }

    /// The event id as an integer, when it is one — a `tmp-N` placeholder from an
    /// offline-created event isn't.
    public var eventIdValue: Int? {
        eventId.flatMap(Int.init)
    }

    /// Append a fix from the watcher. Returns whether it was kept: invalid,
    /// out-of-order and hopeless-accuracy fixes are dropped, and time is stored
    /// relative to `startedAtMs`.
    ///
    /// The order of these checks is the JS's order — keep it.
    @discardableResult
    public mutating func addFix(_ fix: RawFix) -> Bool {
        guard fix.timeMs.isFinite, fix.lat.isFinite, fix.lon.isFinite else { return false }
        if abs(fix.lat) > 90 || abs(fix.lon) > 180 { return false }
        if let accuracy = fix.accuracy, accuracy.isFinite, accuracy > RecorderCore.MAX_ACC_M {
            return false
        }
        let t = (fix.timeMs - startedAtMs) / 1000
        if t < 0 { return false }
        if let last = fixes.last, t <= last.t { return false }
        if fixes.count >= RecorderCore.MAX_FIXES { return false }

        // The rounding is part of the checkpoint format, not cosmetic.
        fixes.append(
            Fix(
                t: JSMath.round(t, 100),
                lat: JSMath.round(fix.lat, 1e6),
                lon: JSMath.round(fix.lon, 1e6),
                v: fix.speed.flatMap { $0.isFinite && $0 >= 0 ? JSMath.round($0, 100) : nil },
                acc: fix.accuracy.flatMap { $0.isFinite ? JSMath.round($0, 10) : nil }
            )
        )
        return true
    }

    public func elapsedS(nowMs: Double) -> Double {
        max(0, (nowMs - startedAtMs) / 1000)
    }

    /// Thresholds for `shouldAutoStop`, overridable in tests.
    public struct AutoStopOptions: Hashable, Sendable {
        public var idleS: Double
        public var drivenMps: Double
        public var idleMps: Double
        public var maxS: Double

        public init(
            idleS: Double = RecorderCore.AUTO_STOP_IDLE_S,
            drivenMps: Double = RecorderCore.DRIVEN_MPS,
            idleMps: Double = RecorderCore.IDLE_MPS,
            maxS: Double = RecorderCore.MAX_DURATION_S
        ) {
            self.idleS = idleS
            self.drivenMps = drivenMps
            self.idleMps = idleMps
            self.maxS = maxS
        }

        public static let `default` = AutoStopOptions()
    }

    /// Should the recorder stop itself? Two independent triggers:
    ///
    /// - the car was driven at track pace at some point and has now been
    ///   stationary for `idleS` (the driver forgot to stop after the session) — a
    ///   pre-session grid wait never trips this, because nothing fast has been
    ///   seen yet. That condition is load-bearing; don't "simplify" it away.
    /// - the hard duration cap, driven or not.
    public func shouldAutoStop(nowMs: Double, options: AutoStopOptions = .default) -> Bool {
        if elapsedS(nowMs: nowMs) > options.maxS { return true }
        let speeds = RecorderCore.fixSpeeds(fixes)
        var driven = false
        var lastMovingT = 0.0
        for i in speeds.indices {
            if speeds[i] >= options.drivenMps { driven = true }
            if speeds[i] >= options.idleMps { lastMovingT = fixes[i].t }
        }
        if !driven { return false }
        return elapsedS(nowMs: nowMs) - lastMovingT > options.idleS
    }

    /// The recording as a parsed-import object, the same contract a telemetry
    /// file parser returns — which is why a finished recording drops into the
    /// identical review and line-picker path. nil when there's too little data to
    /// time anything.
    ///
    /// `date` and `time` are **local**, not UTC: they pre-fill a session on the
    /// day the driver was at the track.
    public func toParsed(timeZone: TimeZone = .autoupdatingCurrent) -> ParsedRecording? {
        let fixes = RecorderCore.trimIdle(self.fixes)
        if fixes.count < RecorderCore.MIN_FIXES { return nil }
        let gps = fixes.map { Geo.Point(t: $0.t, lat: $0.lat, lon: $0.lon, v: $0.v) }
        let durationS = gps[gps.count - 1].t - gps[0].t
        if durationS < RecorderCore.MIN_DURATION_S { return nil }

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents(
            [.year, .month, .day, .hour, .minute],
            from: Date(timeIntervalSince1970: startedAtMs / 1000)
        )
        return ParsedRecording(
            date: String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0),
            time: String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0),
            durationS: durationS,
            gps: gps
        )
    }
}

/// A finished recording in the shape `js/import/parse.js` returns, so the review
/// flow doesn't care whether the laps came from a file or from the phone's GPS.
///
/// `needsLine` is always true and `laps` always empty: a live recording has no
/// lap markers, so the user picks the start/finish line and `Geo.deriveLaps`
/// times the laps.
public struct ParsedRecording: Hashable, Sendable {
    public let kind = "live"
    /// Local `yyyy-MM-dd`.
    public var date: String
    /// Local `HH:mm`.
    public var time: String
    public var durationS: Double
    public var laps: [Geo.DerivedLap] = []
    public var gps: [Geo.Point]
    public let needsLine = true
}
