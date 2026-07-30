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
    /// Laps within `factor` of the session best. Filters out-laps, cool-downs and
    /// heavy traffic the same way the F1 107% rule separates representative pace.
    public static func cleanLaps(_ laps: [Int], factor: Double = 1.07) -> [Int] {
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
    public static func paceSlope(_ laps: [Int], factor: Double = 1.07) -> Double? {
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
}
