import Foundation

/// The lap-overlay panel's maths: which stored lap owns which channel series, which
/// laps are highlighted, and the window each channel is drawn in.
///
/// A port of the non-drawing half of `public/js/channel-graphs.js` — same function
/// name (`matchLapsToChannels`), same channel order, same three highlight slots and
/// the same 8% axis padding, and that file's test cases come with it
/// (`ChannelGraphsTests`). The SVG string building has no counterpart here: the view
/// draws with Swift Charts (NS-23), so only the numbers cross over.
///
/// The data itself (`sessions.channels`) is written by the *web* telemetry importer
/// only — native reads it and never produces it — so every entry point here has to
/// survive a session that carries nothing at all.
public enum ChannelGraphs {
    /// How many laps can be highlighted at once: the three chart-line slots
    /// (`--chart-line` / `-b` / `-c`). `SLOTS.length` in the JS.
    public static let SLOT_COUNT = 3

    /// A channel the importer may have stored, and how it reads.
    ///
    /// `CHANNEL_DEFS` in the JS, in the same order — which is also the order the
    /// charts stack in.
    public enum Channel: String, CaseIterable, Sendable {
        case speed
        case throttle
        case brake
        case steering
        case rpm
        case latG
        /// Yaw rate, the honest baseline for the balance read-out (`Balance`,
        /// #189): signed, so it swings both ways around zero like steering does.
        case yaw

        public var label: String {
            switch self {
            case .speed: "Speed"
            case .throttle: "Throttle"
            case .brake: "Brake"
            case .steering: "Steering"
            case .rpm: "RPM"
            case .latG: "Lateral G"
            case .yaw: "Yaw rate"
            }
        }

        /// The unit a readout of this channel carries, in the account's system:
        /// speed is stored km/h and shown as mph or km/h (`Units.speedUnit`); every
        /// other channel reads the same in both. `channelDefs(units)` in the JS.
        public func unit(_ units: UnitSystem) -> String {
            switch self {
            case .speed: Units.speedUnit(units)
            case .throttle, .brake: "%"
            case .steering: "°"
            case .rpm: "rpm"
            case .latG: "G"
            case .yaw: "°/s"
            }
        }

        /// Decimal places a readout of this channel shows.
        public var decimals: Int {
            switch self {
            case .speed, .throttle, .brake, .steering, .rpm, .yaw: 0
            case .latG: 2
            }
        }

        /// Whether the axis is pinned at zero rather than padded below the minimum.
        /// Lateral G and the pedals are magnitudes — an axis starting at 0.3 G (or
        /// 20% throttle) reads as if the car never went straight (or lifted).
        /// Steering and yaw rate are signed, so they keep the padded axis.
        public var floorAtZero: Bool {
            switch self {
            case .throttle, .brake, .latG: true
            case .speed, .steering, .rpm, .yaw: false
            }
        }

        /// Stored units → displayed units. Speed is stored in km/h and shown in the
        /// account's system (`Units.convSpeedKph`); nothing else converts.
        public func convert(_ raw: Double, _ units: UnitSystem) -> Double {
            self == .speed ? Units.convSpeedKph(raw, units) : raw
        }

        /// This channel's series on one lap, or nil when that lap didn't record it.
        public func series(of lap: LapChannels) -> [Double]? {
            switch self {
            case .speed: lap.speed
            case .throttle: lap.throttle
            case .brake: lap.brake
            case .steering: lap.steering
            case .rpm: lap.rpm
            case .latG: lap.latG
            case .yaw: lap.yaw
            }
        }
    }

    /// A stored lap paired with its channel series. `chIdx` is an index into
    /// `SessionChannels.laps`, or **-1** for a lap that carries no channel data —
    /// the JS sentinel, kept so the two read the same.
    public struct LapMatch: Sendable, Equatable {
        public var lap: Lap
        public var chIdx: Int

        public init(lap: Lap, chIdx: Int) {
            self.lap = lap
            self.chIdx = chIdx
        }

        public var hasChannels: Bool { chIdx >= 0 }
    }

    /// Match the session's stored lap rows (chronological) to the channel entries
    /// (same order). Both come from the same parsed laps at import time, but a lap
    /// can lack channel data (no distance window) and laps hand-added later have
    /// none — an in-order greedy match on the exact millisecond times pairs them up.
    public static func matchLapsToChannels(_ sessionLaps: [Lap], _ chLaps: [LapChannels]) -> [LapMatch] {
        var j = 0
        return sessionLaps.map { lap in
            guard let k = chLaps.indices.first(where: { $0 >= j && chLaps[$0].timeMs == lap.timeMs }) else {
                return LapMatch(lap: lap, chIdx: -1)
            }
            j = k + 1
            return LapMatch(lap: lap, chIdx: k)
        }
    }

    /// The channels at least one lap actually recorded, in display order. Empty when
    /// the session stored none — the panel then has nothing to show, which is a
    /// normal state for a natively-recorded session.
    public static func presentChannels(_ channels: SessionChannels) -> [Channel] {
        Channel.allCases.filter { channel in
            channels.laps.contains { (channel.series(of: $0)?.isEmpty == false) }
        }
    }

    /// The fastest lap that has channel data, pre-selected so the panel opens on the
    /// lap you came to look at. Empty when nothing matched.
    public static func initialSelection(_ matches: [LapMatch]) -> [Int] {
        guard let best = matches.filter(\.hasChannels).min(by: { $0.lap.timeMs < $1.lap.timeMs }) else {
            return []
        }
        return [best.chIdx]
    }

    /// Toggle a lap in or out of the highlight slots, evicting the oldest once all
    /// three are taken — so tapping a fourth lap always shows it rather than doing
    /// nothing.
    public static func toggle(_ chIdx: Int, in lit: [Int]) -> [Int] {
        var next = lit
        if let at = next.firstIndex(of: chIdx) {
            next.remove(at: at)
            return next
        }
        next.append(chIdx)
        if next.count > SLOT_COUNT { next.removeFirst() }
        return next
    }

    /// The number of grid points the longest lap recorded for a channel — the
    /// distance axis runs to `(that - 1) × dStepM`.
    public static func gridCount(_ channel: Channel, in channels: SessionChannels) -> Int {
        channels.laps.compactMap { channel.series(of: $0)?.count }.max() ?? 0
    }

    /// How far the shared distance axis runs, in metres.
    public static func distanceSpan(_ channel: Channel, in channels: SessionChannels) -> Double {
        Double(Swift.max(0, gridCount(channel, in: channels) - 1)) * channels.dStepM
    }

    /// The y window for a channel, in **displayed** units, padded by 8% of the range
    /// so the fastest and slowest points don't sit on the frame.
    ///
    /// nil when no lap carries the channel. A channel with one constant value gets a
    /// window anyway — the 1e-6 floor is the JS's, and it keeps a flat lap on a line
    /// rather than dividing by a zero range.
    public static func valueDomain(_ channel: Channel, in channels: SessionChannels, units: UnitSystem) -> (low: Double, high: Double)? {
        var low = Double.infinity
        var high = -Double.infinity
        for lap in channels.laps {
            guard let series = channel.series(of: lap) else { continue }
            for raw in series {
                let v = channel.convert(raw, units)
                low = Swift.min(low, v)
                high = Swift.max(high, v)
            }
        }
        guard low <= high else { return nil }
        if channel.floorAtZero { low = Swift.min(0, low) }
        let pad = Swift.max((high - low) * 0.08, 1e-6)
        return (channel.floorAtZero ? low : low - pad, high + pad)
    }

    /// One lap's value at a grid point, converted — nil when that lap is shorter
    /// than the point, which happens whenever laps differ in driven distance.
    public static func value(
        _ channel: Channel, lapIndex: Int, gridIndex: Int, in channels: SessionChannels, units: UnitSystem
    ) -> Double? {
        guard channels.laps.indices.contains(lapIndex),
              let series = channel.series(of: channels.laps[lapIndex]),
              series.indices.contains(gridIndex)
        else { return nil }
        return channel.convert(series[gridIndex], units)
    }

    /// The grid point nearest a distance in metres, clamped to the axis.
    public static func gridIndex(atDistance metres: Double, _ channel: Channel, in channels: SessionChannels) -> Int {
        guard channels.dStepM > 0 else { return 0 }
        let last = Swift.max(0, gridCount(channel, in: channels) - 1)
        return Swift.min(last, Swift.max(0, Int((metres / channels.dStepM).rounded())))
    }

    // MARK: - The distance axis

    /// "Nice" tick values across a range — `niceNumTicks` in `public/js/chart.js`:
    /// a step of 1, 2, 2.5, 5 or 10 times a power of ten, the smallest that fits
    /// `count` steps, rounded to six decimals like the JS.
    public static func niceNumTicks(_ lo: Double, _ hi: Double, count: Int = 4) -> [Double] {
        let span = Swift.max(1e-9, hi - lo)
        let raw = span / Double(count)
        let pow10 = pow(10.0, floor(log10(raw)))
        let step = [1.0, 2, 2.5, 5, 10].map { $0 * pow10 }.first { $0 >= raw } ?? 10 * pow10
        var ticks: [Double] = []
        var v = ceil(lo / step - 1e-9) * step
        while v <= hi + 1e-9 {
            ticks.append(JSMath.round(v, 1e6))
            v += step
        }
        return ticks
    }

    /// One distance-axis tick: its position in metres, and what it says.
    public struct DistTick: Hashable, Sendable {
        public let m: Double
        public let label: String
    }

    /// Distance-axis ticks for a lap of `x1` metres: nice numbers in the unit the
    /// axis is labelled in — metres, or miles, because nice metre ticks come out
    /// as 0.31, 0.62 mi otherwise. `distAxisTicks` in the JS; the labels are
    /// `Units.fmtDist`'s.
    public static func distAxisTicks(_ x1: Double, _ units: UnitSystem, n: Int = 6) -> [DistTick] {
        if Units.isMetric(units) {
            return niceNumTicks(0, x1, count: n).map { DistTick(m: $0, label: Units.fmtDist($0, units)) }
        }
        return niceNumTicks(0, x1 / Units.M_PER_MI, count: n).map { mi in
            DistTick(m: mi * Units.M_PER_MI, label: Units.fmtDist(mi * Units.M_PER_MI, units))
        }
    }

    // MARK: - Lap delta

    /// A 0 km/h sample would make its grid cell take near-forever; clamp the
    /// cell average to walking pace instead. The end-scale to the timed lap
    /// absorbs the error. `DELTA_MIN_KPH` in the JS.
    public static let DELTA_MIN_KPH: Double = 3

    /// Cumulative elapsed seconds at each grid point (d = 0, dStepM, 2·dStepM…)
    /// from a lap's speed samples (km/h): trapezoidal dt per cell, then scaled
    /// so the last point equals `timeMs / 1000` when a timed duration is given
    /// — the integral alone drifts, and the timer is ground truth.
    ///
    /// `lapTimeSeries` in the JS, pinned by `contracts/logic/lap-delta.json`.
    public static func lapTimeSeries(_ speedKph: [Double], _ dStepM: Double, _ timeMs: Int?) -> [Double] {
        guard !speedKph.isEmpty else { return [] }
        var t = [Double](repeating: 0, count: speedKph.count)
        for k in 1..<speedKph.count {
            let vAvg = Swift.max(DELTA_MIN_KPH, (speedKph[k - 1] + speedKph[k]) / 2) / 3.6 // m/s
            t[k] = t[k - 1] + dStepM / vAvg
        }
        if let timeMs, let total = t.last, total > 0 {
            let scale = Double(timeMs) / 1000 / total
            for k in t.indices { t[k] *= scale }
        }
        return t
    }

    /// Delta seconds (lap − ref, positive = the lap is slower) at each shared
    /// grid point, over the points both laps cover. nil when either lap has no
    /// speed data or the overlap is too short to mean anything.
    ///
    /// `deltaSeries` in the JS, pinned by `contracts/logic/lap-delta.json`.
    public static func deltaSeries(_ lap: LapChannels, _ ref: LapChannels, _ dStepM: Double) -> [Double]? {
        guard let lapSpeed = lap.speed, let refSpeed = ref.speed else { return nil }
        let a = lapTimeSeries(lapSpeed, dStepM, lap.timeMs)
        let b = lapTimeSeries(refSpeed, dStepM, ref.timeMs)
        let n = Swift.min(a.count, b.count)
        guard n >= 10 else { return nil }
        return (0..<n).map { a[$0] - b[$0] }
    }

    /// The reference the delta measures against: the fastest of the highlight
    /// selection. nil until two or more laps are highlighted — a delta of one
    /// lap against itself says nothing.
    public static func deltaReference(_ lit: [Int], in channels: SessionChannels) -> Int? {
        guard lit.count >= 2 else { return nil }
        return lit.min { a, b in
            guard channels.laps.indices.contains(a), channels.laps.indices.contains(b) else { return a < b }
            return channels.laps[a].timeMs < channels.laps[b].timeMs
        }
    }

    /// The y window for a delta chart: always includes zero (the reference lap
    /// *is* the zero line), padded by 8% of the range with the JS's 0.05 s
    /// floor so a near-identical pair of laps still draws a readable band.
    public static func deltaDomain(_ deltas: [[Double]]) -> (low: Double, high: Double)? {
        guard !deltas.isEmpty else { return nil }
        var low = 0.0
        var high = 0.0
        for series in deltas {
            for v in series {
                low = Swift.min(low, v)
                high = Swift.max(high, v)
            }
        }
        let pad = Swift.max((high - low) * 0.08, 0.05)
        return (low - pad, high + pad)
    }
}
