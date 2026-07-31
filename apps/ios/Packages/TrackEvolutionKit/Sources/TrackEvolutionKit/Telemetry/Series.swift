import Foundation

/// One sample of a telemetry channel: a value on the recording's own clock.
///
/// `{t, v}` in the JS, which is how every channel — the odometer, latitude,
/// speed, RPM — is carried between `pdr.js`, `pdr-laps.js` and `channels.js`.
public struct ChannelPoint: Hashable, Sendable, Codable {
    /// Seconds on the recording's clock.
    public var t: Double
    /// Raw or scaled value, depending on which channel this is.
    public var v: Double

    public init(t: Double, v: Double) {
        self.t = t
        self.v = v
    }
}

/// Interpolating accessor over a sorted `[{t, v}]` series.
///
/// A port of `series()` in `public/pdr.js`, with its test cases
/// (`test/unit/pdr.test.js`). Everything downstream of the PDR decoder is built
/// on it: lap boundaries are odometer *distances* converted back to times, and
/// per-lap channel arrays are cut on a distance grid — both of which are this
/// type's `at` / `timeAt` pair.
///
/// The binary search is the JS's, including `Math.max(1, lo)`: an index of 0
/// would make `arr[i - 1]` a negative subscript, so a query at or below the
/// first sample deliberately interpolates over the *first* interval rather than
/// clamping. Do not "fix" that — the lap maths depends on the extrapolation.
public struct Series: Sendable {
    public let arr: [ChannelPoint]

    /// `series(arr)` in the JS. The array must already be sorted by `t`, which is
    /// what every caller hands it.
    public init(_ arr: [ChannelPoint]) {
        self.arr = arr
    }

    public var n: Int { arr.count }
    public var first: ChannelPoint { arr[0] }
    public var last: ChannelPoint { arr[arr.count - 1] }

    private func idx(_ key: Double, _ get: (ChannelPoint) -> Double) -> Int {
        var lo = 0
        var hi = arr.count - 1
        while lo < hi {
            let m = (lo + hi) >> 1
            if get(arr[m]) < key { lo = m + 1 } else { hi = m }
        }
        return Swift.max(1, lo)
    }

    /// The value at a time, linearly interpolated.
    public func at(_ t: Double) -> Double {
        let i = idx(t) { $0.t }
        let a = arr[i - 1]
        let b = arr[i]
        return b.t == a.t ? a.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t)
    }

    /// The time at a value — assumes `v` is monotonically non-decreasing, which
    /// is true of the one series this is used on: the odometer.
    public func timeAt(_ v: Double) -> Double {
        let i = idx(v) { $0.v }
        let a = arr[i - 1]
        let b = arr[i]
        return b.v == a.v ? a.t : a.t + ((b.t - a.t) * (v - a.v)) / (b.v - a.v)
    }

    /// Central-difference slope at a time — the odometer's rate is speed in m/s.
    public func rate(_ t: Double, _ w: Double = 2) -> Double {
        let a = at(t - w)
        let b = at(t + w)
        return (b - a) / (2 * w)
    }
}

/// `series(arr)`, spelled the way the JS spells it.
///
/// The ports keep their originals' names so the two diff by eye
/// (`docs/specs/native/README.md`), and this one reads at every call site inside
/// the parsers.
public func series(_ arr: [ChannelPoint]) -> Series {
    Series(arr)
}
