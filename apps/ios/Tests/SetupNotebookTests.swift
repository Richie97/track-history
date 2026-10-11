import Foundation
import TrackEvolutionKit
import XCTest

@testable import TrackEvolution

/// The setup notebook's app-side decisions (NS-40): which days get a row, which
/// day the pressure loop compares against, how the cost lines read, and the
/// setup form's draft — typed text in the driver's units — round-tripping to
/// the stored sheet. The Kit's `SetupsTests` pins the logic under them to the
/// web; Android's `SetupFormModelTest` and `EventFormModelTest` carry the same
/// cases.
@MainActor
final class SetupNotebookTests: XCTestCase {

    /// An event row as `/events` sends it, with the fields these tests vary.
    private func event(
        id: Int = 1, startDate: String = "2026-06-01", days: Double = 2,
        costs: (entry: Int?, fuel: Int?, travel: Int?, misc: Int?) = (nil, nil, nil, nil)
    ) throws -> Event {
        let total = [costs.entry, costs.fuel, costs.travel, costs.misc].compactMap { $0 }
        let json: [String: Any?] = [
            "id": id, "track_id": 1, "track_name": "Summit Point", "start_date": startDate, "days": days,
            "lap_count": 0, "session_count": 0, "hours": 2.5, "updated_at": 0,
            "best_ms": nil, "best_time_ms": nil, "lap_best_ms": nil, "consistency": nil,
            "car": nil, "checklist": nil, "club": nil, "conditions": nil, "notes": nil, "run_group": nil,
            "temp_f": nil, "track_hours": nil, "vehicle_id": nil,
            "ambient_hi_c": nil, "ambient_lo_c": nil, "elevation_m": nil,
            "cost_entry_cents": costs.entry, "cost_fuel_cents": costs.fuel,
            "cost_travel_cents": costs.travel, "cost_misc_cents": costs.misc,
            "cost_cents": total.isEmpty ? nil : total.reduce(0, +),
        ]
        let data = try JSONSerialization.data(withJSONObject: json.mapValues { $0 ?? NSNull() })
        return try JSONDecoder().decode(Event.self, from: data)
    }

    private func sheet(_ build: (inout SetupSheet) -> Void) -> SetupSheet {
        var sheet = SetupSheet()
        build(&sheet)
        return sheet
    }

    // MARK: - Days and the loop's day

    func testEveryDayOfTheEventGetsARowAndAFractionalDayRoundsUp() throws {
        XCTAssertEqual(SetupNotebook.setupDays(try event(days: 2), []), [1, 2])
        XCTAssertEqual(SetupNotebook.setupDays(try event(days: 1.5), []), [1, 2])
        XCTAssertEqual(SetupNotebook.setupDays(try event(days: 0.5), []), [1])
        // A sheet logged past the event's days still gets its row.
        let late = Setup(day: 4, data: sheet { $0.fuel = 10 })
        XCTAssertEqual(SetupNotebook.setupDays(try event(days: 2), [late]), [1, 2, 4])
    }

    func testTheLoopComparesAgainstTheLatestDayWithColdPressures() {
        let cold = sheet { $0.tpCold = CornerValues(fl: 26) }
        let fuelOnly = sheet { $0.fuel = 10 }
        XCTAssertEqual(SetupNotebook.defaultLoopDay([1, 2, 3], [1: cold, 2: fuelOnly]), 1)
        XCTAssertEqual(SetupNotebook.defaultLoopDay([1, 2, 3], [2: fuelOnly]), 2)
        XCTAssertEqual(SetupNotebook.defaultLoopDay([1, 2], [:]), 1)
    }

    func testTheCollapsedCardSaysWhatIsInsideAsTheWebDoes() {
        XCTAssertEqual(SetupNotebook.summary(pro: false, sheetCount: 2), "Pro")
        XCTAssertEqual(SetupNotebook.summary(pro: true, sheetCount: 0), "pressures, alignment, dampers…")
        XCTAssertEqual(SetupNotebook.summary(pro: true, sheetCount: 1), "1 day sheet")
        XCTAssertEqual(SetupNotebook.summary(pro: true, sheetCount: 3), "3 day sheets")
    }

    // MARK: - Costs

    func testTheCostLinesNameOnlyWhatWasEntered() throws {
        XCTAssertNil(SetupNotebook.costBreakdown(try event()))
        XCTAssertEqual(
            SetupNotebook.costBreakdown(try event(costs: (49_500, 14_550, nil, 0))),
            "Entry fee $495 · Fuel $145.50 · Misc $0"
        )
    }

    func testATracksSpendCountsPastEventsAndSaysHowManyWereCosted() throws {
        let now = ISO8601DateFormatter().date(from: "2026-07-01T12:00:00Z")!
        let costed = try event(id: 1, startDate: "2026-05-01", costs: (45_000, 15_000, nil, nil))
        let uncosted = try event(id: 2, startDate: "2026-06-01")
        let upcoming = try event(id: 3, startDate: "2026-09-01", costs: (99_900, nil, nil, nil))
        XCTAssertNil(SetupNotebook.spentLine([uncosted, upcoming], now: now))
        XCTAssertEqual(SetupNotebook.spentLine([costed, upcoming], now: now), "$600 spent")
        XCTAssertEqual(SetupNotebook.spentLine([costed, uncosted, upcoming], now: now), "$600 spent (1 of 2 events costed)")
    }

    // MARK: - The setup form's draft

    func testAStoredSheetOpensAsTypedTextInTheDriversUnits() {
        let stored = sheet {
            $0.tpCold = CornerValues(fl: 29, fr: 29)
            $0.camber = AxleValues(f: -3.2)
            $0.tiresFId = 7
        }
        let metric = SetupFormModel.fields(from: stored, units: .metric)
        // 29 psi is 2.00 bar to the display unit's two places.
        XCTAssertEqual(metric["tp_cold.fl"], "2")
        XCTAssertEqual(metric["camber.f"], "-3.2")
        XCTAssertEqual(metric["tires_f_id"], "7")
        XCTAssertNil(metric["tp_cold.rl"])
        XCTAssertEqual(SetupFormModel.fields(from: stored, units: .imperial)["tp_cold.fl"], "29")
        XCTAssertEqual(SetupFormModel.fields(from: nil, units: .imperial), [:])
    }

    func testADraftSavesInStoredUnitsKeepingThePartReference() throws {
        let draft = ["tp_cold.fl": "1,9", "tires_f_id": "7", "notes": "  baseline ", "_hydrated": "1"]
        let built = try SetupFormModel.sheet(from: draft, units: .metric).get()
        // 1.9 bar × 14.503774 = 27.56 psi, two decimals as sanitizeSetup keeps.
        XCTAssertEqual(built.tpCold?.fl ?? 0, 27.56, accuracy: 1e-9)
        XCTAssertEqual(built.tiresFId, 7)
        XCTAssertEqual(built.notes, "baseline")
        XCTAssertNil(built.tpCold?.fr)
    }

    func testAFieldThatIsNotANumberIsRefusedNotDropped() {
        guard case .failure(let error) = SetupFormModel.sheet(from: ["camber.r": "two"], units: .imperial) else {
            return XCTFail("a non-number should not build a sheet")
        }
        XCTAssertEqual(error.message, "Couldn't read Camber R \"two\".")
    }

    func testANextDaySheetRoundTripsThroughTheDraft() throws {
        let start = sheet { $0.tpCold = CornerValues(fl: 25.5, fr: 26, rl: 25.5, rr: 26) }
        let draft = SetupFormModel.fields(from: start, units: .imperial)
        XCTAssertEqual(try SetupFormModel.sheet(from: draft, units: .imperial).get(), start)
    }

    // MARK: - Session notes

    func testASessionEditSendsOnlyWhatChanged() throws {
        let json = """
            {"id": 9, "label": "Session 1", "notes": "Brake later into T5.", "sort": 1,
             "laps": [], "trace": null, "channels": null, "ambient_c": null, "elevation_m": null}
            """
        let session = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        // A notes edit carries no label, so it can't clear one written elsewhere.
        let notesOnly = EventModel.sessionPatch(from: session, label: "Session 1 ", notes: "Brake at the 3 board")
        XCTAssertEqual(notesOnly, SessionPatch(notes: .set("Brake at the 3 board")))
        // An emptied field is an explicit null, which clears.
        XCTAssertEqual(
            EventModel.sessionPatch(from: session, label: "Session 1", notes: "  "),
            SessionPatch(notes: .set(nil))
        )
        XCTAssertTrue(EventModel.sessionPatch(from: session, label: "Session 1", notes: "Brake later into T5.").isEmpty)
    }

    func testTheRouteIsKeptOnTheEventsTabAndFollowsATempEvent() {
        let route = Route.setupForm(eventId: -3, day: 2, startFrom: nil)
        XCTAssertEqual(route.tab, .events)
        XCTAssertFalse(route.ownsTheWindow)
        let router = AppRouter(runsOnMac: false)
        router.push(.event(-3))
        router.push(route)
        router.hold("26", "tp_cold.fl", route)
        router.remapTempIds { $0 == -3 ? 41 : nil }
        let real = Route.setupForm(eventId: 41, day: 2, startFrom: nil)
        XCTAssertEqual(router.path, [.event(41), real])
        // The typed draft follows its route to the real id.
        XCTAssertEqual(router.heldText(real, "tp_cold.fl"), "26")
    }
}
