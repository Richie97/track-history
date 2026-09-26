import Foundation
import Testing

@testable import TrackEvolutionKit

/// Swaps between sessions (migration 0030): the JS cases from the "swaps between
/// sessions" block of `test/unit/garage.test.js`, plus agreement with
/// `contracts/logic/garage-swap.json`.
struct SwapSessionsTests {
    struct EventRow: Garage.SwapEvent, Decodable {
        var id: Int
        var vehicleId: Int?
        var startDate: String
        var days: Double

        enum CodingKeys: String, CodingKey {
            case id, days
            case vehicleId = "vehicle_id"
            case startDate = "start_date"
        }
    }

    struct SessionRow: Garage.SwapSession, Decodable {
        struct AnyLap: Decodable {}
        var id: Int
        var label: String?
        var laps: [AnyLap]
        var lapCount: Int { laps.count }

        init(id: Int, label: String?, laps: Int) {
            self.id = id
            self.label = label
            self.laps = Array(repeating: AnyLap(), count: laps)
        }
    }

    let events = [
        EventRow(id: 1, vehicleId: 10, startDate: "2026-05-02", days: 2),
        EventRow(id: 2, vehicleId: 10, startDate: "2026-06-06", days: 0.5),
        EventRow(id: 3, vehicleId: 11, startDate: "2026-05-02", days: 1),
        EventRow(id: 4, vehicleId: nil, startDate: "2026-08-01", days: 1),
        EventRow(id: 5, vehicleId: 10, startDate: "2026-09-12", days: 3),
        EventRow(id: 6, vehicleId: 10, startDate: "2026-09-13", days: 1),
    ]

    @Test func countsAPartDayWholeAndEndsAnEventOnItsLastDay() {
        #expect(Garage.eventLastDay(EventRow(id: 0, startDate: "2026-05-02", days: 2)) == "2026-05-03")
        #expect(Garage.eventLastDay(EventRow(id: 0, startDate: "2026-06-06", days: 0.5)) == "2026-06-06")
        #expect(Garage.eventLastDay(EventRow(id: 0, startDate: "2026-12-31", days: 2)) == "2027-01-01")
    }

    @Test func findsThisCarsEventCoveringTheDateAndNothingElses() {
        #expect(Garage.swapSessionEvent(10, "2026-05-03", events)?.id == 1)
        #expect(Garage.swapSessionEvent(10, "2026-05-04", events) == nil)
        #expect(Garage.swapSessionEvent(11, "2026-05-02", events)?.id == 3)
        #expect(Garage.swapSessionEvent(10, "2026-08-01", events) == nil) // no vehicle_id: never matched
        #expect(Garage.swapSessionEvent(10, "", events) == nil)
    }

    @Test func givesTwoCoveringEventsToTheOneThatStartedLater() {
        #expect(Garage.swapSessionEvent(10, "2026-09-13", events)?.id == 6)
        #expect(Garage.swapSessionEvent(10, "2026-09-14", events)?.id == 5)
    }

    @Test func wordsTheSessionsAsTheMomentBeforeEachOne() {
        let choices = Garage.swapSessionChoices([
            SessionRow(id: 21, label: "Morning", laps: 3),
            SessionRow(id: 22, label: nil, laps: 1),
            SessionRow(id: 23, label: "  ", laps: 0),
        ])
        #expect(choices == [
            Garage.SwapChoice(id: 21, label: "Before Morning · 3 laps"),
            Garage.SwapChoice(id: 22, label: "Before Session 2 · 1 lap"),
            Garage.SwapChoice(id: 23, label: "Before Session 3"),
        ])
        #expect(Garage.swapSessionChoices([SessionRow]()).isEmpty)
    }

    /// The routes read `session_id`; nil sends no key, which is the whole-day rule.
    @Test func swapDraftsSendTheSessionOnlyWhenOneIsPicked() throws {
        func keys(_ value: some Encodable) throws -> [String: Any] {
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any] ?? [:]
        }
        #expect(try keys(PartEquipDraft(on: "2026-05-02", sessionId: 7))["session_id"] as? Int == 7)
        #expect(try keys(PartEquipDraft(on: "2026-05-02"))["session_id"] == nil)
        #expect(try keys(PartRefreshDraft(installedOn: "2026-05-02", sessionId: 8))["session_id"] as? Int == 8)
        var draft = PartDraft(kind: .padsFront, name: "DTC-60", installedOn: "2026-05-02")
        #expect(try keys(draft)["session_id"] == nil)
        draft.sessionId = 9
        #expect(try keys(draft)["session_id"] as? Int == 9)
    }

    @Test func matchesTheJavaScriptImplementationOnTheSharedFixture() throws {
        struct Fixture: Decodable {
            struct EventCase: Decodable {
                let vehicleId: Int
                let date: String
                let eventId: Int?
                enum CodingKeys: String, CodingKey {
                    case date
                    case vehicleId = "vehicle_id"
                    case eventId = "event_id"
                }
            }
            struct LastDay: Decodable {
                let eventId: Int
                let lastDay: String
                enum CodingKeys: String, CodingKey {
                    case eventId = "event_id"
                    case lastDay = "last_day"
                }
            }
            struct ChoiceCase: Decodable {
                let sessions: [SessionRow]
                let choices: [Garage.SwapChoice]
            }
            let events: [EventRow]
            let eventCases: [EventCase]
            let lastDays: [LastDay]
            let choiceCases: [ChoiceCase]
        }
        let data = try Data(contentsOf: RepoRoot.path("contracts/logic/garage-swap.json"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        for c in fixture.lastDays {
            let e = try #require(fixture.events.first { $0.id == c.eventId })
            #expect(Garage.eventLastDay(e) == c.lastDay, "event \(c.eventId)")
        }
        for c in fixture.eventCases {
            #expect(
                Garage.swapSessionEvent(c.vehicleId, c.date, fixture.events)?.id == c.eventId,
                "vehicle \(c.vehicleId) on \(c.date)"
            )
        }
        for c in fixture.choiceCases {
            #expect(Garage.swapSessionChoices(c.sessions) == c.choices)
        }
        #expect(fixture.eventCases.count >= 10)
        #expect(fixture.choiceCases.count >= 2)
    }
}
