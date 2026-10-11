import Foundation

/// Per-session lap analysis: representative pace, how long it took to get up to
/// speed, and whether pace faded late.
///
/// A port of `public/js/lap-stats.js` — same function names, same defaults, and
/// that file's test cases come with it (`LapStatsTests`).
///
/// Inputs are lap times in integer milliseconds **in running order**; the order is
/// load-bearing for `paceSlope` and `warmupLapCount`.
///
/// Note the name clash with `OfflineMirrors.cleanLaps`, which is a different
/// function from a different JS file (`sanitizeLaps` in `src/lib/validate.ts`).
/// Both keep their original's name, which is why they live in separate namespaces.
public enum LapStats {
    /// A lap within this factor of its session's best is "clean" — the F1 107% rule.
    /// `CLEAN_FACTOR` in `lap-stats.js` and `src/lib/stats.ts`.
    public static let CLEAN_FACTOR = 1.07

    /// Consistency needs this many clean laps (NS-42).
    public static let MIN_CONSISTENCY_LAPS = 3

    /// Laps within `factor` of the session best. Filters out-laps, cool-downs and
    /// heavy traffic the same way the F1 107% rule separates representative pace.
    public static func cleanLaps(_ laps: [Int], factor: Double = LapStats.CLEAN_FACTOR) -> [Int] {
        guard let best = laps.min() else { return [] }
        return laps.filter { Double($0) <= Double(best) * factor }
    }

    /// Average of the best n laps; nil when there are fewer than n.
    public static func bestNAvg(_ laps: [Int], _ n: Int = 3) -> Double? {
        guard laps.count >= n, n > 0 else { return nil }
        let sorted = laps.sorted().prefix(n)
        return Double(sorted.reduce(0, +)) / Double(n)
    }

    /// Least-squares slope of clean laps in ms per lap. Positive = getting slower
    /// through the session (tires/driver going off), negative = still improving.
    /// nil with fewer than 4 clean laps — a trend over less isn't meaningful.
    public static func paceSlope(_ laps: [Int], factor: Double = LapStats.CLEAN_FACTOR) -> Double? {
        let clean = cleanLaps(laps, factor: factor)
        let n = clean.count
        guard n >= 4 else { return nil }
        let meanX = Double(n - 1) / 2
        let meanY = Double(clean.reduce(0, +)) / Double(n)
        var num = 0.0
        var den = 0.0
        for (x, y) in clean.enumerated() {
            num += (Double(x) - meanX) * (Double(y) - meanY)
            den += (Double(x) - meanX) * (Double(x) - meanX)
        }
        return num / den
    }

    /// 1-based index of the first lap within `pct` of the session best — how long
    /// it took to get up to speed. nil with fewer than 2 laps.
    public static func warmupLapCount(_ laps: [Int], pct: Double = 0.01) -> Int? {
        guard laps.count >= 2, let best = laps.min() else { return nil }
        guard let idx = laps.firstIndex(where: { Double($0) <= Double(best) * (1 + pct) }) else {
            return nil
        }
        return idx + 1
    }

    /// An event's consistency (NS-42): the coefficient of variation (population
    /// stdev ÷ mean) of its clean laps, each session's laps judged against that
    /// session's own best. One array of lap times per session; nil under
    /// `MIN_CONSISTENCY_LAPS` clean laps.
    ///
    /// Computed as mean of squares minus squared mean — the server's arithmetic
    /// over its SQL aggregates — because `OfflineMirrors.recomputeDetail` is
    /// checked against the server's figure to 1e-12. Pinned by
    /// `contracts/logic/consistency.json`.
    public static func eventConsistency(_ sessionLaps: [[Int]]) -> Double? {
        let clean = sessionLaps.flatMap { cleanLaps($0) }
        guard clean.count >= MIN_CONSISTENCY_LAPS else { return nil }
        let n = Double(clean.count)
        let mean = clean.reduce(0.0) { $0 + Double($1) } / n
        let meanOfSquares = clean.reduce(0.0) { $0 + Double($1) * Double($1) } / n
        let variance = max(0, meanOfSquares - mean * mean)
        return variance.squareRoot() / mean
    }
}
