import Foundation

/// The channel panel's x-axis and cursor — the port of `public/js/lap-axis.js`
/// under the same names, pinned by `contracts/logic/lap-axis.json`.
///
/// Every stored channel lap is gridded on driven distance, so distance is the
/// axis the traces are kept on. The panel can also lay them out against each
/// lap's own elapsed time (`ChannelGraphs.lapTimeSeries`): overlaid against
/// time, laps drift apart around the track and that drift is the gap; against
/// distance they line up corner for corner, which is why distance is the
/// default.
///
/// The cursor is a place picked on the axis by a tap or a pointer.
/// `axisPlaces` turns it into where each lit lap was at that axis value: its
/// fractional grid index (the read-outs and the chart dots) and its fraction of
/// its own lap (the dot on the track map). The web-only drawing half
/// (`axisFrame`) is not ported.
public enum LapAxis {
    /// What the laps are plotted against. `AXIS_MODES` in the JS.
    public enum Mode: String, CaseIterable, Sendable, Hashable, Codable {
        case distance
        case time
    }

    public static let AXIS_MODES: [Mode] = [.distance, .time]
    public static let DEFAULT_AXIS: Mode = .distance

    /// The step sizes a time axis may tick at, in seconds.
    public static let TIME_TICK_STEPS: [Double] = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300]
    /// About this many ticks across a chart, as the distance axis aims for.
    public static let TIME_TICK_TARGET = 6

    /// The channels the JS reads a distance grid's length from when a lap has no
    /// speed trace, in its order.
    private static func fallbackLength(_ entry: LapChannels) -> Int {
        [entry.throttle, entry.brake, entry.steering, entry.rpm, entry.latG, entry.yaw, entry.gear]
            .map { $0?.count ?? 0 }
            .max() ?? 0
    }

    /// The axis value at each grid point of a stored channel lap. Distance is
    /// `k * dStepM` in metres; time is the lap's elapsed seconds
    /// (`lapTimeSeries`, scaled to the timed lap). A lap with no grid has no
    /// series, and in time a lap with no speed trace has none either.
    public static func lapAxisSeries(_ entry: LapChannels?, _ dStepM: Double, _ mode: Mode) -> [Double]? {
        guard let entry else { return nil }
        if mode == .time {
            guard let speed = entry.speed, speed.count >= 2 else { return nil }
            return ChannelGraphs.lapTimeSeries(speed, dStepM, entry.timeMs)
        }
        let n = entry.speed.map(\.count) ?? fallbackLength(entry)
        guard n >= 2 else { return nil }
        return (0..<n).map { Double($0) * dStepM }
    }

    /// The axis's extent over a session's laps: the largest last value of any
    /// lap's series, 0 when no lap has one.
    public static func axisExtent(_ laps: [LapChannels], _ dStepM: Double, _ mode: Mode) -> Double {
        var x1: Double = 0
        for lap in laps {
            if let xs = lapAxisSeries(lap, dStepM, mode), let last = xs.last, last > x1 { x1 = last }
        }
        return x1
    }

    /// A lap's fractional grid index at an axis value, or nil when the value is
    /// off the lap (before its start or past its end). Both series rise with k,
    /// so it is the interpolating search `VideoSync.gridAtElapsed` uses for a
    /// clock.
    public static func gridAtAxis(_ xs: [Double]?, _ x: Double?) -> Double? {
        guard let xs, xs.count >= 2, let x, x.isFinite else { return nil }
        if x < xs[0] || x > xs[xs.count - 1] { return nil }
        return VideoSync.gridAtElapsed(xs, x)
    }

    /// The other way: the axis value at a fractional grid index, clamped.
    public static func axisAtGrid(_ xs: [Double]?, _ k: Double?) -> Double? {
        guard let xs, !xs.isEmpty, let k, k.isFinite else { return nil }
        let last = xs.count - 1
        let kk = Swift.max(0, Swift.min(Double(last), k))
        let i0 = Int(kk.rounded(.down))
        if i0 >= last { return xs[last] }
        return xs[i0] + (xs[i0 + 1] - xs[i0]) * (kk - Double(i0))
    }

    /// Where one lap was at an axis value.
    public struct Place: Sendable, Hashable {
        /// The lap's index into the session's channel laps.
        public let chIdx: Int
        /// Its fractional grid index there.
        public let k: Double
        /// `k` over the lap's own last grid index — how far round the lap, 0…1.
        public let frac: Double

        public init(chIdx: Int, k: Double, frac: Double) {
            self.chIdx = chIdx
            self.k = k
            self.frac = frac
        }
    }

    /// Where each lap in `lapIdxs` (indexes into `laps`, in the caller's order)
    /// was at axis value x. A lap the value is off is left out.
    public static func axisPlaces(
        _ laps: [LapChannels], _ dStepM: Double, _ mode: Mode, _ x: Double?, _ lapIdxs: [Int]
    ) -> [Place] {
        var out: [Place] = []
        for chIdx in lapIdxs {
            let entry = laps.indices.contains(chIdx) ? laps[chIdx] : nil
            guard let xs = lapAxisSeries(entry, dStepM, mode), let k = gridAtAxis(xs, x) else { continue }
            out.append(Place(chIdx: chIdx, k: k, frac: k / Double(xs.count - 1)))
        }
        return out
    }

    /// m:ss for a time-axis tick; ticks land on whole seconds.
    public static func fmtAxisSeconds(_ s: Double) -> String {
        let whole = JSMath.roundToInt(s) ?? 0
        let minutes = Int((Double(whole) / 60).rounded(.down))
        let seconds = whole % 60
        return "\(minutes):\(seconds < 10 ? "0" : "")\(seconds)"
    }

    /// One time-axis tick: where, in seconds, and what it says.
    public struct TimeTick: Sendable, Hashable {
        public let s: Double
        public let label: String
    }

    /// Ticks for a time axis from 0 to x1 seconds: the smallest step in
    /// `TIME_TICK_STEPS` that keeps the count at or under `TIME_TICK_TARGET`,
    /// the largest step otherwise.
    public static func timeAxisTicks(_ x1: Double) -> [TimeTick] {
        guard x1.isFinite, x1 > 0 else { return [] }
        let step = TIME_TICK_STEPS.first { x1 / $0 <= Double(TIME_TICK_TARGET) } ?? TIME_TICK_STEPS[TIME_TICK_STEPS.count - 1]
        var out: [TimeTick] = []
        var s: Double = 0
        while s <= x1 + 1e-9 {
            out.append(TimeTick(s: s, label: fmtAxisSeconds(s)))
            s += step
        }
        return out
    }

    /// The cursor's place as the read-out says it: a distance in the user's
    /// units, or the elapsed time to a tenth (m:ss.s).
    public static func fmtAxisValue(_ x: Double?, _ mode: Mode, _ units: UnitSystem) -> String {
        guard let x, x.isFinite else { return "—" }
        if mode != .time { return Units.fmtDist(Double(JSMath.roundToInt(x) ?? 0), units) }
        let tenths = JSMath.roundToInt(Swift.max(0, x) * 10) ?? 0
        let sec = Double(tenths % 600) / 10
        let minutes = Int((Double(tenths) / 600).rounded(.down))
        return "\(minutes):\(sec < 10 ? "0" : "")\(Units.toFixed(sec, 1))"
    }

    /// The axis's name in a chart's title and label ("by distance" / "by time").
    public static func axisWord(_ mode: Mode) -> String {
        mode == .time ? "time" : "distance"
    }
}
