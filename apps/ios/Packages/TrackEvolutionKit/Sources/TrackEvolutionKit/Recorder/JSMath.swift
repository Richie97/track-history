import Foundation

/// JavaScript-compatible rounding. The Swift twin of `JsMath` in
/// `apps/android/core/.../JsMath.kt` — keep the two in step.
///
/// The recorder core and the lap geometry are ports of `public/js/record/core.js`
/// and `public/js/import/geo.js`, both of which round with `Math.round(v * f) / f`.
/// That rounding is part of the wire format, not cosmetic: fix tuples in a
/// checkpoint are shared with the web and Android clients, and lap times are
/// compared against the JS implementation to the millisecond.
///
/// Two traps make a naive port wrong:
///
/// 1. Swift's `rounded()` is half-away-from-zero — `(-1.5).rounded() == -2`.
///    JavaScript's `Math.round` is half-**up toward +infinity**:
///    `Math.round(-1.5) === -1`. Latitude, longitude and the relative clock all
///    cross zero, so this is reachable in real data.
/// 2. `floor(x + 0.5)`, the obvious way to get half-up, is wrong for
///    `0.49999999999999994`: the addition rounds up to exactly 1, so it yields 1
///    where JavaScript yields 0. Testing the fraction for exactly 0.5 instead
///    keeps that case on the nearest-value path.
public enum JSMath {
    /// `Math.round(value * factor) / factor`, matching JavaScript exactly.
    ///
    /// `factor` is the reciprocal of the precision: `100` for two decimal places,
    /// `1e6` for six. Non-finite input is returned unchanged, mirroring JS, where
    /// `Math.round(NaN)` is `NaN` and the division propagates it.
    public static func round(_ value: Double, _ factor: Double) -> Double {
        guard value.isFinite else { return value }
        let scaled = value * factor
        guard scaled.isFinite else { return value }
        let result = roundHalfUp(scaled) / factor
        // JS `Math.round(-0.5)` is -0, which JSON.stringify writes as 0. Swift
        // would write -0. `result == 0` is true for both zeroes, so this
        // normalizes negative zero and leaves everything else untouched.
        return result == 0 ? 0 : result
    }

    /// Integer milliseconds from seconds — `Math.round(seconds * 1000)`.
    public static func roundToInt(_ value: Double) -> Int? {
        guard value.isFinite else { return nil }
        let rounded = roundHalfUp(value)
        guard rounded >= Double(Int.min), rounded <= Double(Int.max) else { return nil }
        return Int(rounded)
    }

    /// Ties go toward +infinity, everything else to the nearest value.
    private static func roundHalfUp(_ value: Double) -> Double {
        let fraction = value - value.rounded(.down)
        return fraction == 0.5 ? value.rounded(.up) : value.rounded(.toNearestOrAwayFromZero)
    }
}
