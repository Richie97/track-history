import Foundation
import Testing

@testable import TrackEvolutionKit

/// NS-57: `TrackLocate`, pinned against `public/js/import/locate.js` by
/// `contracts/logic/track-locate.json` — distances and length ratios to 1e-6 —
/// plus the JS cases from `test/unit/locate.test.js` and
/// `test/unit/geo-anchor.test.ts` the fixture's rows do not carry.
struct TrackLocateTests {
    // MARK: - The pinned fixture

    struct Fixture: Decodable {
        struct Constants: Decodable {
            var OWN_RADIUS_M: Double
            var VENUE_RADIUS_M: Double
            var LENGTH_TOLERANCE: Double
            var CATALOG_SHORT_TOLERANCE: Double
            var CATALOG_LONG_TOLERANCE: Double
            var DATE_SLACK_DAYS: Int
            var GATE_HALF_WIDTH_M: Double
        }
        struct LatLon: Decodable { var lat: Double; var lon: Double }
        struct Sf: Decodable { var lat: Double; var lon: Double; var heading: Double? }
        struct Geo: Decodable { var lat: Double; var lon: Double; var length_m: Int; var sf: Sf? }
        struct Own: Decodable { var id: Int; var name: String; var catalog_id: Int?; var geo: Geo? }
        struct Cat: Decodable { var id: Int; var name: String; var lat: Double?; var lon: Double?; var length_m: Int? }
        struct Ev: Decodable { var id: Int; var track_id: Int; var start_date: String; var days: Double }
        struct PlaceJ: Decodable { var lat: Double; var lon: Double; var lengthM: Double? }
        struct Cand: Decodable { var source: String; var id: Int; var name: String; var distM: Double; var lengthOff: Double? }
        struct LocatedJ: Decodable { var confidence: String; var candidates: [Cand]; var venueOnly: Bool }

        struct DistanceCase: Decodable { var a: LatLon; var b: LatLon; var expected: Double }
        struct LengthCase: Decodable { var trace: [[Double]]; var expected: Double? }
        struct Parsed: Decodable { var bestLapTrace: [[Double]]?; var traceGeo: LatLon?; var gps: [LatLon]? }
        struct PlaceCase: Decodable { var name: String; var parsed: Parsed; var expected: PlaceJ? }
        struct LocateCase: Decodable { var name: String; var place: PlaceJ?; var own: [Own]; var expected: LocatedJ }
        struct EventCase: Decodable { var trackId: Int; var date: String; var expected: Int? }
        struct ItemJ: Decodable { var id: Int; var date: String?; var time: String?; var place: PlaceJ?; var located: LocatedJ? }
        struct Choice: Decodable { var name: String }
        struct TrackJ: Decodable { var source: String; var id: Int?; var name: String }
        struct GroupJ: Decodable {
            var key: String
            var eventId: Int?
            var track: TrackJ?
            var confidence: String
            var candidates: [Cand]
            var venueOnly: Bool
            var start: String
            var days: Int
            var itemIds: [Int]
        }
        struct Body: Decodable { var track_name: String; var start_date: String; var days: Double; var car: String? }
        struct GroupCase: Decodable {
            var name: String
            var own: [Own]
            var events: [Ev]
            var items: [ItemJ]
            var choices: [String: Choice]
            var today: String
            var expected: [GroupJ]
            var eventBodies: [Body?]
        }
        struct EventTrack: Decodable { var id: Int; var catalog_id: Int? }
        struct OtherCase: Decodable { var place: PlaceJ; var own: [Own]; var track: EventTrack; var expected: String? }
        struct GateJ: Decodable {
            var x: Double; var y: Double; var hx: Double; var hy: Double
            var x1: Double; var y1: Double; var x2: Double; var y2: Double
        }
        struct GateCase: Decodable { var sf: Sf?; var origin: LatLon?; var expected: GateJ? }
        struct Line: Decodable { var id: Int; var name: String; var sf: Sf; var distM: Double }
        struct LinesCase: Decodable { var place: PlaceJ?; var expected: [Line] }
        struct FitsCase: Decodable { var trackId: Int; var places: [PlaceJ?]; var expected: Bool }

        var constants: Constants
        var catalog: [Cat]
        var events: [Ev]
        var distanceM: [DistanceCase]
        var traceLengthM: [LengthCase]
        var recordingPlace: [PlaceCase]
        var locateTrack: [LocateCase]
        var eventForDate: [EventCase]
        var groupImports: [GroupCase]
        var otherTrackHere: [OtherCase]
        var gateFromSf: [GateCase]
        var sfOwnTracks: [Own]
        var knownLines: [LinesCase]
        var lineFits: [FitsCase]
    }

    static let fixture: Fixture = {
        let data = try! Data(contentsOf: RepoRoot.path("contracts/logic/track-locate.json"))
        return try! JSONDecoder().decode(Fixture.self, from: data)
    }()

    // MARK: - Fixture → Kit

    static func sf(_ s: Fixture.Sf?) -> StartFinish? {
        guard let s, let heading = s.heading else { return nil }
        return StartFinish(lat: s.lat, lon: s.lon, heading: heading)
    }

    static func own(_ rows: [Fixture.Own]) -> [TrackLocate.OwnTrack] {
        rows.map { t in
            TrackLocate.OwnTrack(
                id: t.id, name: t.name, catalogId: t.catalog_id,
                geo: t.geo.map { TrackPlace(lat: $0.lat, lon: $0.lon, lengthM: $0.length_m, sf: sf($0.sf)) }
            )
        }
    }

    static var catalog: [TrackLocate.CatalogRow] {
        fixture.catalog.map { TrackLocate.CatalogRow(id: $0.id, name: $0.name, lat: $0.lat, lon: $0.lon, lengthM: $0.length_m) }
    }

    static func events(_ rows: [Fixture.Ev]) -> [TrackLocate.EventRow] {
        rows.map { TrackLocate.EventRow(id: $0.id, trackId: $0.track_id, startDate: $0.start_date, days: $0.days) }
    }

    static func place(_ p: Fixture.PlaceJ?) -> TrackLocate.Place? {
        p.map { TrackLocate.Place(lat: $0.lat, lon: $0.lon, lengthM: $0.lengthM) }
    }

    static func trace(_ t: [[Double]]?) -> [TracePoint]? {
        t.map { rows in rows.map { TracePoint(x: $0[0], y: $0[1], v: $0.count > 2 ? $0[2] : 0) } }
    }

    static func candidates(_ c: [Fixture.Cand]) -> [TrackLocate.Candidate] {
        c.map {
            TrackLocate.Candidate(source: TrackLocate.Source(rawValue: $0.source)!, id: $0.id, name: $0.name, distM: $0.distM, lengthOff: $0.lengthOff)
        }
    }

    static func located(_ l: Fixture.LocatedJ) -> TrackLocate.Located {
        TrackLocate.Located(confidence: TrackLocate.Confidence(rawValue: l.confidence)!, candidates: candidates(l.candidates), venueOnly: l.venueOnly)
    }

    static func close(_ a: Double?, _ b: Double?, _ tolerance: Double = 1e-6) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case let (a?, b?): return abs(a - b) <= tolerance
        default: return false
        }
    }

    static func sameCandidates(_ got: [TrackLocate.Candidate], _ want: [TrackLocate.Candidate]) -> Bool {
        got.count == want.count && zip(got, want).allSatisfy { g, w in
            g.source == w.source && g.id == w.id && g.name == w.name && close(g.distM, w.distM) && close(g.lengthOff, w.lengthOff, 1e-9)
        }
    }

    // MARK: - Against the JavaScript

    @Test func theConstantsMatchTheJavaScript() {
        let c = Self.fixture.constants
        #expect(TrackLocate.OWN_RADIUS_M == c.OWN_RADIUS_M)
        #expect(TrackLocate.VENUE_RADIUS_M == c.VENUE_RADIUS_M)
        #expect(TrackLocate.LENGTH_TOLERANCE == c.LENGTH_TOLERANCE)
        #expect(TrackLocate.CATALOG_SHORT_TOLERANCE == c.CATALOG_SHORT_TOLERANCE)
        #expect(TrackLocate.CATALOG_LONG_TOLERANCE == c.CATALOG_LONG_TOLERANCE)
        #expect(TrackLocate.DATE_SLACK_DAYS == c.DATE_SLACK_DAYS)
        #expect(TrackLocate.GATE_HALF_WIDTH_M == c.GATE_HALF_WIDTH_M)
    }

    @Test func distanceAndLengthMatchTheJavaScript() {
        for c in Self.fixture.distanceM {
            #expect(Self.close(TrackLocate.distanceM(c.a.lat, c.a.lon, c.b.lat, c.b.lon), c.expected))
        }
        for c in Self.fixture.traceLengthM {
            #expect(Self.close(TrackLocate.traceLengthM(Self.trace(c.trace)), c.expected))
        }
    }

    @Test func recordingPlaceMatchesTheJavaScript() {
        for c in Self.fixture.recordingPlace {
            let geo = c.parsed.traceGeo.map { TraceGeo(lat: $0.lat, lon: $0.lon) }
            let gps = c.parsed.gps?.map { Geo.Point(t: 0, lat: $0.lat, lon: $0.lon) }
            let got = TrackLocate.recordingPlace(trace: Self.trace(c.parsed.bestLapTrace), geo: geo, gps: gps)
            guard let want = c.expected else {
                #expect(got == nil, "\(c.name)")
                continue
            }
            #expect(Self.close(got?.lat, want.lat, 1e-9) && Self.close(got?.lon, want.lon, 1e-9), "\(c.name)")
            #expect(Self.close(got?.lengthM, want.lengthM), "\(c.name)")
        }
    }

    @Test func locateTrackMatchesTheJavaScript() {
        #expect(Self.fixture.locateTrack.count >= 10)
        for c in Self.fixture.locateTrack {
            let got = TrackLocate.locateTrack(Self.place(c.place), Self.own(c.own), Self.catalog)
            let want = Self.located(c.expected)
            #expect(got.confidence == want.confidence, "\(c.name)")
            #expect(got.venueOnly == want.venueOnly, "\(c.name)")
            #expect(Self.sameCandidates(got.candidates, want.candidates), "\(c.name): \(got.candidates)")
        }
    }

    @Test func eventForDateMatchesTheJavaScript() {
        let events = Self.events(Self.fixture.events)
        for c in Self.fixture.eventForDate {
            #expect(TrackLocate.eventForDate(events, c.trackId, c.date)?.id == c.expected, "\(c.trackId) on \(c.date)")
        }
    }

    @Test func groupImportsAndEventBodiesMatchTheJavaScript() {
        for c in Self.fixture.groupImports {
            let items = c.items.map {
                TrackLocate.Item(id: $0.id, date: $0.date, time: $0.time, place: Self.place($0.place), located: $0.located.map(Self.located))
            }
            var choices: [Int: String] = [:]
            for (k, v) in c.choices { choices[Int(k)!] = v.name }
            let groups = TrackLocate.groupImports(items, Self.events(c.events), choices: choices, ownTracks: Self.own(c.own), today: c.today)
            #expect(groups.count == c.expected.count, "\(c.name)")
            for (n, (g, e)) in zip(groups, c.expected).enumerated() {
                let what = "\(c.name)[\(n)]"
                #expect(g.key == e.key, "\(what)")
                #expect(g.eventId == e.eventId, "\(what)")
                let track = e.track.map { TrackLocate.GroupTrack(source: TrackLocate.Source(rawValue: $0.source)!, id: $0.id, name: $0.name) }
                #expect(g.track == track, "\(what)")
                #expect(g.confidence.rawValue == e.confidence, "\(what)")
                #expect(Self.sameCandidates(g.candidates, Self.candidates(e.candidates)), "\(what)")
                #expect(g.venueOnly == e.venueOnly, "\(what)")
                #expect(g.start == e.start && g.days == e.days, "\(what)")
                #expect(g.itemIds == e.itemIds, "\(what)")
            }
            for (n, body) in c.eventBodies.enumerated() where n < groups.count {
                let g = groups[n]
                #expect((body != nil) == (g.track != nil && g.eventId == nil), "\(c.name)[\(n)] has a body")
                guard let body, let draft = TrackLocate.eventBodyFor(g, "Corvette") else { continue }
                #expect(draft.trackName == body.track_name)
                #expect(draft.startDate == body.start_date)
                #expect(draft.days == body.days)
                #expect(draft.car == body.car)
            }
        }
    }

    @Test func otherTrackHereMatchesTheJavaScript() {
        for c in Self.fixture.otherTrackHere {
            let located = TrackLocate.locateTrack(Self.place(c.place), Self.own(c.own), Self.catalog)
            #expect(TrackLocate.otherTrackHere(located, trackId: c.track.id, trackCatalogId: c.track.catalog_id) == c.expected)
        }
    }

    @Test func gateFromSfMatchesTheJavaScript() {
        #expect(Self.fixture.gateFromSf.contains { $0.expected != nil })
        for c in Self.fixture.gateFromSf {
            let got = TrackLocate.gateFromSf(Self.sf(c.sf), c.origin.map { Geo.Origin(lat: $0.lat, lon: $0.lon) })
            guard let want = c.expected else {
                #expect(got == nil)
                continue
            }
            #expect(Self.close(got?.x, want.x) && Self.close(got?.y, want.y))
            #expect(Self.close(got?.x1, want.x1) && Self.close(got?.y1, want.y1))
            #expect(Self.close(got?.x2, want.x2) && Self.close(got?.y2, want.y2))
            #expect(Self.close(got?.hx, want.hx, 1e-12) && Self.close(got?.hy, want.hy, 1e-12))
        }
    }

    @Test func knownLinesAndLineFitsMatchTheJavaScript() {
        let own = Self.own(Self.fixture.sfOwnTracks)
        for c in Self.fixture.knownLines {
            let got = TrackLocate.knownLines(Self.place(c.place), own)
            #expect(got.map(\.id) == c.expected.map(\.id))
            for (g, e) in zip(got, c.expected) {
                #expect(g.name == e.name && g.sf == Self.sf(e.sf) && Self.close(g.distM, e.distM))
            }
        }
        for c in Self.fixture.lineFits {
            #expect(TrackLocate.lineFits(c.trackId, c.places.map(Self.place), own, Self.catalog) == c.expected)
        }
    }

    // MARK: - The JS unit cases the fixture does not carry

    static let vir = Geo.Origin(lat: 36.5617, lon: -79.2047)

    /// A 3 km oval driven clockwise at 10 Hz, starting `leadM` before its top.
    static func drive(laps: Int, leadM: Double, t0: Double = 0) -> [Geo.Point] {
        let length = 3000.0
        let r = length / (2 * Double.pi)
        var out: [Geo.Point] = []
        var i = 0
        while Double(i) * 4 <= Double(laps) * length + 400 {
            let a = (Double(i) * 4 - leadM) / length * 2 * Double.pi
            out.append(Geo.Point(
                t: t0 + Double(i) * 0.1,
                lat: vir.lat + 0.6 * r * cos(a) / Geo.KY,
                lon: vir.lon + r * sin(a) / Geo.KX(vir.lat),
                v: 40
            ))
            i += 1
        }
        return out
    }

    @Test func aKnownLineTimesASecondDayTheWayTheFirstDaysPickedLineDid() throws {
        let day1 = Self.drive(laps: 4, leadM: 700)
        let trace1 = Geo.projectTrace(day1)
        let gate1 = try #require(Geo.buildGate(trace1, idx: 200))
        let laps1 = Geo.deriveLaps(trace1, gate: gate1)
        #expect(laps1.count == 3)
        let stored = try #require(Geo.bestLapTrace(trace1, gate: gate1))
        // What the server's `startFinish` reads off the stored lap.
        let p0 = stored[0]
        let next = try #require(stored.first { p in
            let dx: Double = p.x - p0.x
            let dy: Double = p.y - p0.y
            return (dx * dx + dy * dy).squareRoot() >= 15
        })
        let heading = (atan2(next.x - p0.x, next.y - p0.y) * 180 / Double.pi + 360).truncatingRemainder(dividingBy: 360)
        let o1 = try #require(Geo.traceOrigin(day1))
        let sf = StartFinish(lat: o1.lat + p0.y / Geo.KY, lon: o1.lon + p0.x / Geo.KX(o1.lat), heading: heading)

        let day2 = Self.drive(laps: 5, leadM: 1900, t0: 1000)
        let gate2 = try #require(TrackLocate.gateFromSf(sf, Geo.Origin(lat: day2[0].lat, lon: day2[0].lon)))
        let laps2 = Geo.deriveLaps(Geo.projectTrace(day2), gate: gate2)
        #expect(laps2.count == 4)
        for lap in laps2 { #expect(abs(lap.timeMs - laps1[0].timeMs) < 150) }

        // The other way round, the direction filter finds nothing.
        let reversed = day1.indices.map { n in
            Geo.Point(t: day1[n].t, lat: day1[day1.count - 1 - n].lat, lon: day1[day1.count - 1 - n].lon, v: 40)
        }
        let gateR = try #require(TrackLocate.gateFromSf(sf, Geo.Origin(lat: reversed[0].lat, lon: reversed[0].lon)))
        #expect(Geo.deriveLaps(Geo.projectTrace(reversed), gate: gateR).isEmpty)
    }

    @Test func anUnansweredGroupHasNoTrackUntilTheDriverNamesIt() {
        let unknown = TrackLocate.Place(lat: 10, lon: 10, lengthM: 2500)
        let items = [
            TrackLocate.Item(id: 0, date: "2026-06-20", time: nil, place: unknown, located: nil),
            TrackLocate.Item(id: 1, date: "2026-06-20", time: nil, place: unknown, located: nil),
        ]
        let groups = TrackLocate.groupImports(items, [], today: "2026-08-09")
        #expect(groups.count == 1)
        #expect(groups.first?.track == nil && groups.first?.confidence == TrackLocate.Confidence.none)
        #expect(groups.first?.itemIds == [0, 1])
        let named = TrackLocate.groupImports(items, [], choices: [0: "Paddock Loop", 1: "Paddock Loop"], today: "2026-08-09")
        #expect(named.count == 1)
        #expect(named.first?.track == TrackLocate.GroupTrack(source: .new, id: nil, name: "Paddock Loop"))
        #expect(named.first?.confidence == .chosen)
    }

    @Test func datesAddAcrossMonthsYearsAndLeapDays() {
        #expect(TrackLocate.addDays("2026-03-31", 1) == "2026-04-01")
        #expect(TrackLocate.addDays("2026-01-01", -1) == "2025-12-31")
        #expect(TrackLocate.addDays("2024-02-28", 1) == "2024-02-29")
        #expect(TrackLocate.addDays("2025-02-28", 1) == "2025-03-01")
        #expect(TrackLocate.addDays("2026-12-25", 10) == "2027-01-04")
        let g = TrackLocate.Group(
            key: "k", eventId: nil, track: nil, confidence: .none, candidates: [], venueOnly: false,
            start: "2026-03-31", days: 2, itemIds: [0]
        )
        #expect(TrackLocate.groupDatesText(g) { "<\($0)>" } == "<2026-03-31> – <2026-04-01>")
    }
}
