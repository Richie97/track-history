import Charts
import SwiftUI
import TrackEvolutionKit

/// Best lap per event over time — the "am I getting faster?" chart.
///
/// **Lower plots lower**, so improvement trends downward. That inversion is the
/// whole point, and it lives in `ChartScale` where a test asserts it; this view
/// just reverses the y-scale to match.
///
/// Swift Charts rather than a hand-rolled `Canvas`: the web version hand-rolls SVG
/// because it has no build step and no dependencies, which was a constraint, not a
/// preference.
struct ProgressChart: View {
    /// A point per event: the date it happened and the best lap set there.
    struct Point: Identifiable {
        let date: String
        let bestMs: Int
        var id: String { date }
    }

    let points: [Point]
    /// The target lap time, drawn as a rule when there is one.
    var goalMs: Int?

    @State private var selected: Point?

    var body: some View {
        if points.isEmpty {
            Text("No lap times here yet.")
                .teStyle(.sm)
                .foregroundStyle(Color(.textMuted))
        } else {
            chart
        }
    }

    private var domain: (low: Double, high: Double) {
        // The goal belongs inside the axis, or a goal faster than every lap would
        // sit off the bottom of the plot.
        let values = points.map(\.bestMs) + [goalMs].compactMap { $0 }
        return ChartScale.lapTimeDomain(values) ?? (0, 1)
    }

    private var chart: some View {
        Chart {
            ForEach(points) { point in
                LineMark(x: .value("Date", point.date), y: .value("Best lap", point.bestMs))
                    .foregroundStyle(Color(.chartLine))
                    .interpolationMethod(.monotone)
                PointMark(x: .value("Date", point.date), y: .value("Best lap", point.bestMs))
                    .foregroundStyle(Color(.chartLine))
                    .symbolSize(selected?.id == point.id ? 90 : 40)
            }
            if let goalMs {
                RuleMark(y: .value("Goal", goalMs))
                    .foregroundStyle(Color(.accentRing))
                    .lineStyle(.init(lineWidth: 1, dash: [4, 3]))
                    .annotation(position: .top, alignment: .leading) {
                        Text("Goal \(LapTime.fmtMs(goalMs))")
                            .teStyle(.xxs)
                            .foregroundStyle(Color(.textFaint))
                    }
            }
        }
        // Lower lap times plot lower, so improvement trends downward.
        //
        // Swift Charts' default orientation already does this — the domain minimum
        // sits at the bottom — so the correct code is *no* reversal. The web chart
        // has to invert explicitly only because SVG's y axis grows downward, and
        // carrying that inversion across is how this chart ends up telling the
        // opposite story. It did, until a screenshot showed the line rising while
        // the times fell; `ChartScaleTests` can't catch it, because the bug lives in
        // the modifier rather than the maths.
        .chartYScale(domain: domain.low...domain.high)
        .chartYAxis {
            AxisMarks { value in
                AxisGridLine().foregroundStyle(Color(.chartGrid))
                AxisValueLabel {
                    if let ms = value.as(Double.self) {
                        Text(LapTime.fmtMs(Int(ms)))
                            .teStyle(.xxs)
                    }
                }
            }
        }
        .chartXAxis {
            AxisMarks { _ in
                AxisGridLine().foregroundStyle(Color(.chartGrid))
                AxisValueLabel().font(.caption2)
            }
        }
        .foregroundStyle(Color(.textMuted))
        .chartOverlay { proxy in
            // Drag to read a value off the line, with a detent per point — this is
            // where native earns its keep over the web chart.
            GeometryReader { geometry in
                Rectangle().fill(.clear).contentShape(.rect)
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { drag in
                                guard let plotFrame = proxy.plotFrame else { return }
                                let x = drag.location.x - geometry[plotFrame].origin.x
                                guard let date: String = proxy.value(atX: x),
                                      let hit = points.first(where: { $0.date == date })
                                else { return }
                                if hit.id != selected?.id { Haptics.select() }
                                selected = hit
                            }
                            .onEnded { _ in selected = nil }
                    )
            }
        }
        .frame(height: 200)
        .overlay(alignment: .topTrailing) {
            if let selected {
                Text("\(selected.date) · \(LapTime.fmtMs(selected.bestMs))")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textStrong))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color(.surfaceRaised), in: .capsule)
            }
        }
        // A chart that's only visual is incomplete.
        .accessibilityElement()
        .accessibilityLabel("Best lap per event")
        .accessibilityValue(Self.trendSummary(points))
    }

    /// What VoiceOver reads: the trend, not the pixels.
    static func trendSummary(_ points: [Point]) -> String {
        guard let first = points.first, let last = points.last else { return "No data" }
        guard points.count > 1 else { return "One event, best lap \(LapTime.fmtMs(first.bestMs))" }
        let delta = last.bestMs - first.bestMs
        let direction = delta < 0 ? "faster" : delta > 0 ? "slower" : "unchanged"
        return """
            \(points.count) events, from \(LapTime.fmtMs(first.bestMs)) to \
            \(LapTime.fmtMs(last.bestMs)) — \(LapTime.fmtDelta(abs(delta))) \(direction)
            """
    }
}
