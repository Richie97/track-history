import Foundation

/// Axis maths for the charts, kept out of the views so the one convention that
/// matters can be asserted in a test.
///
/// **Lower lap times plot lower, so improvement trends downward.** That is
/// inverted from a naive "bigger is up" axis, and it is the entire point of the
/// progress chart: a driver getting faster should see the line fall. Get it
/// backwards and the chart tells the opposite story, convincingly.
public enum ChartScale {
    /// The lap-time domain for a progress chart, as `(low, high)` in
    /// milliseconds — pass it to a chart's y-scale **reversed** so smaller values
    /// sit lower.
    ///
    /// Degenerate inputs are the interesting cases, and the web charts handle them:
    /// a single point, or every value identical, would otherwise give a zero-height
    /// axis and a line drawn on the frame edge.
    public static func lapTimeDomain(_ values: [Int], padding: Double = 0.04) -> (low: Double, high: Double)? {
        guard let min = values.min(), let max = values.max() else { return nil }
        let low = Double(min)
        let high = Double(max)
        guard high > low else {
            // All identical, or a single lap: invent a symmetric window so the point
            // lands in the middle instead of on an edge.
            let margin = Swift.max(low * 0.01, 500)
            return (low - margin, high + margin)
        }
        let margin = (high - low) * padding
        return (low - margin, high + margin)
    }

    /// Where a value sits in `0...1` **as drawn** — 0 at the bottom of the plot.
    ///
    /// This is the inversion, in one place: a *faster* lap (a smaller number) gets a
    /// smaller fraction, so it is drawn lower.
    public static func plottedFraction(_ value: Double, in domain: (low: Double, high: Double)) -> Double {
        let span = domain.high - domain.low
        guard span > 0 else { return 0.5 }
        return ((value - domain.low) / span).clamped()
    }

    /// Position along the speed ramp for the trackmap, `0` = slowest.
    ///
    /// A constant-speed lap has no range to ramp over, so it sits at the fast end
    /// rather than dividing by zero.
    public static func speedFraction(_ speed: Double, slowest: Double, fastest: Double) -> Double {
        guard fastest > slowest else { return 1 }
        return ((speed - slowest) / (fastest - slowest)).clamped()
    }

    /// The slowest and fastest speeds in a trace, for the ramp's ends.
    public static func speedRange(_ trace: [TracePoint]) -> (slowest: Double, fastest: Double)? {
        guard let slowest = trace.map(\.v).min(), let fastest = trace.map(\.v).max() else { return nil }
        return (slowest, fastest)
    }
}

extension Double {
    fileprivate func clamped() -> Double { Swift.min(1, Swift.max(0, self)) }
}
