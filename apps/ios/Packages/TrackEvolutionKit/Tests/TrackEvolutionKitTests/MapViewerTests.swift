import Foundation
import Testing

@testable import TrackEvolutionKit

/// The map viewer's pure half (NS-53 ticket 2) — `test/unit/map-viewer.test.js`'s
/// cases, ported with `public/js/map-viewer.js`.
struct MapViewerTests {
    let geo = TraceGeo(lat: 36.5607, lon: -79.2064)

    @Test func offersEveryTypeOverAnAnchoredTrace() {
        #expect(MapViewer.viewerPlan(geo: geo) == .init(types: MapViewer.MAP_TYPES, note: nil))
        var approx = geo
        approx.approx = true
        #expect(MapViewer.viewerPlan(geo: approx) == .init(types: MapViewer.MAP_TYPES, note: MapViewer.NOTE_APPROX))
    }

    @Test func keepsToTheLineAndSaysWhy() {
        #expect(MapViewer.viewerPlan(geo: nil) == .init(types: [.line], note: MapViewer.NOTE_NO_ANCHOR))
        #expect(MapViewer.viewerPlan(geo: geo, mapsOn: false) == .init(types: [.line], note: MapViewer.NOTE_NOT_SET_UP))
        #expect(MapViewer.viewerPlan(geo: geo, loadFailed: true) == .init(types: [.line], note: MapViewer.NOTE_OFFLINE))
        // No anchor is the reason that stands, whatever else is also true.
        #expect(MapViewer.viewerPlan(geo: nil, mapsOn: false, loadFailed: true).note == MapViewer.NOTE_NO_ANCHOR)
    }

    @Test func remembersTheTypeLeniently() {
        #expect(MapViewer.mapType(fromStored: nil) == .satellite)
        #expect(MapViewer.mapType(fromStored: "standard") == .standard)
        #expect(MapViewer.mapType(fromStored: "globe") == .satellite)
        #expect(MapViewer.startType(.init(types: MapViewer.MAP_TYPES, note: nil), .standard) == .standard)
        #expect(MapViewer.startType(.init(types: [.line], note: nil), .satellite) == .line)
        #expect(MapViewer.MAP_TYPES.map(\.label) == ["Satellite", "Map", "Line"])
    }

    @Test func rampColorRunsFromSlowToFastAtBucketMidpoints() throws {
        let black = try #require(MapViewer.RGB(hex: "#000000"))
        let white = try #require(MapViewer.RGB(hex: "#fff"))
        #expect(MapViewer.rampColor(0, 2, black, white) == .init(r: 64, g: 64, b: 64))
        #expect(MapViewer.rampColor(1, 2, black, white) == .init(r: 191, g: 191, b: 191))
        let same = try #require(MapViewer.RGB(hex: " #102030"))
        #expect(MapViewer.rampColor(7, 16, same, same) == .init(r: 16, g: 32, b: 48))
    }

    // A 400 m straight heading east from the anchor, then north.
    let trace = [[0.0, 0, 0], [100, 0, 0], [200, 0, 0], [400, 0, 0], [400, 300, 0]].map {
        TracePoint(x: $0[0], y: $0[1], v: $0[2])
    }

    @Test func traceMetresInvertsTheProjection() {
        let p = Geo.projectTrace([Geo.Point(t: 0, lat: 36.5631, lon: -79.2019)], origin: Geo.Origin(lat: geo.lat, lon: geo.lon))[0]
        let m = MapViewer.traceMetres(36.5631, -79.2019, geo)
        #expect(abs(m.x - p.x) < 1e-9 && abs(m.y - p.y) < 1e-9)
    }

    @Test func readsTheLineWithinTheTapRadiusAndNothingBeyond() throws {
        func at(_ x: Double, _ y: Double) -> (Double, Double) {
            (geo.lat + y / 110_540, geo.lon + x / (111_320 * cos(geo.lat * .pi / 180)))
        }
        let a = at(250, 20)
        let hit = try #require(MapViewer.tapHit(trace, geo, a.0, a.1, 1))
        #expect(abs(hit.alongM - 250) < 1e-6 && abs(hit.offM - 20) < 1e-6)
        let b = at(250, 30)
        #expect(MapViewer.tapHit(trace, geo, b.0, b.1, 1) == nil)
        #expect(MapViewer.tapHit(trace, geo, b.0, b.1, 2) != nil)
        #expect(MapViewer.TAP_RADIUS_PX == 24)
    }

    @Test func pointAlongIsThePointOnTheLine() {
        #expect(MapViewer.pointAlong(trace, 250) == (250, 0))
        #expect(MapViewer.pointAlong(trace, 500) == (400, 100))
        #expect(MapViewer.pointAlong(trace, 9999) == (400, 300))
    }

    @Test func hitAtFractionStepsAlongTheLap() throws {
        // 700 m of line: half way is 350 m along, on the first straight.
        let half = try #require(MapViewer.hitAtFraction(trace, 0.5))
        #expect(abs(half.alongM - 350) < 1e-6 && half.offM < 1e-9)
        #expect(try #require(MapViewer.hitAtFraction(trace, 1.4)).frac == 1)
    }

    @Test func headingDegIsTheWayRoundClockwiseFromNorth() {
        #expect(abs(MapViewer.headingDeg(trace, 1) - 90) < 1e-9)
        #expect(abs(MapViewer.headingDeg(trace, 4) - 0) < 1e-9)
        let west = [TracePoint(x: 0, y: 0, v: 0), TracePoint(x: -10, y: 0, v: 0)]
        #expect(abs(MapViewer.headingDeg(west, 0) - 270) < 1e-9)
    }

    @Test func readsSpeedAndDistanceOffTheLapsOwnChannelEntry() {
        let speed = [100.0, 120, 140, 160, 180]
        let place = MapViewer.placeAt(.init(idx: 0, frac: 0.625, alongM: 999, offM: 0), speed: speed, dStepM: 20)
        #expect(abs(place.kph! - 150) < 1e-9 && abs(place.distM - 50) < 1e-9)
        #expect(MapViewer.readoutText(place, .metric) == "150 km/h · 50 m")
        #expect(MapViewer.readoutText(place, .imperial) == "93 mph · 164 ft")
        #expect(MapViewer.placeAt(.init(idx: 0, frac: 1, alongM: 0, offM: 0), speed: speed, dStepM: 20) == .init(kph: 180, distM: 80))
    }

    @Test func isTheDistanceAlongTheLineAloneWithoutAChannelEntry() {
        let place = MapViewer.placeAt(.init(idx: 0, frac: 0.5, alongM: 1240.4, offM: 0), speed: nil, dStepM: nil)
        #expect(place == .init(kph: nil, distM: 1240.4))
        #expect(MapViewer.readoutText(place, .metric) == "1.2 km")
        #expect(MapViewer.placeAt(.init(idx: 0, frac: 0.5, alongM: 7, offM: 0), speed: [1], dStepM: 20).kph == nil)
    }
}
