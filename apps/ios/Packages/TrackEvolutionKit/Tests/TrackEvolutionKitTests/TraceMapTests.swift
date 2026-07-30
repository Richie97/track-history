import Foundation
import Testing

@testable import TrackEvolutionKit

/// The line picker's geometry: fit a trace to a view, and turn a tap back into the
/// trace index the user meant.
struct TraceMapTests {
    /// A 200 m square loop, one point every 10 m.
    private var square: [Geo.Projected] {
        var points: [Geo.Projected] = []
        var t = 0.0
        for x in stride(from: 0.0, to: 200, by: 10) { points.append(.init(t: t, x: x, y: 0)); t += 1 }
        for y in stride(from: 0.0, to: 200, by: 10) { points.append(.init(t: t, x: 200, y: y)); t += 1 }
        for x in stride(from: 200.0, to: 0, by: -10) { points.append(.init(t: t, x: x, y: 200)); t += 1 }
        for y in stride(from: 200.0, to: 0, by: -10) { points.append(.init(t: t, x: 0, y: y)); t += 1 }
        return points
    }

    @Test func returnsNilForAnEmptyTraceOrAZeroSizedView() {
        #expect(TraceMap(trace: [], width: 300, height: 300) == nil)
        #expect(TraceMap(trace: square, width: 0, height: 300) == nil)
    }

    @Test func centresTheTraceAndKeepsItInsideThePadding() throws {
        let map = try #require(TraceMap(trace: square, width: 300, height: 300, padding: 20))
        // The loop's centre lands in the middle of the view.
        let centre = map.viewPoint(x: 100, y: 100)
        #expect(abs(centre.x - 150) < 0.001)
        #expect(abs(centre.y - 150) < 0.001)

        for point in square {
            let view = map.viewPoint(point)
            #expect(view.x >= 20 - 0.001 && view.x <= 280 + 0.001)
            #expect(view.y >= 20 - 0.001 && view.y <= 280 + 0.001)
        }
    }

    @Test func doesNotStretchTheTrackOnANonSquareView() throws {
        // A wide view must not make a square loop a rectangle: one scale, both axes.
        let map = try #require(TraceMap(trace: square, width: 600, height: 300, padding: 20))
        let corner = map.viewPoint(x: 0, y: 0)
        let opposite = map.viewPoint(x: 200, y: 200)
        #expect(abs(abs(opposite.x - corner.x) - abs(opposite.y - corner.y)) < 0.001)
    }

    @Test func northIsUp() throws {
        let map = try #require(TraceMap(trace: square, width: 300, height: 300))
        // Trace y grows north; view y grows down, so more y means a smaller view y.
        #expect(map.viewPoint(x: 100, y: 200).y < map.viewPoint(x: 100, y: 0).y)
    }

    @Test func mapsAViewPointBackToMetres() throws {
        let map = try #require(TraceMap(trace: square, width: 300, height: 300, padding: 20))
        for point in [(0.0, 0.0), (200.0, 200.0), (50.0, 130.0)] {
            let view = map.viewPoint(x: point.0, y: point.1)
            let back = map.traceCoordinate(viewX: view.x, viewY: view.y)
            #expect(abs(back.x - point.0) < 0.001)
            #expect(abs(back.y - point.1) < 0.001)
        }
    }

    @Test func roundTripsThroughZoomAndPan() throws {
        let map = try #require(
            TraceMap(trace: square, width: 300, height: 300, scale: 2.5, panX: -40, panY: 25)
        )
        let view = map.viewPoint(x: 137, y: 42)
        let back = map.traceCoordinate(viewX: view.x, viewY: view.y)
        #expect(abs(back.x - 137) < 0.001)
        #expect(abs(back.y - 42) < 0.001)
    }

    @Test func aTapPicksTheNearestTraceIndex() throws {
        let map = try #require(TraceMap(trace: square, width: 300, height: 300, padding: 20))
        // Tap exactly on a known point and expect its index back.
        for index in [0, 7, 21, 44, 63] {
            let point = square[index]
            let view = map.viewPoint(point)
            let picked = map.nearestIndex(to: view.x, viewY: view.y, in: square)
            #expect(picked == index)
        }
    }

    @Test func aTapOffTheTracePicksTheClosestPointNotNothing() throws {
        let map = try #require(TraceMap(trace: square, width: 300, height: 300, padding: 20))
        // Well inside the loop, nearest the x=0 edge at y=100: a sloppy tap should
        // still pick a sensible point rather than nothing at all.
        let view = map.viewPoint(x: 30, y: 100)
        let picked = try #require(map.nearestIndex(to: view.x, viewY: view.y, in: square))
        #expect(abs(square[picked].x) < 0.001, "should land on the x=0 edge")
        #expect(abs(square[picked].y - 100) <= 10)
    }

    @Test func zoomingInMagnifiesAroundTheCentre() throws {
        let fitted = try #require(TraceMap(trace: square, width: 300, height: 300, padding: 20))
        let zoomed = try #require(TraceMap(trace: square, width: 300, height: 300, padding: 20, scale: 2))
        let cornerFitted = fitted.viewPoint(x: 0, y: 0)
        let cornerZoomed = zoomed.viewPoint(x: 0, y: 0)
        // Twice as far from the centre at 2×.
        #expect(abs((150 - cornerZoomed.x) - 2 * (150 - cornerFitted.x)) < 0.001)
    }

    /// The picker's whole pipeline, against the fixture the web implementation
    /// generated — so a pick in the app produces the laps the web app produces.
    @Test func thePickedLineYieldsTheSameLapsAsTheWebApp() throws {
        let fixture = try GeoFixture.load()
        let trace = Geo.projectTrace(fixture.input.points)
        let map = try #require(TraceMap(trace: trace, width: 320, height: 320))

        // Tap where the fixture's picked point is drawn: the round trip through the
        // view has to land back on that index.
        let target = trace[fixture.input.pickedIndex]
        let view = map.viewPoint(target)
        let picked = try #require(map.nearestIndex(to: view.x, viewY: view.y, in: trace))
        #expect(picked == fixture.input.pickedIndex)

        let gate = try #require(Geo.buildGate(trace, idx: picked))
        let laps = Geo.deriveLaps(trace, gate: gate)
        #expect(laps.map(\.timeMs) == fixture.expected.laps.map(\.timeMs))
        #expect(laps.allSatisfy { $0.estimated })
    }
}
