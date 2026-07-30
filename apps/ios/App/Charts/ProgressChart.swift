import Charts
import SwiftUI
import TrackEvolutionKit

/// A lap-time series over something — the "am I getting faster?" chart.
///
/// Two callers, one view: the track page plots **best lap per event** against the
/// event dates, and the event page plots **each lap of each session** against its
/// running order. Both are lap times on the y axis with the same inverted reading,
/// so they share the scale, the goal rule and the drag-to-read.
///
/// **Lower plots lower**, so improvement trends downward. That inversion is the
/// whole point, and it lives in `ChartScale` where a test asserts it; this view
/// just matches it.
///
/// Swift Charts rather than a hand-rolled `Canvas`: the web version hand-rolls SVG
/// because it has no build step and no dependencies, which was a constraint, not a
/// preference.
struct ProgressChart: View {
    /// One point. `x` is a plot position — a timestamp on the track page, a lap
    /// ordinal on the event page — and `label` is how it reads in the tooltip.
    ///
    /// Numeric rather than categorical on purpose: two events on the same date, or
    /// two laps with the same time, must stay two points. A categorical x axis
    /// silently merges them.
    struct Point: Identifiable {
        let x: Double
        let label: String
        let ms: Int
        var id: Double { x }
    }

    enum Style {
        /// The full chart: axes, goal rule, drag-to-read.
        case full
        /// The dashboard card's 44pt trend line — no axes, no interaction.
        case sparkline
    }

    let points: [Point]
    /// The target lap time, drawn as a rule when there is one. Ignored by sparklines.
    var goalMs: Int?
    var style: Style = .full
    /// What the axis labels say, given a plot position. Defaults to the nearest
    /// point's own label.
    var xLabel: ((Double) -> String)?
    /// What VoiceOver counts — "events" or "laps".
    var unit = "events"

    @State private var selected: Point?

    var body: some View {
        if points.isEmpty {
            if style == .full {
                Text("No lap times here yet.")
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))
            }
        } else {
            chart
        }
    }

    private var domain: (low: Double, high: Double) {
        // The goal belongs inside the axis, or a goal faster than every lap would
        // sit off the bottom of the plot.
        let values = points.map(\.ms) + [style == .full ? goalMs : nil].compactMap { $0 }
        return ChartScale.lapTimeDomain(values) ?? (0, 1)
    }

    /// The x axis has to be pinned to the data.
    ///
    /// Left automatic, Swift Charts anchors a numeric domain at zero — and when x is
    /// a Unix timestamp that means the axis starts in **1970**, labelled with dates
    /// decades before the app existed, while every real point is crushed into a
    /// vertical line at the right edge. A season's progress read as a straight drop.
    private var xDomain: ClosedRange<Double> {
        let xs = points.map(\.x)
        guard let low = xs.min(), let high = xs.max() else { return 0...1 }
        // A single point has no range; give it one so it lands in the middle.
        guard high > low else { return (low - 1)...(low + 1) }
        let pad = (high - low) * 0.04
        return (low - pad)...(high + pad)
    }

    private var chart: some View {
        Chart {
            ForEach(points) { point in
                LineMark(x: .value("Position", point.x), y: .value("Lap", point.ms))
                    .foregroundStyle(Color(.chartLine))
                    .interpolationMethod(.monotone)
                if style == .full {
                    PointMark(x: .value("Position", point.x), y: .value("Lap", point.ms))
                        .foregroundStyle(Color(.chartLine))
                        .symbolSize(selected?.id == point.id ? 90 : 40)
                }
            }
            if style == .full, let goalMs {
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
        .chartXScale(domain: xDomain)
        .modifier(ChartChrome(style: style, points: points, xLabel: xLabel))
        .foregroundStyle(Color(.textMuted))
        .modifier(ReadOutGesture(style: style, points: points, selected: $selected))
        .frame(height: style == .full ? 200 : 44)
        .overlay(alignment: .topTrailing) {
            if let selected {
                Text("\(selected.label) · \(LapTime.fmtMs(selected.ms))")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textStrong))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color(.surfaceRaised), in: .capsule)
            }
        }
        // A chart that's only visual is incomplete.
        .accessibilityElement()
        .accessibilityLabel(style == .full ? "Lap times over \(unit)" : "Trend of best laps")
        .accessibilityValue(Self.trendSummary(points, unit: unit))
    }

    /// What VoiceOver reads: the trend, not the pixels.
    static func trendSummary(_ points: [Point], unit: String = "events") -> String {
        guard let first = points.first, let last = points.last else { return "No data" }
        guard points.count > 1 else { return "One \(unit.dropLast()), best lap \(LapTime.fmtMs(first.ms))" }
        let delta = last.ms - first.ms
        let direction = delta < 0 ? "faster" : delta > 0 ? "slower" : "unchanged"
        return """
            \(points.count) \(unit), from \(LapTime.fmtMs(first.ms)) to \
            \(LapTime.fmtMs(last.ms)) — \(LapTime.fmtDelta(abs(delta))) \(direction)
            """
    }
}

/// Axes and grid, or none at all for a sparkline.
private struct ChartChrome: ViewModifier {
    let style: ProgressChart.Style
    let points: [ProgressChart.Point]
    let xLabel: ((Double) -> String)?

    func body(content: Content) -> some View {
        switch style {
        case .sparkline:
            content.chartXAxis(.hidden).chartYAxis(.hidden)
        case .full:
            content
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
                    // Four labels at most: the axis is a reference, and a label per
                    // event turns into overlapping mush by the fifth track day.
                    AxisMarks(values: .automatic(desiredCount: 4)) { value in
                        AxisGridLine().foregroundStyle(Color(.chartGrid))
                        AxisValueLabel {
                            if let x = value.as(Double.self) {
                                Text(label(for: x)).teStyle(.xxs)
                            }
                        }
                    }
                }
        }
    }

    /// The caller's formatter, or the nearest point's own label.
    private func label(for x: Double) -> String {
        if let xLabel { return xLabel(x) }
        return points.min(by: { abs($0.x - x) < abs($1.x - x) })?.label ?? ""
    }
}

/// Drag to read a value off the line, with a detent per point — this is where
/// native earns its keep over the web chart. Sparklines get none of it.
private struct ReadOutGesture: ViewModifier {
    let style: ProgressChart.Style
    let points: [ProgressChart.Point]
    @Binding var selected: ProgressChart.Point?

    func body(content: Content) -> some View {
        if style == .sparkline {
            content
        } else {
            content.chartOverlay { proxy in
                GeometryReader { geometry in
                    Rectangle().fill(.clear).contentShape(.rect)
                        .gesture(
                            DragGesture(minimumDistance: 0)
                                .onChanged { drag in
                                    guard let plotFrame = proxy.plotFrame else { return }
                                    let x = drag.location.x - geometry[plotFrame].origin.x
                                    guard let position: Double = proxy.value(atX: x),
                                          let hit = points.min(by: {
                                              abs($0.x - position) < abs($1.x - position)
                                          })
                                    else { return }
                                    if hit.id != selected?.id { Haptics.select() }
                                    selected = hit
                                }
                                .onEnded { _ in selected = nil }
                        )
                }
            }
        }
    }
}
