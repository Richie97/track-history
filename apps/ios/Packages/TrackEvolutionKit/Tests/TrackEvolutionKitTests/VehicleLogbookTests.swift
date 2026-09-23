import Foundation
import Testing

@testable import TrackEvolutionKit

/// A car's logbook (NS-37): the JS cases from `test/unit/garage.test.js` ported
/// with the code, plus agreement with `contracts/logic/garage-logbook.json`.
struct VehicleLogbookTests {
    struct Row: Garage.LogbookEvent, Decodable {
        var id: Int
        var vehicleId: Int? = 1
        var trackId: Int = 100
        var trackName: String = "VIR"
        var startDate: String = "2026-06-01"
        var days: Double = 1
        var bestMs: Int? = nil

        enum CodingKeys: String, CodingKey {
            case id
            case vehicleId = "vehicle_id"
            case trackId = "track_id"
            case trackName = "track_name"
            case startDate = "start_date"
            case days
            case bestMs = "best_ms"
        }
    }

    let today = "2026-09-20"

    @Test func countsTrackDaysNotEventsAndTodayIsPast() {
        let lb = Garage.vehicleLogbook(1, [Row(id: 1, days: 2), Row(id: 2, startDate: today)], today: today)
        #expect(lb.trackDays == 3)
        #expect(lb.events == 2)
        #expect(lb.lastEvent?.id == 2)
        #expect(lb.nextEvent == nil)
    }

    @Test func onlyCountsRowsTheServerMatched() {
        let lb = Garage.vehicleLogbook(1, [Row(id: 1, vehicleId: nil), Row(id: 2, vehicleId: 2)], today: today)
        #expect(lb.events == 0)
        #expect(Garage.vehicleTileLine(lb) == "No track days yet")
    }

    @Test func keepsOneBestPerTrackTheEarlierOnATie() {
        let lb = Garage.vehicleLogbook(1, [
            Row(id: 1, bestMs: 90000),
            Row(id: 2, startDate: "2026-07-01", bestMs: 90000),
            Row(id: 3, startDate: "2026-08-01", bestMs: 95000),
        ], today: today)
        #expect(lb.bests.map(\.eventId) == [1])
        #expect(lb.bests.first?.bestMs == 90000)
    }

    @Test func ordersTracksByLatestEventThenId() {
        let lb = Garage.vehicleLogbook(1, [
            Row(id: 1, trackId: 100, bestMs: 1),
            Row(id: 2, trackId: 101, trackName: "NCM", startDate: "2026-07-01", bestMs: 2),
            Row(id: 3, trackId: 102, trackName: "Summit", startDate: "2026-07-01", bestMs: 3),
            Row(id: 4, trackId: 103, trackName: "Glen", startDate: "2026-08-01"),
        ], today: today)
        #expect(lb.bests.map(\.trackId) == [102, 101, 100])
    }

    @Test func wordsTheTile() {
        #expect(Garage.vehicleTileLine(Garage.vehicleLogbook(1, [Row(id: 1)], today: today)) == "1 track day · last at VIR")
        #expect(Garage.vehicleTileLine(Garage.vehicleLogbook(1, [Row(id: 1, days: 3)], today: today)) == "3 track days · last at VIR")
        #expect(Garage.vehicleTileLine(Garage.vehicleLogbook(1, [Row(id: 1, trackName: "Glen", startDate: "2026-10-01")], today: today)) == "Next: Glen")
    }

    @Test func matchesTheJavaScriptImplementationOnTheSharedFixture() throws {
        struct Fixture: Decodable {
            struct Expected: Decodable {
                let logbook: Garage.Logbook
                let tileLine: String
            }
            struct Case: Decodable {
                let name: String
                let vehicleId: Int
                let expected: Expected
                enum CodingKeys: String, CodingKey {
                    case name, expected
                    case vehicleId = "vehicle_id"
                }
            }
            let today: String
            let events: [Row]
            let cases: [Case]
        }
        let data = try Data(contentsOf: RepoRoot.path("contracts/logic/garage-logbook.json"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        for c in fixture.cases {
            let lb = Garage.vehicleLogbook(c.vehicleId, fixture.events, today: fixture.today)
            #expect(lb == c.expected.logbook, Comment(rawValue: c.name))
            #expect(Garage.vehicleTileLine(lb) == c.expected.tileLine, Comment(rawValue: c.name))
        }
        #expect(fixture.cases.count >= 4)
    }
}
