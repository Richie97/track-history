import Foundation

/// Session conditions (#191) — the port of the pure half of
/// `public/js/conditions.js`.
///
/// Same function and constant names as the JS original so the two diff by eye,
/// that file's test cases come with it (``SessionConditionsTests``), and the
/// output is pinned against the web implementation by
/// `contracts/logic/conditions.json`. The name is the one deliberate
/// difference: `Conditions` is already the dry/damp/wet enum on ``Event``.
///
/// Lap times across a day are confounded by air temperature. A morning session
/// and an afternoon session are not comparable, and a progress chart that plots
/// them as if they were invites the wrong conclusion: a line that ticks upward
/// after lunch reads as "I got worse" when what happened is that the track got
/// hotter.
///
/// Three rules shape everything here and this port inherits all of them.
///
/// **Recorded beats typed, and never overwrites it.** Every video telemetry
/// import stores `meta.ambientC`, which migration 0020 lifts into
/// `sessions.ambient_c` and the event query aggregates into `ambient_lo_c` /
/// `ambient_hi_c`. Events also carry a manual `temp_f` the driver typed.
/// ``eventAmbient(_:)`` prefers the recorded value and falls back to the typed
/// one, and nothing anywhere writes one from the other.
///
/// **Per session, only what was measured.** A session's chip shows the ambient
/// that session's own recording saw, never the event's typed figure repeated
/// down the page. The manual fallback is an *event*-level idea because that is
/// the level it was entered at.
///
/// **Context is a band, not a series.** Behind the progress chart the
/// temperature is a faint wash per event, deepening with heat. A second line
/// would read as a comparison — "lap time versus temperature" — which is not
/// the claim; the claim is only that these two events were not run in the same
/// air. That is also why ``conditionsBand(_:)`` returns nil under
/// ``BAND_MIN_SPAN_C``: a uniform wash shows nothing and implies something.
///
/// Temperatures are °C and elevations metres throughout, with display
/// conversion a separate step (``tempText(_:_:)``, ``elevationText(_:_:)``), so
/// the fixture pins numbers rather than a locale.
public enum SessionConditions {
    /// Which unit system the text comes out in. Its own enum rather than
    /// ``Health/Units`` — the two analyses share a vocabulary, not a type.
    public enum Units: String, Sendable {
        case metric
        case us
    }

    // MARK: - Constants

    /// Fewer known events than this in view and there is nothing to compare.
    public static let BAND_MIN_EVENTS = 2
    /// A spread under this many °C is weather noise, not a hot afternoon.
    public static let BAND_MIN_SPAN_C = 3.0
    /// The wash, coolest to hottest. Faint on purpose: it sits *behind* the lap
    /// times and must never compete with the line for attention.
    public static let BAND_MIN_ALPHA = 0.05
    public static let BAND_MAX_ALPHA = 0.3

    // MARK: - Conversion

    public static func cToF(_ c: Double) -> Double { c * 1.8 + 32 }
    public static func fToC(_ f: Double) -> Double { (f - 32) / 1.8 }
    public static func mToFt(_ m: Double) -> Double { m / 0.3048 }

    /// JavaScript's `Math.round`: ties go **up**, toward +infinity, so -12.5
    /// rounds to -12. Swift's own `rounded()` is half *away from zero* and
    /// gives -13 — a one-degree disagreement with the web on every freezing
    /// morning, which is exactly why the fixture probes the negative halves.
    /// Landing in `Int` also keeps a rounded -0.5 from printing as "-0".
    static func roundHalfUp(_ v: Double) -> Int { Int((v + 0.5).rounded(.down)) }

    /// The opacity of one band cell. Linear in the normalized temperature, so
    /// the coolest event in view is barely tinted and the hottest unmistakable.
    public static func bandAlpha(_ intensity: Double) -> Double {
        BAND_MIN_ALPHA + (BAND_MAX_ALPHA - BAND_MIN_ALPHA) * min(1, max(0, intensity))
    }

    // MARK: - Inputs

    /// The minimum an event needs for these rules. A protocol rather than a
    /// concrete ``Event`` so tests can express a case in four fields, mirroring
    /// the JS, which duck-types the same way.
    public protocol AmbientEvent {
        /// The coolest and hottest ambient this event's sessions recorded, °C.
        var ambientLoC: Double? { get }
        var ambientHiC: Double? { get }
        /// The largest elevation range recorded at it, metres.
        var elevationM: Double? { get }
        /// The temperature the driver typed, °F.
        var tempF: Int? { get }
    }

    /// The same for a session: the derived column, and the blob it came from.
    public protocol AmbientSession {
        var ambientC: Double? { get }
        var elevationM: Double? { get }
        var channelMeta: ChannelMeta? { get }
    }

    // MARK: - Reading

    /// The ambient a session's own telemetry recorded, °C, or nil.
    ///
    /// The column (migration 0020) is the denormalization of the blob, so it is
    /// read first and the blob is the fallback — which matters for a response
    /// cached before the column existed, and for a free account, whose
    /// `channels` are stripped while the column is not.
    public static func sessionAmbientC(_ session: some AmbientSession) -> Double? {
        session.ambientC ?? session.channelMeta?.ambientC
    }

    /// The elevation *range* a session's recording saw, metres — max minus min
    /// altitude, i.e. how much the track climbs and falls, not its height above
    /// the sea.
    public static func sessionElevationM(_ session: some AmbientSession) -> Double? {
        session.elevationM ?? session.channelMeta?.elevationM
    }

    /// An event's ambient temperature, reconciled: the range its sessions
    /// recorded if any did, else the number the driver typed, else nothing.
    /// `loC == hiC` for a single session and for the manual case.
    public static func eventAmbient(_ event: (some AmbientEvent)?) -> Ambient? {
        guard let event else { return nil }
        if let lo = event.ambientLoC, let hi = event.ambientHiC {
            return Ambient(loC: min(lo, hi), hiC: max(lo, hi), source: .recorded)
        }
        if let f = event.tempF {
            let c = fToC(Double(f))
            return Ambient(loC: c, hiC: c, source: .manual)
        }
        return nil
    }

    /// The midpoint of an event's ambient range — the single number the band
    /// shades by, where the text keeps the range.
    public static func ambientMidC(_ ambient: Ambient?) -> Double? {
        ambient.map { ($0.loC + $0.hiC) / 2 }
    }

    /// The largest elevation range recorded at a track, metres, over its
    /// events. A range, so the figure is a maximum rather than a sum: two
    /// events at one track saw the same hill.
    public static func trackElevationM(_ events: [some AmbientEvent]) -> Double? {
        events.compactMap(\.elevationM).max()
    }

    // MARK: - Words

    /// A temperature in the given system, whole degrees: "84 °F".
    public static func tempText(_ c: Double, _ units: Units = .metric) -> String {
        let v = units == .us ? cToF(c) : c
        return "\(roundHalfUp(v)) \(units == .us ? "°F" : "°C")"
    }

    /// An event's ambient as words: one figure, or the day's range when its
    /// sessions disagree. Rounding collapses the range first, so 21.4–21.8 °C
    /// reads as one number rather than "71–71 °F".
    public static func ambientText(_ ambient: Ambient?, _ units: Units = .metric) -> String {
        guard let ambient else { return "" }
        let unit = units == .us ? "°F" : "°C"
        let lo = roundHalfUp(units == .us ? cToF(ambient.loC) : ambient.loC)
        let hi = roundHalfUp(units == .us ? cToF(ambient.hiC) : ambient.hiC)
        return lo == hi ? "\(lo) \(unit)" : "\(lo)–\(hi) \(unit)"
    }

    /// The elevation line. Context, not coaching — one line, and no more.
    public static func elevationText(_ m: Double?, _ units: Units = .metric) -> String {
        guard let m else { return "" }
        let v = units == .us ? mToFt(m) : m
        return "\(roundHalfUp(v)) \(units == .us ? "ft" : "m") of elevation change"
    }

    /// The chart's spoken description of the shading — the part a screen-reader
    /// user cannot see, same reason the charts say which way the trend goes.
    public static func bandLabel(_ band: Band?, _ units: Units = .metric) -> String {
        guard let band else { return "" }
        return "shaded by ambient temperature, \(tempText(band.loC, units)) to \(tempText(band.hiC, units))"
    }

    // MARK: - The band

    /// The band behind the progress chart, aligned one cell per plotted event,
    /// in the order given. A cell is nil where that event has no temperature at
    /// all — an unknown day must draw nothing, not the coolest shade, which
    /// would claim a measurement that was never made.
    ///
    /// Nil overall when fewer than ``BAND_MIN_EVENTS`` carry a temperature or
    /// they span less than ``BAND_MIN_SPAN_C``.
    public static func conditionsBand(_ events: [some AmbientEvent]) -> Band? {
        let mids = events.map { ambientMidC(eventAmbient($0)) }
        let known = mids.compactMap { $0 }
        guard known.count >= BAND_MIN_EVENTS, let loC = known.min(), let hiC = known.max() else {
            return nil
        }
        guard hiC - loC >= BAND_MIN_SPAN_C else { return nil }
        return Band(
            loC: loC,
            hiC: hiC,
            cells: mids.map { c in
                guard let c else { return nil }
                let intensity = (c - loC) / (hiC - loC)
                return BandCell(c: c, intensity: intensity, alpha: bandAlpha(intensity))
            }
        )
    }

    // MARK: - Types

    /// Where an event's temperature came from. The view can say so rather than
    /// presenting a typed number as a measurement.
    public enum Source: String, Sendable, Equatable, Decodable {
        case recorded
        case manual
    }

    public struct Ambient: Sendable, Equatable, Decodable {
        public var loC: Double
        public var hiC: Double
        public var source: Source

        public init(loC: Double, hiC: Double, source: Source) {
            self.loC = loC
            self.hiC = hiC
            self.source = source
        }
    }

    /// One event's cell of the wash. `c` is the midpoint it was shaded by.
    public struct BandCell: Sendable, Equatable, Decodable {
        public var c: Double
        public var intensity: Double
        public var alpha: Double

        public init(c: Double, intensity: Double, alpha: Double) {
            self.c = c
            self.intensity = intensity
            self.alpha = alpha
        }
    }

    public struct Band: Sendable, Equatable, Decodable {
        public var loC: Double
        public var hiC: Double
        /// One per plotted event, nil where nothing was known.
        public var cells: [BandCell?]

        public init(loC: Double, hiC: Double, cells: [BandCell?]) {
            self.loC = loC
            self.hiC = hiC
            self.cells = cells
        }
    }
}

// The logbook's own models are the everyday inputs; the protocols exist so the
// rules can also be exercised on four fields.
extension Event: SessionConditions.AmbientEvent {}

extension Session: SessionConditions.AmbientSession {
    public var channelMeta: ChannelMeta? { channels?.meta }
}
