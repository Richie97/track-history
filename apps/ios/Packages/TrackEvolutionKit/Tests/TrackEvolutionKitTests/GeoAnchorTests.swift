import Foundation
import Testing

@testable import TrackEvolutionKit

/// NS-53: where a stored trace lies on Earth. `Geo`'s anchor half, pinned
/// against `public/js/import/geo.js` by `contracts/logic/geo-anchor.json`, plus
/// the JS cases from `test/unit/geo-anchor.test.ts` and the importers' rule for
/// what a save sends.
struct GeoAnchorTests {
    // MARK: - The pinned fixture

    struct Fixture: Decodable {
        struct KXAt: Decodable { var lat: Double; var kx: Double }
        struct Constants: Decodable { var KY: Double; var KX_at: [KXAt] }
        struct LatLon: Decodable { var lat: Double; var lon: Double }
        struct OriginCase: Decodable { var gps: [LatLon]; var origin: LatLon?; var expected: TraceGeo? }
        struct Unprojected: Decodable { var lat: Double; var lon: Double; var v: Double }
        struct Bounds: Decodable { var south: Double; var west: Double; var north: Double; var east: Double }
        struct Hit: Decodable { var idx: Int; var frac: Double; var alongM: Double; var offM: Double }
        struct NearestCase: Decodable { var x: Double; var y: Double; var maxM: Double?; var expected: Hit? }
        struct RunsCase: Decodable { var buckets: Int; var expected: [Geo.SpeedRun] }

        var constants: Constants
        var traceOrigin: [OriginCase]
        var geo: TraceGeo
        var trace: [TracePoint]
        var unprojected: [Unprojected]
        var bounds: Bounds
        var nearest: [NearestCase]
        var speedRuns: [RunsCase]
        var flatSpeedRuns: [Geo.SpeedRun]
    }

    static let fixture: Fixture = {
        let data = try! Data(contentsOf: RepoRoot.path("contracts/logic/geo-anchor.json"))
        return try! JSONDecoder().decode(Fixture.self, from: data)
    }()

    @Test func theProjectionConstantsMatchTheJavaScript() {
        #expect(Geo.KY == Self.fixture.constants.KY)
        for c in Self.fixture.constants.KX_at {
            #expect(abs(Geo.KX(c.lat) - c.kx) < 1e-6, "KX(\(c.lat))")
        }
    }

    @Test func traceOriginMatchesTheJavaScript() {
        for c in Self.fixture.traceOrigin {
            let gps = c.gps.enumerated().map { Geo.Point(t: Double($0.offset), lat: $0.element.lat, lon: $0.element.lon) }
            let origin = c.origin.map { Geo.Origin(lat: $0.lat, lon: $0.lon) }
            let got = Geo.traceOrigin(gps, origin: origin)
            #expect(got == c.expected, "\(c.gps) / \(String(describing: c.origin))")
        }
    }

    @Test func unprojectAndBoundsMatchTheJavaScript() throws {
        let f = Self.fixture
        let got = Geo.unprojectTrace(f.trace, f.geo)
        #expect(got.count == f.unprojected.count)
        for (a, b) in zip(got, f.unprojected) {
            #expect(abs(a.lat - b.lat) < 1e-9 && abs(a.lon - b.lon) < 1e-9 && a.v == b.v)
        }
        let bounds = try #require(Geo.traceGeoBounds(f.trace, f.geo))
        #expect(abs(bounds.south - f.bounds.south) < 1e-9)
        #expect(abs(bounds.west - f.bounds.west) < 1e-9)
        #expect(abs(bounds.north - f.bounds.north) < 1e-9)
        #expect(abs(bounds.east - f.bounds.east) < 1e-9)
    }

    @Test func nearestOnTraceMatchesTheJavaScript() {
        for c in Self.fixture.nearest {
            let got = Geo.nearestOnTrace(Self.fixture.trace, c.x, c.y, maxM: c.maxM ?? .infinity)
            guard let expected = c.expected else {
                #expect(got == nil, "(\(c.x), \(c.y)) within \(String(describing: c.maxM))")
                continue
            }
            guard let got else {
                Issue.record("(\(c.x), \(c.y)): expected a hit")
                continue
            }
            #expect(got.idx == expected.idx)
            #expect(abs(got.frac - expected.frac) < 1e-9)
            #expect(abs(got.alongM - expected.alongM) < 1e-6)
            #expect(abs(got.offM - expected.offM) < 1e-6)
        }
    }

    @Test func speedRunsMatchTheJavaScript() {
        for c in Self.fixture.speedRuns {
            #expect(Geo.speedRuns(Self.fixture.trace, buckets: c.buckets) == c.expected, "buckets \(c.buckets)")
        }
        let flat = Self.fixture.trace.map { TracePoint(x: $0.x, y: $0.y, v: 30) }
        #expect(Geo.speedRuns(flat, buckets: 16) == Self.fixture.flatSpeedRuns)
    }

    // MARK: - The JS cases

    private static func t(_ rows: [[Double]]) -> [TracePoint] { rows.map { TracePoint(x: $0[0], y: $0[1], v: $0[2]) } }

    @Test func traceOriginIsTheFirstFixUnlessHandedTheProjectionsOrigin() {
        let gps = [Geo.Point(t: 0, lat: 36.56071234567, lon: -79.2), Geo.Point(t: 1, lat: 36.57, lon: -79.21)]
        #expect(Geo.traceOrigin(gps) == TraceGeo(lat: 36.5607123, lon: -79.2))
        #expect(Geo.traceOrigin(gps, origin: Geo.Origin(lat: 40, lon: -75)) == TraceGeo(lat: 40, lon: -75))
        #expect(Geo.traceOrigin([Geo.Point(t: 0, lat: 0, lon: 0)]) == nil)
        #expect(Geo.traceOrigin([]) == nil)
        #expect(Geo.traceOrigin(nil) == nil)
    }

    @Test func nearestOnTraceIsByDistanceDrivenNotByIndex() throws {
        let trace = Self.t([[0, 0, 5], [1, 0, 5], [2, 0, 5], [3, 0, 5], [103, 0, 60]])
        let hit = try #require(Geo.nearestOnTrace(trace, 43, 4))
        #expect(hit == Geo.TraceHit(idx: 3, frac: 43.0 / 103, alongM: 43, offM: 4))
        #expect(Geo.nearestOnTrace(trace, 60, 4)?.idx == 4)
        #expect(Geo.nearestOnTrace(trace, 53, 30, maxM: 24) == nil)
        let before = try #require(Geo.nearestOnTrace(trace, -10, 0))
        #expect(before.idx == 0 && before.frac == 0 && before.offM == 10)
        #expect(Geo.nearestOnTrace(Self.t([[0, 0, 1]]), 0, 0) == nil)
        #expect(Geo.nearestOnTrace(Self.t([[5, 5, 1], [5, 5, 1]]), 5, 5) == nil)
    }

    @Test func speedRunsCutTheLineWhereItsColourChanges() {
        let trace = Self.t([[0, 0, 10], [1, 0, 10], [2, 0, 20], [3, 0, 30], [4, 0, 30], [5, 0, 10]])
        let runs = Geo.speedRuns(trace, buckets: 4)
        #expect(runs == [
            Geo.SpeedRun(from: 0, to: 2, bucket: 0),
            Geo.SpeedRun(from: 2, to: 3, bucket: 2),
            Geo.SpeedRun(from: 3, to: 5, bucket: 3),
        ])
        #expect(Geo.speedRuns(Self.t([[0, 0, 7], [1, 0, 7], [2, 0, 7]]), buckets: 16) == [Geo.SpeedRun(from: 0, to: 2, bucket: 8)])
        #expect(Geo.speedRuns(Self.t([[0, 0, 7]])).isEmpty)
    }

    @Test func unprojectInvertsProjectTraceToTheTracesRounding() {
        for lat in [0.0, 37.0, 60.0] {
            let origin = Geo.Origin(lat: lat, lon: 12.5)
            let fix = Geo.Point(t: 0, lat: lat + 0.004, lon: 12.507)
            let p = Geo.projectTrace([fix], origin: origin)[0]
            let back = Geo.unprojectTrace([TracePoint(x: p.x, y: p.y, v: 0)], TraceGeo(lat: lat, lon: 12.5))[0]
            #expect(abs(back.lat - fix.lat) < 1e-9 && abs(back.lon - fix.lon) < 1e-9)
        }
    }

    // MARK: - What a save sends

    @Test func aBeaconTimedPdrSendsItsFirstFixAsTheAnchor() throws {
        let parsed = try VideoFixtures.parse("pdr-beacons.mp4")
        if parsed.bestLapTrace != nil {
            #expect(parsed.traceGeo == Geo.traceOrigin(parsed.gps))
            #expect(parsed.traceGeo != nil)
        } else {
            #expect(parsed.traceGeo == nil)
        }
    }

    @Test func aFileThatOnlyFitsTheLineMirroredSavesWithoutAnAnchor() throws {
        // A loop picked on its own fixes, then the same drive with west-positive
        // longitudes (Racelogic's convention): applyGate fits it only mirrored.
        var gps: [Geo.Point] = []
        for i in 0..<1200 {
            let a = Double(i) / 300 * 2 * .pi
            gps.append(Geo.Point(t: Double(i) / 5, lat: 36.56 + 0.003 * sin(a), lon: -79.2 + 0.004 * cos(a)))
        }
        let origin = gps[0]
        let trace = Geo.projectTrace(gps, origin: Geo.Origin(lat: origin.lat, lon: origin.lon))
        let gate = try #require(Geo.buildGate(trace, idx: 30))

        var straight = ParsedTelemetry(kind: .gopro, gps: gps, needsLine: true)
        Telemetry.applyGate(&straight, origin: origin, gate: gate)
        #expect(straight.bestLapTrace != nil)
        #expect(straight.traceGeo == Geo.traceOrigin(gps))

        let flipped = gps.map { Geo.Point(t: $0.t, lat: $0.lat, lon: -$0.lon) }
        var mirrored = ParsedTelemetry(kind: .vbo, gps: flipped, needsLine: true)
        Telemetry.applyGate(&mirrored, origin: origin, gate: gate)
        #expect(mirrored.bestLapTrace != nil)
        #expect(mirrored.traceGeo == nil)

        Telemetry.applyGate(&straight, origin: origin, gate: nil)
        #expect(straight.traceGeo == nil)
    }

    @Test func aSessionDraftSendsTheAnchorOnlyBesideATrace() throws {
        let geo = TraceGeo(lat: 36.5, lon: -79.2)
        let withTrace = SessionDraft(laps: [90_000], trace: Self.t([[0, 0, 1], [1, 1, 1]]), traceGeo: geo)
        let json = try #require(String(data: JSONEncoder().encode(withTrace), encoding: .utf8))
        #expect(json.contains("\"trace_geo\":{"))
        #expect(!json.contains("approx"))
        #expect(SessionDraft(laps: [90_000], traceGeo: geo).traceGeo == nil)
    }
}
