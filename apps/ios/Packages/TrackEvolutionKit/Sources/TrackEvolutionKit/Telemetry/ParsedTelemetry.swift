import Foundation

/// One parsed telemetry source, whatever produced it.
///
/// The shape every parser in `public/js/import/parse.js` resolves to, and the
/// reason the review flow doesn't care where laps came from: a PDR file with
/// beacons arrives with exact laps and skips the line picker, a GoPro clip
/// arrives with a trace and `needsLine`, and a phone recording
/// (`ParsedRecording`) converts into the same value. NS-30 generalised
/// `ReviewModel`'s input to this so all three share one screen.
public struct ParsedTelemetry: Sendable {
    /// Which parser produced this. `KIND_LABELS` in the JS.
    public enum Kind: String, Sendable {
        case pdr
        case gopro
        /// Not a file parser: the in-app lap recorder.
        case live

        /// The label the default session name is built from.
        public var label: String {
            switch self {
            case .pdr: "PDR"
            case .gopro: "GoPro"
            case .live: "Recorded"
            }
        }
    }

    public var kind: Kind
    /// Local `yyyy-MM-dd` from the file, when it carries one.
    public var date: String?
    /// Local `HH:mm:ss`.
    public var time: String?
    public var durationS: Double
    public var laps: [ParsedLap]
    /// Decoded GPS trace in degrees, or nil when the source has none the app can
    /// use — normal for a PDR recording whose coordinates don't decode.
    public var gps: [Geo.Point]?
    /// The user has to pick a start/finish line before this has laps.
    public var needsLine: Bool
    /// Best-lap polyline, drawn as the racing line on the event page.
    public var bestLapTrace: [TracePoint]?
    /// Per-lap channel arrays on a driven-distance grid, stored with the session.
    public var lapChannels: SessionChannels?
    /// Session maxima from a PDR file's car channels.
    public var metrics: Metrics?

    // MARK: - PDR-only

    /// How many beacon crossings the recorder actually logged. Zero means every
    /// lap here was derived rather than timed.
    public var beaconCount: Int
    /// Raw latitude and odometer series, kept for lap recovery (`PDRLaps`).
    public var channels: RawChannels?
    /// Scaled car channels for the per-lap graphs.
    public var carChannels: CarChannels
    /// The slow channels, keyed by `SCALAR_NAMES`, before they are reduced to
    /// one value per lap. A dictionary rather than a struct because nothing
    /// reads an individual one — `buildLapChannels` walks the whole list.
    public var lapScalarChannels: [String: [ChannelPoint]]
    /// Session-level numbers, stored as the channel blob's `meta`.
    public var sessionMeta: SessionMeta?
    /// Set when laps came from lat-vs-distance periodicity rather than beacons.
    public var lapRecovery: LapRecovery?

    public init(
        kind: Kind,
        date: String? = nil,
        time: String? = nil,
        durationS: Double = 0,
        laps: [ParsedLap] = [],
        gps: [Geo.Point]? = nil,
        needsLine: Bool = false,
        bestLapTrace: [TracePoint]? = nil,
        lapChannels: SessionChannels? = nil,
        metrics: Metrics? = nil,
        beaconCount: Int = 0,
        channels: RawChannels? = nil,
        carChannels: CarChannels = CarChannels(),
        lapScalarChannels: [String: [ChannelPoint]] = [:],
        sessionMeta: SessionMeta? = nil,
        lapRecovery: LapRecovery? = nil
    ) {
        self.kind = kind
        self.date = date
        self.time = time
        self.durationS = durationS
        self.laps = laps
        self.gps = gps
        self.needsLine = needsLine
        self.bestLapTrace = bestLapTrace
        self.lapChannels = lapChannels
        self.metrics = metrics
        self.beaconCount = beaconCount
        self.channels = channels
        self.carChannels = carChannels
        self.lapScalarChannels = lapScalarChannels
        self.sessionMeta = sessionMeta
        self.lapRecovery = lapRecovery
    }

    /// Session maxima — each nil when the file doesn't carry the channel, or
    /// carries one whose peak isn't plausible.
    public struct Metrics: Hashable, Sendable {
        public var topSpeedKph: Double?
        public var maxRpm: Double?
        public var maxLatG: Double?
        /// Peak braking, reported positive the way a driver talks about it —
        /// it is the negative half of longitudinal G.
        public var maxBrakeG: Double?
        public var maxBoostKpa: Double?
        public var maxOilC: Double?

        public init(
            topSpeedKph: Double? = nil, maxRpm: Double? = nil, maxLatG: Double? = nil,
            maxBrakeG: Double? = nil, maxBoostKpa: Double? = nil, maxOilC: Double? = nil
        ) {
            self.topSpeedKph = topSpeedKph
            self.maxRpm = maxRpm
            self.maxLatG = maxLatG
            self.maxBrakeG = maxBrakeG
            self.maxBoostKpa = maxBoostKpa
            self.maxOilC = maxOilC
        }
    }

    /// The two raw PDR series lap recovery works from.
    public struct RawChannels: Hashable, Sendable {
        public var latPts: [ChannelPoint]
        public var odoPts: [ChannelPoint]

        public init(latPts: [ChannelPoint], odoPts: [ChannelPoint]) {
            self.latPts = latPts
            self.odoPts = odoPts
        }
    }

    /// Car channels in display units: speed km/h, latG in G, throttle/brake in %,
    /// steering in signed steering-wheel degrees. nil where the file lacks the
    /// channel.
    public struct CarChannels: Hashable, Sendable {
        public var speed: [ChannelPoint]?
        public var rpm: [ChannelPoint]?
        public var latG: [ChannelPoint]?
        public var throttle: [ChannelPoint]?
        public var brake: [ChannelPoint]?
        public var steering: [ChannelPoint]?
        /// Signed: negative under braking.
        public var longG: [ChannelPoint]?
        /// Degrees per second, signed.
        public var yaw: [ChannelPoint]?
        /// 1–8, or 0 for the clutch-in / no-gear state.
        public var gear: [ChannelPoint]?
        /// (driven − non-driven) wheelspeed, %.
        public var wheelSlip: [ChannelPoint]?
        /// Manifold gauge pressure, kPa.
        public var boost: [ChannelPoint]?
        /// ABS | traction control << 1 | stability control << 2.
        public var flags: [ChannelPoint]?

        public init(
            speed: [ChannelPoint]? = nil, rpm: [ChannelPoint]? = nil, latG: [ChannelPoint]? = nil,
            throttle: [ChannelPoint]? = nil, brake: [ChannelPoint]? = nil,
            steering: [ChannelPoint]? = nil, longG: [ChannelPoint]? = nil,
            yaw: [ChannelPoint]? = nil, gear: [ChannelPoint]? = nil,
            wheelSlip: [ChannelPoint]? = nil, boost: [ChannelPoint]? = nil,
            flags: [ChannelPoint]? = nil
        ) {
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
        }

        /// `chans[name]` in the JS, which indexes a plain object. Every caller
        /// walks `TelemetryChannels.CHANNEL_NAMES`, so keeping one lookup here
        /// is what stops a channel from being added to the list and silently
        /// never read.
        public subscript(name: String) -> [ChannelPoint]? {
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
    }

    /// Session-level numbers from a PDR file, carried into the stored blob's
    /// `meta`. `SessionMeta` is the JS's `sessionMeta`.
    public struct SessionMeta: Hashable, Sendable {
        public var ambientC: Double?
        public var intakeC: Double?
        public var elevationM: Double?
        /// The car's lifetime odometer, not this session's distance.
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

    /// The outcome of lat-vs-distance lap recovery for a beacon-less recording.
    public struct LapRecovery: Sendable {
        public var laps: [ParsedLap]
        public var lapM: Double
        /// Periodicity confidence of the recovered lap length.
        public var r: Double
        /// Whether the boundaries were pulled onto a real start/finish by a
        /// beacon-timed recording in the same batch.
        public var anchored: Bool
        /// Template-match confidence, once anchored.
        public var phaseR: Double?

        public init(
            laps: [ParsedLap], lapM: Double, r: Double, anchored: Bool, phaseR: Double? = nil
        ) {
            self.laps = laps
            self.lapM = lapM
            self.r = r
            self.anchored = anchored
            self.phaseR = phaseR
        }
    }
}

/// A lap as a parser reports it.
///
/// `Geo.DerivedLap` with two differences that matter: a PDR beacon carries an
/// absolute crossing number (`lapNumber`), and a hand-entered lap has no time
/// window at all — which is exactly the case `buildLapChannels` skips.
public struct ParsedLap: Hashable, Sendable {
    /// The recorder's own crossing number, when there is one.
    public var lapNumber: Int?
    public var timeMs: Int
    /// Derived rather than timed by a beacon. Rendered with a `~` prefix.
    public var estimated: Bool
    /// On the telemetry clock, the same clock as `gps[].t`.
    public var startT: Double?
    public var endT: Double?

    public init(
        lapNumber: Int? = nil, timeMs: Int, estimated: Bool, startT: Double? = nil,
        endT: Double? = nil
    ) {
        self.lapNumber = lapNumber
        self.timeMs = timeMs
        self.estimated = estimated
        self.startT = startT
        self.endT = endT
    }

    public init(_ lap: Geo.DerivedLap) {
        self.init(timeMs: lap.timeMs, estimated: lap.estimated, startT: lap.startT, endT: lap.endT)
    }
}

extension ParsedRecording {
    /// A finished phone recording as a parsed source, so it enters the same review
    /// flow an imported clip does.
    public var asTelemetry: ParsedTelemetry {
        ParsedTelemetry(
            kind: .live,
            date: date,
            time: time,
            durationS: durationS,
            laps: laps.map(ParsedLap.init),
            gps: gps,
            needsLine: needsLine
        )
    }
}
