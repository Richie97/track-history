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
        self.lapRecovery = lapRecovery
    }

    /// Session maxima — each nil when the file doesn't carry the channel, or
    /// carries one whose peak isn't plausible.
    public struct Metrics: Hashable, Sendable {
        public var topSpeedKph: Double?
        public var maxRpm: Double?
        public var maxLatG: Double?

        public init(topSpeedKph: Double? = nil, maxRpm: Double? = nil, maxLatG: Double? = nil) {
            self.topSpeedKph = topSpeedKph
            self.maxRpm = maxRpm
            self.maxLatG = maxLatG
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

    /// Car channels in display units: speed km/h, latG in G. nil where the file
    /// lacks the channel.
    public struct CarChannels: Hashable, Sendable {
        public var speed: [ChannelPoint]?
        public var rpm: [ChannelPoint]?
        public var latG: [ChannelPoint]?

        public init(
            speed: [ChannelPoint]? = nil, rpm: [ChannelPoint]? = nil, latG: [ChannelPoint]? = nil
        ) {
            self.speed = speed
            self.rpm = rpm
            self.latG = latG
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
