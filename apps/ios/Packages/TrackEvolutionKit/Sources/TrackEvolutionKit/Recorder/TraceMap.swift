import Foundation

/// Maps a projected trace onto a view rectangle, and back again.
///
/// The start/finish line picker needs both directions: forward to draw the trace,
/// backward to turn a tap into the trace index the user meant. Keeping the maths
/// here — pure, no SwiftUI — is what makes it testable; the view only draws.
///
/// Note the y-flip. Trace coordinates are metres north (`Geo.projectTrace`), so
/// larger y is *up*, while a view's y grows downward.
public struct TraceMap: Hashable, Sendable {
    /// The view rectangle, in points.
    public let width: Double
    public let height: Double
    /// Inset kept clear so the trace doesn't touch the edges.
    public let padding: Double
    /// Bounds of the trace in metres.
    public let minX: Double
    public let maxX: Double
    public let minY: Double
    public let maxY: Double
    /// User zoom, 1 = fitted.
    public let scale: Double
    /// User pan, in points.
    public let panX: Double
    public let panY: Double

    /// Fit `trace` into a `width` × `height` rectangle. nil for an empty trace.
    public init?(
        trace: [Geo.Projected],
        width: Double,
        height: Double,
        padding: Double = 16,
        scale: Double = 1,
        panX: Double = 0,
        panY: Double = 0
    ) {
        guard !trace.isEmpty, width > 0, height > 0 else { return nil }
        self.width = width
        self.height = height
        self.padding = padding
        self.scale = scale
        self.panX = panX
        self.panY = panY
        minX = trace.lazy.map(\.x).min() ?? 0
        maxX = trace.lazy.map(\.x).max() ?? 0
        minY = trace.lazy.map(\.y).min() ?? 0
        maxY = trace.lazy.map(\.y).max() ?? 0
    }

    /// Metres per point before zoom — the same on both axes, so the track isn't
    /// stretched.
    private var metresPerPoint: Double {
        let spanX = max(maxX - minX, 1)
        let spanY = max(maxY - minY, 1)
        let usableWidth = max(width - padding * 2, 1)
        let usableHeight = max(height - padding * 2, 1)
        return max(spanX / usableWidth, spanY / usableHeight)
    }

    /// Where a trace point lands in the view.
    public func viewPoint(x: Double, y: Double) -> (x: Double, y: Double) {
        let unit = metresPerPoint / scale
        let centreX = (minX + maxX) / 2
        let centreY = (minY + maxY) / 2
        return (
            x: width / 2 + (x - centreX) / unit + panX,
            // Flipped: north is up on screen.
            y: height / 2 - (y - centreY) / unit + panY
        )
    }

    public func viewPoint(_ point: Geo.Projected) -> (x: Double, y: Double) {
        viewPoint(x: point.x, y: point.y)
    }

    /// Where a view point lands in the trace's metres.
    public func traceCoordinate(viewX: Double, viewY: Double) -> (x: Double, y: Double) {
        let unit = metresPerPoint / scale
        let centreX = (minX + maxX) / 2
        let centreY = (minY + maxY) / 2
        return (
            x: centreX + (viewX - panX - width / 2) * unit,
            y: centreY - (viewY - panY - height / 2) * unit
        )
    }

    /// The trace index nearest a tap, which is the point the user meant to pick.
    ///
    /// A closed circuit crosses itself, so "nearest in metres" is the honest
    /// answer — there's no single correct index at a crossover and picking either
    /// branch gives the same gate geometry.
    public func nearestIndex(to viewX: Double, viewY: Double, in trace: [Geo.Projected]) -> Int? {
        guard !trace.isEmpty else { return nil }
        let target = traceCoordinate(viewX: viewX, viewY: viewY)
        var best = 0
        var bestDistance = Double.infinity
        for (i, point) in trace.enumerated() {
            let dx = point.x - target.x
            let dy = point.y - target.y
            let distance = dx * dx + dy * dy
            if distance < bestDistance {
                bestDistance = distance
                best = i
            }
        }
        return best
    }

    /// The gate as a pair of view points, for drawing the picked line.
    public func viewSegment(for gate: Geo.Gate) -> (from: (x: Double, y: Double), to: (x: Double, y: Double)) {
        (viewPoint(x: gate.x1, y: gate.y1), viewPoint(x: gate.x2, y: gate.y2))
    }
}
