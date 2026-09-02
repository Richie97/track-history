import Foundation

/// Sector analysis and the theoretical best lap (#146).
///
/// A port of `public/js/sectors.js` — same function names, same rules, and that
/// file's test cases come with it (`SectorsTests`), pinned against the web
/// implementation's output by `contracts/logic/sectors.json`.
///
/// Every stored channel lap carries a speed series on a driven-distance grid,
/// which is enough to split it into sectors without the driver defining any:
/// each lap is cut into `n` equal slices of *its own* driven distance and the
/// time in each slice is read off the lap's elapsed-time series
/// (`ChannelGraphs.lapTimeSeries`, scaled to the timed lap). Fractions of the
/// lap's own length rather than absolute metres, deliberately — laps differ by a
/// percent or two in driven distance, so fractions keep the same corner in the
/// same sector and make every lap's sectors add up to exactly its lap time. The
/// best of each sector across a session sums to the theoretical best lap; the gap
/// to the actual best is what consistency would have been worth.
public enum Sectors {
    /// Thirds by default. `SECTOR_COUNT` in the JS.
    public static let SECTOR_COUNT = 3

    /// Sector split times, integer milliseconds: `n` equal slices of the lap's own
    /// driven distance. The first `n − 1` sectors are rounded and the last absorbs
    /// the residual so the splits sum exactly to the lap time. nil when there is no
    /// speed series, too few grid points to place a boundary, or `n < 1`.
    ///
    /// `timeMs` is optional only for parity with the JS, whose entries may in theory
    /// lack a duration; a stored `LapChannels` always has one — see the overload.
    public static func sectorTimes(_ speed: [Double]?, _ timeMs: Int?, _ dStepM: Double, _ n: Int = SECTOR_COUNT) -> [Int]? {
        guard let speed, speed.count >= 2, n >= 1 else { return nil }
        let t = ChannelGraphs.lapTimeSeries(speed, dStepM, timeMs)
        let last = speed.count - 1
        let lapMs = timeMs ?? jsRound(t[last] * 1000)
        // Elapsed seconds at a fractional grid position, linearly interpolated.
        func tAt(_ p: Double) -> Double {
            let i = Swift.min(last - 1, Int(p.rounded(.down)))
            return t[i] + (t[i + 1] - t[i]) * (p - Double(i))
        }
        var out = [Int](repeating: 0, count: n)
        var acc = 0
        for k in 0..<(n - 1) {
            let a = tAt(Double(k * last) / Double(n))
            let b = tAt(Double((k + 1) * last) / Double(n))
            let ms = jsRound((b - a) * 1000)
            out[k] = ms
            acc += ms
        }
        out[n - 1] = lapMs - acc
        return out
    }

    /// `sectorTimes` for a stored channel-lap entry.
    public static func sectorTimes(_ entry: LapChannels, _ dStepM: Double, _ n: Int = SECTOR_COUNT) -> [Int]? {
        sectorTimes(entry.speed, entry.timeMs, dStepM, n)
    }

    /// One lap's splits. `chIdx` indexes `SessionChannels.laps`, as in the JS.
    public struct LapSplit: Equatable, Sendable, Decodable {
        public var chIdx: Int
        public var timeMs: Int
        public var sectors: [Int]

        public init(chIdx: Int, timeMs: Int, sectors: [Int]) {
            self.chIdx = chIdx
            self.timeMs = timeMs
            self.sectors = sectors
        }
    }

    /// A session's sector analysis: every lap that could be split, the best of each
    /// sector across them and what those sum to. `bestSectorLap[k]` is the `chIdx`
    /// owning sector k's best — the earliest lap on a tie, matching the JS's strict
    /// `<`. `gapMs` is the actual best lap minus the theoretical best.
    public struct SessionSplits: Equatable, Sendable, Decodable {
        public var n: Int
        public var laps: [LapSplit]
        public var bestSectors: [Int]
        public var bestSectorLap: [Int]
        public var theoreticalBestMs: Int
        public var bestLapMs: Int
        public var bestLapIdx: Int
        public var gapMs: Int
    }

    /// Every lap of a session (or an aligned pair from `CompareLaps.alignLapPair` —
    /// same shape) split into sectors. Laps without a usable speed series are left
    /// out; nil when no lap can be split.
    public static func sessionSectors(_ channels: SessionChannels, _ n: Int = SECTOR_COUNT) -> SessionSplits? {
        var laps: [LapSplit] = []
        for (chIdx, entry) in channels.laps.enumerated() {
            guard let sectors = sectorTimes(entry, channels.dStepM, n) else { continue }
            laps.append(LapSplit(chIdx: chIdx, timeMs: sectors.reduce(0, +), sectors: sectors))
        }
        guard !laps.isEmpty else { return nil }
        var bestSectors = [Int](repeating: 0, count: n)
        var bestSectorLap = [Int](repeating: 0, count: n)
        for k in 0..<n {
            var best = laps[0]
            for lap in laps where lap.sectors[k] < best.sectors[k] { best = lap }
            bestSectors[k] = best.sectors[k]
            bestSectorLap[k] = best.chIdx
        }
        var bestLap = laps[0]
        for lap in laps where lap.timeMs < bestLap.timeMs { bestLap = lap }
        let theoreticalBestMs = bestSectors.reduce(0, +)
        return SessionSplits(
            n: n,
            laps: laps,
            bestSectors: bestSectors,
            bestSectorLap: bestSectorLap,
            theoreticalBestMs: theoreticalBestMs,
            bestLapMs: bestLap.timeMs,
            bestLapIdx: bestLap.chIdx,
            gapMs: bestLap.timeMs - theoreticalBestMs
        )
    }

    /// JavaScript's `Math.round`: half rounds up (toward +∞), unlike Swift's
    /// `.rounded()`, which rounds half away from zero.
    private static func jsRound(_ value: Double) -> Int {
        Int((value + 0.5).rounded(.down))
    }
}
