import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cases from `test/unit/geo.test.js`, ported with the code, plus the
/// cross-language fixture that pins this implementation to the JS one.
struct GeoTests {
    // MARK: - projectTrace

    @Test func projectsToMetersRelativeToTheOrigin() {
        let trace = Geo.projectTrace([
            Geo.Point(t: 0, lat: 36.56, lon: -79.2),
            Geo.Point(t: 1, lat: 36.561, lon: -79.2)
        ])
        #expect(trace[0].x == 0)
        #expect(trace[0].y == 0)
        // 0.001° of latitude ≈ 110.5 m.
        #expect(abs(trace[1].y - 110.54) < 0.05)
        #expect(trace[1].x == 0)
    }

    @Test func usesASharedOriginSoGatesTransferBetweenTraces() {
        let origin = Geo.Origin(lat: 36.56, lon: -79.2)
        let point = Geo.Point(t: 0, lat: 36.561, lon: -79.2)
        let a = Geo.projectTrace([point], origin: origin)
        let b = Geo.projectTrace([point], origin: origin)
        #expect(a[0] == b[0])
    }

    // MARK: - Lap derivation on the circular trace

    @Test func derivesOneLapPerRevolutionAcrossAPickedPoint() throws {
        let fixture = try GeoFixture.load()
        let trace = Geo.projectTrace(fixture.input.points)
        let gate = try #require(Geo.buildGate(trace, idx: fixture.input.pickedIndex))
        let laps = Geo.deriveLaps(trace, gate: gate)

        #expect(laps.count == 3)
        let lapMs = Int((fixture.input.lapS * 1000).rounded())
        for lap in laps {
            #expect(abs(lap.timeMs - lapMs) < 200)
            #expect(lap.estimated)
        }
    }

    @Test func derivesTheSameLapsFromAnExplicitTwoPointGate() throws {
        let fixture = try GeoFixture.load()
        let trace = Geo.projectTrace(fixture.input.points)
        let picked = try #require(Geo.buildGate(trace, idx: fixture.input.pickedIndex))
        let gate = Geo.gateFromSegment((x: picked.x1, y: picked.y1), (x: picked.x2, y: picked.y2))
        #expect(Geo.deriveLaps(trace, gate: gate).count == 3)
    }

    // MARK: - gateCrossings direction filter

    /// Straight out-and-back: crosses y=0 northbound at t=10, southbound at t=110.
    private var outAndBack: [Geo.Projected] {
        var trace = (0...20).map { Geo.Projected(t: Double($0), x: 0, y: Double($0 - 10) * 10) }
        trace += (1...20).map { Geo.Projected(t: Double(100 + $0), x: 0, y: Double(10 - $0) * 10) }
        return trace
    }

    @Test func countsOnlyCrossingsInTheGatesDirectionOfTravel() throws {
        let trace = outAndBack
        // Heading north at the crossing.
        let gate = try #require(Geo.buildGate(trace, idx: 10))
        #expect(Geo.gateCrossings(trace, gate: gate) == [10])
    }

    @Test func countsBothDirectionsForHeadinglessGates() {
        let gate = Geo.gateFromSegment((x: -20, y: 0), (x: 20, y: 0))
        #expect(Geo.gateCrossings(outAndBack, gate: gate) == [10, 110])
    }

    @Test func treatsNearSimultaneousCrossingsAsJitter() {
        let jitter = [
            Geo.Projected(t: 0, x: 0, y: -5),
            Geo.Projected(t: 1, x: 0, y: 5),   // crossing ~0.5
            Geo.Projected(t: 2, x: 0, y: -5),  // jitter back
            Geo.Projected(t: 3, x: 0, y: 5)    // crossing ~2.5, within minGapS
        ]
        let gate = Geo.gateFromSegment((x: -20, y: 0), (x: 20, y: 0))
        #expect(Geo.gateCrossings(jitter, gate: gate).count == 1)
    }

    @Test func buildGateReturnsNilWhenTheCarIsNotMoving() {
        // Parked: no window width yields 2 m of displacement.
        let parked = (0...60).map { Geo.Projected(t: Double($0), x: 0, y: 0) }
        #expect(Geo.buildGate(parked, idx: 30) == nil)
    }

    @Test func buildGateWidensItsWindowForASlowCornerPick() throws {
        // 0.05 m per 0.1 s ≈ 0.5 m/s: the ±3-sample window spans 0.3 m, so the
        // gate only exists because the window widens to ±24.
        let crawling = (0...120).map { Geo.Projected(t: Double($0) * 0.1, x: Double($0) * 0.05, y: 0) }
        let gate = try #require(Geo.buildGate(crawling, idx: 60))
        // Travelling +x, so the gate runs along y.
        let (heading, drift) = (try #require(gate.hx), try #require(gate.hy))
        #expect(abs(heading - 1) < 1e-9)
        #expect(abs(drift) < 1e-9)
        #expect(abs(abs(gate.y2 - gate.y1) - 40) < 1e-9, "half-width 20 either side")
    }

    // MARK: - lapsFromCrossings

    @Test func dropsDeltasThatCannotBeLaps() {
        // 10s (jitter), 47s (lap), 2h gap (parked), 47s (lap)
        let laps = Geo.lapsFromCrossings([0, 10, 57, 7257, 7304])
        #expect(laps.map(\.timeMs) == [47_000, 47_000])
    }

    // MARK: - lapTrace

    @Test func slicesTheWindowAndKeepsXYVTriples() throws {
        let fixture = try GeoFixture.load()
        let trace = Geo.projectTrace(fixture.input.points)
        let out = try #require(Geo.lapTrace(trace, from: 0, to: fixture.input.lapS))
        #expect(out.count > 10)
        #expect(out.count <= 301)
        #expect(out.allSatisfy { $0.x.isFinite && $0.y.isFinite && $0.v.isFinite })
    }

    @Test func downsamplesLongWindowsToRoughlyThePointBudget() throws {
        let fixture = try GeoFixture.load()
        let trace = Geo.projectTrace(fixture.input.points)
        let out = try #require(Geo.lapTrace(trace, from: 0, to: fixture.input.lapS, max: 50))
        #expect(out.count <= 51)
        #expect(out.count > 25)
    }

    @Test func derivesSpeedFromTheGeometryWhenTheSourceHasNone() throws {
        // The fixture circle carries no speed and is driven at a constant 40 m/s,
        // so derived speeds should be positive and nearly uniform.
        let fixture = try GeoFixture.load()
        let trace = Geo.projectTrace(fixture.input.points)
        let speeds = try #require(Geo.lapTrace(trace, from: 0, to: fixture.input.lapS)).map(\.v)
        let low = try #require(speeds.min())
        let high = try #require(speeds.max())
        #expect(low > 0)
        #expect(high / low < 1.2)
    }

    @Test func returnsNilForWindowsWithTooFewPoints() throws {
        let fixture = try GeoFixture.load()
        let trace = Geo.projectTrace(fixture.input.points)
        #expect(Geo.lapTrace(trace, from: 0, to: 0.5) == nil)
    }

    // MARK: - bestLapTrace

    @Test func extractsOneLapsWorthOfPointsAcrossTheGate() throws {
        let fixture = try GeoFixture.load()
        let trace = Geo.projectTrace(fixture.input.points)
        let gate = try #require(Geo.buildGate(trace, idx: fixture.input.pickedIndex))
        let out = try #require(Geo.bestLapTrace(trace, gate: gate))
        // One lap at 10 Hz ≈ 471 samples, downsampled to ≤ 300.
        #expect(out.count > 100)
        #expect(out.count <= 301)
        // The lap starts and ends at the gate, so on a closed loop the ends meet.
        let first = try #require(out.first)
        let last = try #require(out.last)
        #expect((pow(first.x - last.x, 2) + pow(first.y - last.y, 2)).squareRoot() < 20)
    }

    @Test func returnsNilWhenNoValidLapCrossesTheGate() throws {
        let straight = (0...100).map { Geo.Projected(t: Double($0), x: Double($0) * 10, y: 0) }
        let gate = try #require(Geo.buildGate(straight, idx: 50))
        #expect(Geo.bestLapTrace(straight, gate: gate) == nil)
    }

    // MARK: - Cross-language agreement

    /// The most valuable test in NS-13: the same trace and picked index through
    /// the JS implementation (`contracts/logic/geo-laps.json`, generated by
    /// `npm run contracts:logic`) and through this one, compared value by value.
    /// Lap times must be identical **to the millisecond**.
    @Test func matchesTheJavaScriptImplementationOnASharedFixture() throws {
        let fixture = try GeoFixture.load()
        let trace = Geo.projectTrace(fixture.input.points)
        let expected = fixture.expected

        #expect(close(trace[0].x, expected.projectedFirst.x))
        #expect(close(trace[0].y, expected.projectedFirst.y))
        #expect(close(trace[trace.count - 1].x, expected.projectedLast.x))
        #expect(close(trace[trace.count - 1].y, expected.projectedLast.y))

        let gate = try #require(Geo.buildGate(trace, idx: fixture.input.pickedIndex))
        #expect(close(gate.x, expected.gate.x))
        #expect(close(gate.y, expected.gate.y))
        let (hx, hy) = (try #require(gate.hx), try #require(gate.hy))
        let (wantHx, wantHy) = (try #require(expected.gate.hx), try #require(expected.gate.hy))
        #expect(close(hx, wantHx))
        #expect(close(hy, wantHy))
        #expect(close(gate.x1, expected.gate.x1))
        #expect(close(gate.y1, expected.gate.y1))
        #expect(close(gate.x2, expected.gate.x2))
        #expect(close(gate.y2, expected.gate.y2))

        let crossings = Geo.gateCrossings(trace, gate: gate)
        #expect(crossings.count == expected.crossings.count)
        for (got, want) in zip(crossings, expected.crossings) {
            #expect(close(got, want))
        }

        let laps = Geo.deriveLaps(trace, gate: gate)
        // Pinned so an empty or regenerated-to-nothing fixture can't pass by
        // agreeing with an equally empty result.
        #expect(expected.laps.map(\.timeMs) == [47_124, 47_124, 47_124])
        #expect(laps.count == expected.laps.count)
        for (got, want) in zip(laps, expected.laps) {
            #expect(got.timeMs == want.timeMs, "lap times must agree to the millisecond")
            #expect(got.estimated == want.estimated)
            #expect(close(got.startT, want.startT))
            #expect(close(got.endT, want.endT))
        }

        let best = try #require(Geo.bestLapTrace(trace, gate: gate))
        let wantBest = try #require(expected.bestLapTrace)
        #expect(best.count == wantBest.count)
        for (got, want) in zip(best, wantBest) {
            // Both sides are already rounded (1dp position, 2dp speed).
            #expect(got == want)
        }
    }

    private func close(_ a: Double, _ b: Double, tolerance: Double = 1e-9) -> Bool {
        abs(a - b) <= tolerance * Swift.max(1, abs(b))
    }
}

/// `contracts/logic/geo-laps.json` — reference output captured from
/// `public/js/import/geo.js`.
struct GeoFixture: Decodable {
    struct Input: Decodable {
        var points: [Geo.Point]
        var pickedIndex: Int
        var lapS: Double
    }

    struct Projected: Decodable {
        var t: Double
        var x: Double
        var y: Double
    }

    struct Expected: Decodable {
        var projectedFirst: Projected
        var projectedLast: Projected
        var gate: Geo.Gate
        var crossings: [Double]
        var laps: [Geo.DerivedLap]
        var bestLapTrace: [TracePoint]?
    }

    var input: Input
    var expected: Expected

    /// Decoded once — the trace is ~1,500 points, and `static let` is both lazy
    /// and thread-safe, which matters with tests running in parallel.
    static func load() throws -> GeoFixture { shared }

    private static let shared: GeoFixture = {
        let url = RepoRoot.path("contracts/logic/geo-laps.json")
        guard let data = try? Data(contentsOf: url),
              let fixture = try? JSONDecoder().decode(GeoFixture.self, from: data)
        else {
            fatalError("contracts/logic/geo-laps.json missing or stale — run `npm run contracts:logic`")
        }
        return fixture
    }()
}
