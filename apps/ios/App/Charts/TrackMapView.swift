import SwiftUI
import TrackEvolutionKit
import UIKit

/// The best lap's racing line, painted by speed.
///
/// Hand-rolled on `Canvas` because Swift Charts has no good primitive for a
/// polyline colored per-segment along a ramp. The geometry comes from `TraceMap`
/// (Kit, unit-tested); the colors come from the `mapSlow` → `mapFast` tokens, which
/// are generated from `style.css` — no hex here, and the ramp differs by hue
/// between themes, so hardcoding would break one of them.
struct TrackMapView: View {
    let trace: [TracePoint]
    /// Read so the ramp is rebuilt when the theme flips — the two endpoint tokens
    /// differ by hue between light and dark, not just lightness.
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        GeometryReader { geometry in
            Canvas { context, size in
                guard trace.count > 1,
                      let map = TraceMap(
                          trace: trace.map { Geo.Projected(t: 0, x: $0.x, y: $0.y) },
                          width: size.width,
                          height: size.height,
                          padding: 12
                      ),
                      let speeds = ChartScale.speedRange(trace)
                else { return }

                // The tarmac underneath: one flat stroke, so the speed ramp reads as
                // paint on a surface rather than as a floating line.
                var base = Path()
                for (i, point) in trace.enumerated() {
                    let view = map.viewPoint(x: point.x, y: point.y)
                    let cg = CGPoint(x: view.x, y: view.y)
                    if i == 0 { base.move(to: cg) } else { base.addLine(to: cg) }
                }
                context.stroke(base, with: .color(Color(.mapTarmac)), style: .init(lineWidth: 7, lineCap: .round))

                // Then a segment per pair, colored by the speed at its start.
                for i in 1..<trace.count {
                    let from = map.viewPoint(x: trace[i - 1].x, y: trace[i - 1].y)
                    let to = map.viewPoint(x: trace[i].x, y: trace[i].y)
                    var segment = Path()
                    segment.move(to: CGPoint(x: from.x, y: from.y))
                    segment.addLine(to: CGPoint(x: to.x, y: to.y))
                    let fraction = ChartScale.speedFraction(
                        trace[i - 1].v, slowest: speeds.slowest, fastest: speeds.fastest
                    )
                    context.stroke(
                        segment,
                        with: .color(rampColor(fraction)),
                        style: .init(lineWidth: 4, lineCap: .round)
                    )
                }
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Racing line, coloured by speed")
        .accessibilityValue(Self.summary(trace))
    }

    /// A point on the slow→fast ramp. `Color.mix` would do this in one line, but
    /// it's iOS 18 and the deployment target is 17 — so the tokens are resolved for
    /// the current theme and interpolated by hand.
    private func rampColor(_ fraction: Double) -> Color {
        let traits = UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light)
        let slow = UIColor(resource: .mapSlow).resolvedColor(with: traits)
        let fast = UIColor(resource: .mapFast).resolvedColor(with: traits)

        var (r1, g1, b1, a1): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        var (r2, g2, b2, a2): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        slow.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        fast.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)

        let t = CGFloat(fraction)
        return Color(
            .sRGB,
            red: r1 + (r2 - r1) * t,
            green: g1 + (g2 - g1) * t,
            blue: b1 + (b2 - b1) * t,
            opacity: a1 + (a2 - a1) * t
        )
    }

    static func summary(_ trace: [TracePoint]) -> String {
        guard let speeds = ChartScale.speedRange(trace) else { return "No trace" }
        return String(
            format: "%d points, %.0f to %.0f mph",
            trace.count, speeds.slowest * 2.236936, speeds.fastest * 2.236936
        )
    }
}
