import Foundation
import Testing

@testable import TrackEvolutionKit

/// The garage's presentation logic, and its agreement with the web app.
///
/// The port carries the JS test cases with it (`test/unit/garage.test.js`), and
/// adds the cross-language fixture — `contracts/logic/garage-status.json`, run
/// through `public/js/garage.js` by `npm run contracts:logic` — because the
/// due/low thresholds are the kind of thing that drifts silently: a boundary an
/// hour out still looks entirely reasonable on screen.
struct GarageTests {
    // MARK: - Cross-language agreement

    @Test func matchesTheJavaScriptImplementationOnASharedFixture() throws {
        let fixture = try GarageFixture.load()

        for wearCase in fixture.cases {
            let status = Garage.partStatus(wearCase.wear)
            #expect(
                status?.rawValue == wearCase.status,
                "\(wearCase.name): status \(status?.rawValue ?? "nil") != \(wearCase.status ?? "nil")"
            )
            #expect(
                Garage.fmtRemaining(wearCase.wear) == wearCase.remaining,
                "\(wearCase.name): remaining phrasing differs"
            )
        }

        for hours in fixture.hours {
            #expect(Garage.fmtHours(hours.input) == hours.output, "fmtHours(\(hours.input ?? .nan))")
        }
        for cost in fixture.cost {
            #expect(Garage.fmtCost(cost.input) == cost.output, "fmtCost(\(cost.input.map(String.init) ?? "nil"))")
        }
        for kind in fixture.kinds {
            let ported = PartKind(rawValue: kind.kind)
            #expect(ported.label == kind.label)
            #expect(ported.wearLimitHint == kind.wearLimitHint)
        }
        // A guard against the fixture silently emptying out and the loops above
        // passing vacuously.
        #expect(fixture.cases.count >= 10)
        #expect(fixture.kinds.count == PartKind.all.count)
    }

    // MARK: - Status thresholds

    @Test func hasNoStatusWithoutAProjection() {
        #expect(Garage.partStatus(nil) == nil)
        #expect(Garage.partStatus(makeWear(remaining: nil)) == nil)
    }

    @Test func treatsAFullyUsedPartAsDueEvenWithHoursLeft() {
        // The measured fit and the expectation can disagree; the pessimistic one
        // wins, because "you have 1.5 h left" on a pad that's at its limit is the
        // one wrong answer that costs a rotor.
        #expect(Garage.partStatus(makeWear(remaining: 1.5, pctUsed: 1)) == .due)
    }

    @Test func drawsTheLowLineAtTwoTrackDays() {
        #expect(Garage.partStatus(makeWear(remaining: 4)) == .low)
        #expect(Garage.partStatus(makeWear(remaining: 4.01)) == .ok)
        #expect(Garage.partStatus(makeWear(remaining: 0)) == .due)
        #expect(Garage.partStatus(makeWear(remaining: -1)) == .due)
    }

    // MARK: - Formatting

    @Test func formatsHoursTheWayJavaScriptStringifiesThem() {
        #expect(Garage.fmtHours(nil) == "—")
        #expect(Garage.fmtHours(4) == "4 h")
        #expect(Garage.fmtHours(4.25) == "4.3 h")
        #expect(Garage.fmtHours(0.04) == "0 h")
    }

    @Test func namesTheRemainingLifeInTrackDays() {
        #expect(Garage.fmtRemaining(nil) == nil)
        #expect(Garage.fmtRemaining(makeWear(remaining: 0)) == "replace now")
        #expect(Garage.fmtRemaining(makeWear(remaining: 2)) == "~2 h left (≈1 track day)")
        #expect(Garage.fmtRemaining(makeWear(remaining: 3.4)) == "~3.4 h left (≈1.5 track days)")
        #expect(Garage.fmtRemaining(makeWear(remaining: 9.4)) == "~9.4 h left (≈5 track days)")
    }

    @Test func formatsCostWithCentsOnlyWhenThereAreAny() {
        #expect(Garage.fmtCost(nil) == nil)
        #expect(Garage.fmtCost(38900) == "$389")
        #expect(Garage.fmtCost(38950) == "$389.50")
        #expect(Garage.fmtCost(5) == "$0.05")
    }

    @Test func fallsBackToTheRawValueForAKindThisBuildHasNeverHeardOf() {
        // A kind added server-side must degrade to something readable rather than
        // rendering an empty chip. Same reason `PartKind` isn't an enum.
        let future = PartKind(rawValue: "clutch")
        #expect(future.label == "clutch")
        #expect(future.wearLimitHint == nil)
    }

    // MARK: - Alerts

    @Test func alertsOnlyOnActivePartsThatAreDueOrLow() {
        let garage = [
            makeVehicle(id: 1, name: "Corvette", parts: [
                makePart(id: 10, kind: .padsFront, remaining: 20),      // ok
                makePart(id: 11, kind: .tires, remaining: 1),           // low
                makePart(id: 12, kind: .oil, remaining: nil),           // no estimate
                makePart(id: 13, kind: .padsRear, remaining: 0, retiredOn: "2026-01-04")
            ])
        ]
        let alerts = Garage.garageAlerts(garage)
        #expect(alerts.map(\.part.id) == [11])
        #expect(alerts.first?.status == .low)
    }

    @Test func putsDueBeforeLowAndKeepsTheOriginalOrderWithin() {
        let garage = [
            makeVehicle(id: 1, name: "Corvette", parts: [
                makePart(id: 10, kind: .padsFront, remaining: 3),  // low
                makePart(id: 11, kind: .tires, remaining: 0)       // due
            ]),
            makeVehicle(id: 2, name: "Miata", parts: [
                makePart(id: 20, kind: .padsRear, remaining: -1),  // due
                makePart(id: 21, kind: .oil, remaining: 1)         // low
            ])
        ]
        let alerts = Garage.garageAlerts(garage)
        // Both due parts first, in the order the payload listed them, then both low.
        #expect(alerts.map(\.part.id) == [11, 20, 10, 21])
        #expect(alerts.map(\.vehicle.id) == [1, 2, 1, 2])
    }

    @Test func hasNothingToSayAboutAnEmptyGarage() {
        #expect(Garage.garageAlerts([]).isEmpty)
        #expect(Garage.garageAlerts([makeVehicle(id: 1, name: "Corvette", parts: [])]).isEmpty)
    }

    // MARK: - Fixtures

    private func makeWear(remaining: Double?, pctUsed: Double? = nil) -> WearEstimate {
        WearEstimate(
            hours: 0, events: 0, cycles: 0, expectedHours: nil, remainingHours: remaining,
            pctUsed: pctUsed, source: nil, wearPerHour: nil, lastValue: nil, unit: nil
        )
    }

    private func makePart(
        id: Int, kind: PartKind, remaining: Double?, retiredOn: String? = nil
    ) -> Part {
        Part(
            id: id, vehicleId: 1, kind: kind, name: "test", installedOn: "2026-01-01",
            retiredOn: retiredOn, expectedHours: nil, wearLimit: nil, costCents: nil, notes: nil,
            measurements: [], wear: makeWear(remaining: remaining)
        )
    }

    private func makeVehicle(id: Int, name: String, parts: [Part]) -> GarageVehicle {
        GarageVehicle(
            id: id, name: name, notes: nil, isDefault: false, updatedAt: 0,
            hours: 0, eventCount: 0, eventDays: 0, parts: parts
        )
    }
}

/// `contracts/logic/garage-status.json` — reference output captured from
/// `public/js/garage.js`.
struct GarageFixture: Decodable {
    struct WearCase: Decodable {
        let name: String
        let wear: WearEstimate
        /// Nil when the estimate has no basis — not a missing field.
        let status: String?
        let remaining: String?
    }

    struct HoursCase: Decodable {
        let input: Double?
        let output: String
    }

    struct CostCase: Decodable {
        let input: Int?
        let output: String?
    }

    struct KindCase: Decodable {
        let kind: String
        let label: String
        let wearLimitHint: String?
    }

    let cases: [WearCase]
    let hours: [HoursCase]
    let cost: [CostCase]
    let kinds: [KindCase]

    static func load() throws -> GarageFixture {
        let data = try Data(contentsOf: RepoRoot.path("contracts/logic/garage-status.json"))
        return try JSONDecoder().decode(GarageFixture.self, from: data)
    }
}
