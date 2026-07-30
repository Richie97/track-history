import Foundation

/// Lap-time formatting and parsing. A port of `public/js/format.js` — same
/// function names, same behavior, and the test cases from
/// `test/unit/format.test.js` come with it (`LapTimeTests`).
///
/// Lap times are integer milliseconds everywhere in this app; never model them
/// as `TimeInterval`.
public enum LapTime {
    /// ms → "2:01.24" (trailing zeros trimmed, at least one decimal), nil → "—".
    public static func fmtMs(_ ms: Int?) -> String {
        guard let ms else { return "—" }
        let m = ms / 60_000
        let s = (ms % 60_000) / 1000
        var frac = String(format: "%03d", ms % 1000)
        while frac.hasSuffix("0") { frac.removeLast() }
        if frac.isEmpty { frac = "0" }
        return "\(m):\(String(format: "%02d", s)).\(frac)"
    }

    /// Fractional-millisecond overload, rounding first like the JS `Math.round`.
    /// (Sources that measure sub-millisecond, e.g. a GPS-derived lap.)
    public static func fmtMs(_ ms: Double?) -> String {
        guard let ms, ms.isFinite else { return "—" }
        return fmtMs(Int(ms.rounded(.toNearestOrAwayFromZero)))
    }

    // Same two patterns as `parseTime` in public/js/format.js. Computed rather
    // than stored because `Regex` isn't `Sendable`, and these are cheap next to
    // the user typing the string.
    private static var clockRegex: Regex<(Substring, Substring, Substring, Substring?)> {
        #/^(\d+):(\d{1,2})(?:[.,](\d{1,3}))?$/#
    }
    private static var secondsRegex: Regex<(Substring, Substring, Substring?)> {
        #/^(\d+)(?:[.,](\d{1,3}))?$/#
    }

    /// "2:01.24" | "121.24" | "2:01" → ms. nil when unparseable.
    public static func parseTime(_ text: String?) -> Int? {
        let t = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return nil }
        if let m = try? clockRegex.wholeMatch(in: t) {
            guard let minutes = Int(m.1), let seconds = Int(m.2) else { return nil }
            return (minutes * 60 + seconds) * 1000 + fraction(m.3)
        }
        if let m = try? secondsRegex.wholeMatch(in: t) {
            guard let seconds = Int(m.1) else { return nil }
            return seconds * 1000 + fraction(m.2)
        }
        return nil
    }

    /// A whitespace/comma/semicolon-separated list of times → ms, dropping
    /// unparseable and non-positive entries.
    public static func parseLapList(_ text: String?) -> [Int] {
        (text ?? "")
            .split(whereSeparator: { $0.isWhitespace || $0 == "," || $0 == ";" })
            .compactMap { parseTime(String($0)) }
            .filter { $0 > 0 }
    }

    /// Coefficient of variation → "1.2%", nil → "—".
    public static func fmtConsistency(_ cv: Double?) -> String {
        guard let cv else { return "—" }
        return String(format: "%.1f%%", cv * 100)
    }

    /// ms delta → signed seconds: "+1.24s" / "-0.8s" / "0s".
    public static func fmtDelta(_ ms: Int?) -> String {
        guard let ms else { return "—" }
        let s = Double(ms) / 1000
        var abs = String(format: Swift.abs(s) < 10 ? "%.2f" : "%.1f", Swift.abs(s))
        // Trim trailing zeros, and the decimal point if nothing follows it.
        while abs.hasSuffix("0") { abs.removeLast() }
        if abs.hasSuffix(".") { abs.removeLast() }
        if abs.isEmpty { abs = "0" }
        return "\(s > 0 ? "+" : s < 0 ? "-" : "")\(abs)s"
    }

    /// A captured fraction-of-a-second group, right-padded to milliseconds:
    /// "5" → 500, "24" → 240, "999" → 999.
    private static func fraction(_ digits: Substring?) -> Int {
        guard let digits, !digits.isEmpty else { return 0 }
        return Int(digits.padding(toLength: 3, withPad: "0", startingAt: 0)) ?? 0
    }
}
